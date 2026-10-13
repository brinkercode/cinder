import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseFlow, validateFlow, validateService } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

// A repo whose main holds files; returns its services at ?ref (the default branch when unset).
async function services(name, files, query = "") {
  const fake = fakeArtifacts();
  const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
  expect((await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) })).status).toBe(201);
  const repo = fake.repos.get(name);
  repo.branches = ["main"];
  repo.commits.unshift({ sha: "m1" });
  Object.assign(repo.files, files);
  const res = await call(`/api/repos/${name}/services${query}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  for (const s of body.services) expect(validateService(s)).toEqual({ ok: true, errors: [] });
  return { body, repo, call };
}

const WRANGLER = `{
  // the app
  "name": "shop",
  "assets": { "directory": "./public" },
  "d1_databases": [{ "binding": "DB", "database_name": "shop-db", "database_id": "x" }],
}`;
const TF = `terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}
resource "cloudflare_workers_script" "api" {}
resource "cloudflare_r2_bucket" "media" {}
resource "random_id" "x" {}
`;

describe("services api", () => {
  it("a wrangler.jsonc with assets and a D1 binding is a worker service suggesting the script, assets and the database", async () => {
    const { body } = await services("svc-worker", { "wrangler.jsonc": WRANGLER, "src/index.js": "" });
    expect(body.ref).toBe("main");
    expect(body.services).toEqual([expect.objectContaining({
      id: "worker:.", name: "shop", kind: "worker", path: ".",
      resources: [{ type: "worker", name: "shop" }, { type: "assets", name: "./public" }, { type: "d1", name: "shop-db" }],
    })]);
  });

  it("a Dockerfile without a wrangler config is a container service suggesting a Container behind a Worker", async () => {
    const { body } = await services("svc-box", { "api/Dockerfile": "FROM scratch", "web/Dockerfile": "FROM scratch", "web/wrangler.toml": 'name = "web"\n' });
    expect(body.services.map((s) => [s.id, s.name, s.resources])).toEqual([
      ["container:api", "api", [{ type: "container", name: "api" }, { type: "worker", name: "api" }]],
      ["worker:web", "web", [{ type: "worker", name: "web" }]],
    ]);
  });

  it("Terraform with the cloudflare provider is a terraform service listing its cloudflare resources", async () => {
    const { body } = await services("svc-tf", { "infra/main.tf": TF, "other/main.tf": 'resource "aws_s3_bucket" "b" {}' });
    expect(body.services.map((s) => [s.id, s.kind, s.path, s.resources])).toEqual([
      ["terraform:infra", "terraform", "infra", [{ type: "cloudflare_workers_script", name: "api" }, { type: "cloudflare_r2_bucket", name: "media" }]],
    ]);
  });

  it("a service keeps its id across commits that leave its kind and path alone", async () => {
    const { body, repo, call } = await services("svc-ids", { "wrangler.jsonc": WRANGLER, "infra/main.tf": TF });
    const m2 = "b".repeat(40);
    repo.commits.unshift({ sha: m2 });
    repo.at = { [m2]: { "wrangler.jsonc": WRANGLER.replace('"shop"', '"store"'), "infra/main.tf": `${TF}resource "cloudflare_d1_database" "db" {}\n`, "README.md": "" } };
    const later = await (await call(`/api/repos/svc-ids/services?ref=main&sha=${m2}`)).json();
    expect(later.sha).toBe(m2);
    expect(body.services.map((s) => s.id)).toEqual(["worker:.", "terraform:infra"]);
    expect(later.services.map((s) => s.id)).toEqual(body.services.map((s) => s.id));
    expect(later.services[0].name).toBe("store");
  });

  it("every generated flow passes validateFlow and runs no deploy, apply or push step", async () => {
    const { body } = await services("svc-flows", { "wrangler.json": '{"name":"a"}', "box/Dockerfile": "FROM scratch", "infra/main.tf": TF });
    expect(body.services.map((s) => s.kind)).toEqual(["worker", "container", "terraform"]);
    for (const s of body.services) {
      const f = parseFlow(s.flow.yaml);
      expect(validateFlow(f), s.id).toEqual({ ok: true, errors: [] });
      for (const step of f.steps) {
        expect(step.deploy || step.uses || step.approval, s.id).toBeFalsy();
        expect(step.run).not.toMatch(/terraform apply|docker push|wrangler deploy(?! --dry-run)/);
      }
    }
    const runs = body.services.map((s) => parseFlow(s.flow.yaml).steps.map((x) => x.run));
    expect(runs).toEqual([
      ["npm ci", "npx wrangler deploy --dry-run --outdir dist"],
      ["cd 'box' && docker build ."],
      ["cd 'infra' && terraform init -backend=false", "cd 'infra' && terraform plan -refresh=false -input=false"],
    ]);
  });
});
