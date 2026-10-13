import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateRepoSettings } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

// A repo on its own fake with main and dev, one commit each; send calls the API against it.
async function repo(name) {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake };
  const send = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), e);
  expect((await send("POST", "/api/repos", { name })).status).toBe(201);
  Object.assign(fake.repos.get(name), { commits: [{ sha: "c1" }], branches: ["main", "dev"] });
  const row = () => env.DB.prepare("SELECT id, default_branch, strategy FROM repos WHERE name = ?").bind(name).first();
  const audit = async () => (await env.DB.prepare("SELECT action, actor, detail FROM repo_audit WHERE repo_id = ?").bind((await row()).id).all()).results;
  return { fake, e, send, row, audit };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("repo settings read and write", () => {
  it("PUT …/settings with an unknown default_branch returns 400 and writes nothing", async () => {
    const { send, row, audit } = await repo("rs-unknown");
    const res = await send("PUT", "/api/repos/rs-unknown/settings", { default_branch: "nope", strategy: "custom", description: "changed" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("default_branch");
    expect(await row()).toMatchObject({ default_branch: "main", strategy: "trunk" });
    expect(await audit()).toEqual([]);
    expect((await (await send("GET", "/api/repos/rs-unknown/settings")).json()).description).toBe("");
  });

  it("PUT …/settings with a valid default_branch updates repos.default_branch and writes a repo_audit row", async () => {
    const { send, row, audit } = await repo("rs-branch");
    expect((await send("PUT", "/api/repos/rs-branch/settings", { default_branch: "dev" })).status).toBe(204);
    expect((await row()).default_branch).toBe("dev");
    expect(await audit()).toEqual([{ action: "default_branch", actor: "owner", detail: JSON.stringify({ from: "main", to: "dev" }) }]);
  });

  it("a contributor's PUT settings {default_branch} answers 403", async () => {
    const { fake, row } = await repo("rs-contrib");
    serveCerts();
    await env.DB.prepare("INSERT INTO person_roles VALUES ('contrib@settings.test', 'contributor')").run();
    const put = async (body) => (await worker.fetch(new Request("http://cinder.test/api/repos/rs-contrib/settings",
      { method: "PUT", headers: await as("contrib@settings.test"), body: JSON.stringify(body) }), { ...ACCESS, ARTIFACTS: fake })).status;
    expect(await put({ default_branch: "dev" })).toBe(403);
    expect(await row()).toMatchObject({ default_branch: "main" });
    expect(await put({ description: "still repo.write" })).toBe(204);
  });

  it("PUT …/settings {strategy: \"custom\"} saves, and \"other\" returns 400", async () => {
    const { send, row } = await repo("rs-strategy");
    expect((await send("PUT", "/api/repos/rs-strategy/settings", { strategy: "custom" })).status).toBe(204);
    expect((await row()).strategy).toBe("custom");
    expect((await send("PUT", "/api/repos/rs-strategy/settings", { strategy: "other" })).status).toBe(400);
    expect((await row()).strategy).toBe("custom");
  });

  it("GET …/settings returns every listed field", async () => {
    const { send } = await repo("rs-read");
    await send("PUT", "/api/repos/rs-read/settings", { language: "Go", mirror_url: "https://github.com/o/r.git", scans_paused: true });
    const settings = await (await send("GET", "/api/repos/rs-read/settings")).json();
    expect(settings).toEqual({
      description: "", language: "Go", default_branch: "main", strategy: "trunk", flake_quarantine: 0.2,
      mirror_url: "https://github.com/o/r.git", scans_paused: true, auto_quarantine: true, can_reimport: true, created_at: expect.any(String),
    });
    expect(validateRepoSettings(settings)).toEqual({ ok: true, errors: [] });
    expect((await send("GET", "/api/repos/rs-missing/settings")).status).toBe(404);
  });

  it("GET …/settings reports can_reimport false once any branch holds a file other than .cinder.yml", async () => {
    const { fake, send } = await repo("rs-reimport");
    const canReimport = async () => (await (await send("GET", "/api/repos/rs-reimport/settings")).json()).can_reimport;
    fake.repos.get("rs-reimport").files[".cinder.yml"] = "check: make test\n";
    expect(await canReimport()).toBe(true);
    fake.repos.get("rs-reimport").files["README.md"] = "hi\n";
    expect(await canReimport()).toBe(false);
  });
});

describe("repo delete", () => {
  it("a successful delete removes the repo's rows, webhooks and Artifacts repo, and leaves the audit row", async () => {
    const { fake, send, row } = await repo("rs-delete");
    const cf = fakeCloudflare();
    vi.stubGlobal("fetch", cf.fetch);
    const e = { ...env, ...cf.env, ARTIFACTS: fake };
    const call = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...e, ...cf.env });
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("rs-delete")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id } = await row();
    expect((await call("POST", "/api/repos/rs-delete/changes", { intent: "x" })).status).toBe(201);
    const hook = await (await call("POST", "/api/repos/rs-delete/webhooks", { url: "https://ci.example/hook", events: ["change"] })).json();
    await call("PUT", "/api/repos/rs-delete/people/rae%40example.com", { role: "viewer" });
    await send("PUT", "/api/repos/rs-delete/settings", { default_branch: "dev" });
    const keyed = async () => {
      const counts = await env.DB.batch(["repos WHERE id", "changes WHERE repo_id", "jobs WHERE repo_id", "webhooks WHERE repo_id", "repo_meta WHERE repo_id",
        "judge_config WHERE repo_id", "repo_roles WHERE repo_id", "repo_audit WHERE repo_id"]
        .map((q) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${q} = ?`).bind(id)));
      return counts.map((r) => r.results[0].n);
    };
    expect((await keyed()).every((n) => n > 0)).toBe(true);

    expect((await call("DELETE", "/api/repos/rs-delete", { confirm: "rs-delete" })).status).toBe(204);
    expect(await keyed()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await env.DB.prepare("SELECT 1 FROM webhook_secret_ids WHERE hook_id = ?").bind(hook.id).first()).toBeNull();
    expect([...cf.secrets.values()].some((s) => s.value === hook.secret)).toBe(false);
    expect(fake.repos.has("rs-delete")).toBe(false);
    expect(await env.DB.prepare("SELECT name, actor FROM repo_deletions WHERE name = 'rs-delete'").first()).toEqual({ name: "rs-delete", actor: "owner" });
  });
});
