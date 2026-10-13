import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateEnvironment } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { fakeArtifacts, refSha, withRefs } from "./fakes/artifacts.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";

const flow = (step) => `name: release
on: [manual]
steps:
  ship: { stage: deploy, deploy: production, ${step}, needs: [] }
`;
const AWS = flow('target: AWS, run: "aws ecs update-service --cluster c --service s", aws: { secret: AWS_ROLE, region: us-east-1, service: ecs, resource: c/s }');

// A repo with flow text at sha s1, a flow runner's token and a call helper as the owner (or as the runner with its token).
async function setup(name, text, files = {}) {
  const fake = fakeArtifacts();
  const cf = fakeCloudflare();
  vi.stubGlobal("fetch", withRefs(cf.fetch));
  const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake, ...cf.env },
  );
  await call("POST", "/api/repos", { name });
  Object.assign(fake.repos.get(name), { commits: [{ sha: refSha("s1") }], files: { ".cinder/flows/release.yml": text, ...files } });
  const { token } = await (await call("POST", "/api/runners", { name: `${name}-lab`, kinds: ["flow"] })).json();
  return { call, token };
}

describe("flow deploy targets outside Cloudflare", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("an ssh deploy step without key_secret is rejected naming the step", async () => {
    const { call } = await setup("tgt-ssh", flow('target: "Bring your own (SSH)", ssh: { host: web1.example.com, user: deploy, command: "systemctl restart app", fingerprint: "SHA256:abc" }'));
    const res = await call("POST", "/api/repos/tgt-ssh/flows/release/runs");
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("steps.ship.ssh.key_secret");
  });

  it("an aws deploy job reads its Keystore secret for the step's environment", async () => {
    const { call, token } = await setup("tgt-aws", AWS);
    expect((await call("POST", "/api/keystore", { name: "AWS_ROLE", kind: "environment_secret", scope: "environment", repo: "tgt-aws", environment: "production",
      owner: "ana@x.dev", value: "[default]\nrole_arn = arn:aws:iam::1:role/deploy" })).status).toBe(201);
    expect((await call("POST", "/api/repos/tgt-aws/flows/release/runs")).status).toBe(201);
    const { job, payload } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    expect(payload.environment).toBe("production");
    expect(await (await call("GET", `/api/work/jobs/${job.id}/secrets/AWS_ROLE`, null, token)).json()).toEqual({ value: "[default]\nrole_arn = arn:aws:iam::1:role/deploy" });
  });

  it("a finished external deploy records a deploy sync for its environment", async () => {
    const { call, token } = await setup("tgt-sync", AWS, { ".cinder.yml": "deploy:\n  environments:\n    - { name: production, branch: main, target: AWS }\n" });
    await call("POST", "/api/repos/tgt-sync/flows/release/runs");
    const { job } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "ship", status: "running" }, token)).status).toBe(204);
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "ship", status: "passed", logs: "deployed\n" }, token)).status).toBe(204);

    const [production] = await (await call("GET", "/api/repos/tgt-sync/environments")).json();
    expect(validateEnvironment(production).errors).toEqual([]);
    expect(production).toMatchObject({ status: "Synced", live_version: { version_id: refSha("s1"), sha: refSha("s1") }, target: "AWS" });
    expect(production.history.map((s) => [s.status, s.actor])).toEqual([["Synced", "flow:release"]]);
  });
});
