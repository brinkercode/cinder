import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileResources, parseDeploy } from "../src/deploy.js";
import { checkDrift } from "../src/drift.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const manifest = (selfHeal) => `deploy:\n  environments:\n    - { name: production, branch: main, self_heal: ${selfHeal} }\n  worker: wrangler.jsonc\n  resources:\n    - { type: d1, name: pulse-db }\n`;

// A Cloudflare API fake: the live deployment runs `live`, databases in `dbs` exist, anything else 404s.
const fakeCloudflare = ({ live, dbs }) => vi.fn(async (url, init = {}) => {
  if (url.endsWith("/workers/scripts/pulse-production/deployments")) return Response.json({ result: { deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] } });
  if (init.method === "POST" && url.endsWith("/d1/database")) return Response.json({ result: { uuid: "db-new" } });
  const id = url.split("/d1/database/")[1];
  return dbs.includes(id) ? Response.json({ result: { uuid: id } }) : new Response("{}", { status: 404 });
});

describe("drift check", () => {
  let e;
  let sha;
  const setup = async (selfHeal) => {
    const fake = fakeArtifacts();
    await fake.create("drift-app");
    const repo = fake.repos.get("drift-app");
    repo.files[".cinder.yml"] = manifest(selfHeal);
    repo.files["wrangler.jsonc"] = JSON.stringify({ name: "pulse", main: "index.js" });
    sha = "a".repeat(40);
    e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct", PIPELINE: { create: vi.fn(async () => ({})) } };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES ('s1', 'drift-app', 'production', ?, 'v1', 'Synced', '[]', 'cinder-pipeline', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')").bind(sha),
      env.DB.prepare("INSERT INTO deploy_resources (repo, env, type, name, cf_id) VALUES ('drift-app', 'production', 'd1', 'pulse-db', 'db-1')"),
    ]);
  };
  const latest = () => env.DB.prepare("SELECT status, actor, reason FROM deploy_syncs LEFT JOIN deploy_sync_reasons ON sync_id = id WHERE repo = 'drift-app' ORDER BY started_at DESC LIMIT 1").first();

  beforeEach(async () => {
    await env.DB.batch(["deploy_sync_reasons", "deploy_sync_steps", "deploy_syncs", "deploy_resources"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("a version deployed outside cinder marks the environment OutOfSync with a reason", async () => {
    await setup(false);
    await checkDrift(e, fakeCloudflare({ live: "v-outside", dbs: ["db-1"] }));
    expect(await latest()).toEqual({ status: "OutOfSync", actor: "cinder-drift", reason: "live version v-outside at 100% is not the Synced v1" });
  });

  it("a missing D1 database is detected and recreated when self_heal is on", async () => {
    await setup(true);
    const cf = fakeCloudflare({ live: "v1", dbs: [] });
    await checkDrift(e, cf);
    expect(await latest()).toEqual({ status: "OutOfSync", actor: "cinder-drift", reason: "d1 pulse-db-production is missing" });
    expect(e.PIPELINE.create).toHaveBeenCalledTimes(1);
    const { params } = e.PIPELINE.create.mock.calls[0][0];
    expect(params).toMatchObject({ repo: "drift-app", branch: "main", sha, actor: "cinder-drift" });
    // The sync the heal starts reconciles resources: the database is created again and bound.
    const { bindings } = await reconcileResources(e, "drift-app", parseDeploy(manifest(true)), "production", {}, cf);
    expect(cf.mock.calls.at(-1)[1].method).toBe("POST");
    expect(bindings).toEqual([{ name: "PULSE_DB", type: "d1", id: "db-new" }]);
  });

  it("with self_heal off, nothing is changed", async () => {
    await setup(false);
    const cf = fakeCloudflare({ live: "v-outside", dbs: [] });
    await checkDrift(e, cf);
    expect((await latest()).status).toBe("OutOfSync");
    expect(e.PIPELINE.create).not.toHaveBeenCalled();
    expect(cf.mock.calls.every(([, init]) => (init.method ?? "GET") === "GET")).toBe(true);
    const { results } = await env.DB.prepare("SELECT cf_id FROM deploy_resources WHERE repo = 'drift-app'").all();
    expect(results).toEqual([{ cf_id: "db-1" }]);
  });
});
