import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateCompare } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const HEADS = { main: "m1", feat: "f1" };

async function setup(name) {
  const fake = fakeArtifacts();
  // The fake logs the same commits for every ref; give each branch its own head.
  const artifacts = { ...fake, async get(n) {
    const r = await fake.get(n);
    return r && { ...r, log: async ({ ref }) => (HEADS[ref] ? [{ hash: HEADS[ref] }] : []) };
  } };
  const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: artifacts });
  expect((await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) })).status).toBe(201);
  const { id, token: runner } = await (await call("/api/runners", { method: "POST", body: JSON.stringify({ name: `${name}-r`, kinds: ["compare"] }) })).json();
  // The runner holds the repo's queued compare job, as a claim would leave it.
  const put = async (body) => {
    await env.DB.prepare("UPDATE jobs SET status = 'claimed', runner_id = ?, lease_expires_at = ? WHERE kind = 'compare' AND status = 'queued' AND json_extract(payload, '$.store') = ?")
      .bind(id, new Date(Date.now() + 60000).toISOString(), name).run();
    return call(`/api/work/repos/${name}/compare/m1/f1`, { method: "PUT", headers: { Authorization: `Bearer ${runner}` }, body: JSON.stringify(body) });
  };
  const get = () => call(`/api/repos/${name}/compare?base=main&head=feat`);
  return { call, put, get };
}

const file = (i, lines) => ({ path: `f${i}.js`, status: "modified", additions: lines, deletions: 0, patch: "+x\n" });

describe("compare two refs", () => {
  it("comparing a branch with main lists its commits and changed files", async () => {
    const { call, put, get } = await setup("cmp-branch");
    const queued = await get();
    expect(queued.status).toBe(202);
    const pending = await queued.json();
    expect(validateCompare(pending)).toEqual({ ok: true, errors: [] });
    expect(pending).toEqual({ base: "main", head: "feat", base_sha: "m1", head_sha: "f1", diff: null });
    await get();
    const repoId = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind("cmp-branch").first()).id;
    const jobs = await env.DB.prepare("SELECT payload FROM jobs WHERE repo_id = ? AND kind = 'compare'").bind(repoId).all();
    expect(jobs.results).toEqual([{ payload: JSON.stringify({ store: "cmp-branch", base: "m1", head: "f1" }) }]);

    expect((await put({ ahead: 1, behind: 0, commits: [{ sha: "f1" }], files: [] })).status).toBe(400);
    const commits = [{ sha: "f1", message: "Add a" }];
    const files = [{ path: "a.js", status: "added", additions: 2, deletions: 0, patch: "+a\n+b\n" }];
    expect((await put({ ahead: 1, behind: 0, commits, files })).status).toBe(204);
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateCompare(body)).toEqual({ ok: true, errors: [] });
    expect(body.diff).toEqual({ ahead: 1, behind: 0, commits, files, truncated: false, stats: { files_changed: 1, additions: 2, deletions: 0 } });
    expect((await call("/api/repos/cmp-branch/compare?base=main&head=nope")).status).toBe(404);
    expect((await call("/api/repos/cmp-branch/compare?base=main")).status).toBe(400);
  });

  it("a huge diff comes back truncated with counts", async () => {
    const { put, get } = await setup("cmp-huge");
    const many = Array.from({ length: 250 }, (_, i) => file(i, 1));
    await get();
    expect((await put({ ahead: 1, behind: 0, commits: [], files: many })).status).toBe(204);
    let body = await (await get()).json();
    expect(validateCompare(body)).toEqual({ ok: true, errors: [] });
    expect(body.diff).toMatchObject({ truncated: true, stats: { files_changed: 250, additions: 250, deletions: 0 } });
    expect(body.diff.files).toHaveLength(200);

    const long = [file(0, 3000), file(1, 1500), file(2, 1000)];
    expect((await put({ ahead: 1, behind: 0, commits: [], files: long })).status).toBe(204);
    body = await (await get()).json();
    expect(body.diff).toMatchObject({ truncated: true, stats: { files_changed: 3, additions: 5500, deletions: 0 } });
    expect(body.diff.files.map((f) => f.path)).toEqual(["f0.js", "f1.js"]);
  });
});
