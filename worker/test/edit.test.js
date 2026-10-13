import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished } from "vitest";
import worker from "../src/index.js";
import { validateChange } from "../src/api/contract.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
  expect((await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  const repo = fake.repos.get(name);
  repo.commits.unshift({ sha: "m1" }, { sha: "m0" });
  repo.files["src/a.js"] = "function one() {\n  return 1;\n}\nfunction two() {\n  return 2;\n}\n";
  const repoId = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
  for (const [sym, start, end] of [["one", 1, 3], ["two", 4, 6]]) {
    await env.DB.prepare("INSERT INTO symbols (repo_id, sha, path, name, kind, start_line, end_line) VALUES (?, 'm1', 'src/a.js', ?, 'function', ?, ?)")
      .bind(repoId, sym, start, end).run();
  }
  const edit = (body) => call(`/api/repos/${name}/changes/edit`, { method: "POST", body: JSON.stringify({
    target: "main", path: "src/a.js", intent: "Make two return 3", content: repo.files["src/a.js"].replace("return 2", "return 3"), ...body,
  }) });
  return { fake, call, repo, edit };
}

describe("in-browser edit", () => {
  it("an edit creates a person-authored change with a lease", async () => {
    const { call, edit } = await setup("edit-ok");
    const res = await edit({ base_sha: "m1" });
    expect(res.status).toBe(201);
    const change = await res.json();
    expect(change).toMatchObject({ state: "leased", intent: "Make two return 3", target_branch: "main" });
    const detail = await (await call(`/api/changes/${change.id}`)).json();
    expect(detail.events[0]).toMatchObject({ kind: "created", actor: { type: "human", id: "owner" } });
    const leases = await env.REPO_DO.get(env.REPO_DO.idFromName("edit-ok")).leases("main");
    expect(leases[change.id]).toEqual({ symbols: ["src/a.js#two"], granted: true });
    const job = await env.DB.prepare("SELECT kind, status, payload FROM jobs WHERE change_id = ?").bind(change.id).first();
    expect({ ...job, payload: JSON.parse(job.payload) }).toEqual({ kind: "commit", status: "queued", payload: {
      lease: ["src/a.js#two"], path: "src/a.js", base_sha: "m1",
      content: "function one() {\n  return 1;\n}\nfunction two() {\n  return 3;\n}\n",
    } });
  });

  it("after an edit, GET /api/changes/:id reports the commit job as pending", async () => {
    const { call, edit } = await setup("edit-pending");
    const change = await (await edit({ base_sha: "m1" })).json();
    const detail = await (await call(`/api/changes/${change.id}`)).json();
    expect(detail).toMatchObject({ head_sha: null, commit_job: { status: "queued", path: "src/a.js" } });
    expect(validateChange(detail).errors).toEqual([]);
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE change_id = ?").bind(change.id).run();
    expect((await (await call(`/api/changes/${change.id}`)).json()).commit_job).toBeNull();
  });

  it("an edit with change_id lands in that change's fork", async () => {
    const { call, fake, edit } = await setup("edit-ws");
    const change = await (await edit({ base_sha: "m1" })).json();
    const fork = fake.repos.get(change.fork);
    fork.commits.unshift({ sha: "f1" });
    fork.files["src/a.js"] = fork.files["src/a.js"].replace("return 2", "return 3");
    const content = fork.files["src/a.js"].replace("return 1", "return 4");
    const again = () => edit({ target: undefined, change_id: change.id, base_sha: "f1", content, intent: "Make one return 4" });
    expect(await (await again()).json()).toMatchObject({ error: { code: "not_driving" } });

    expect((await call(`/api/changes/${change.id}/takeover`, { method: "POST" })).status).toBe(200);
    const res = await again();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: change.id, driver: "owner" });
    const { results } = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'commit' ORDER BY rowid").bind(change.id).all();
    expect(JSON.parse(results.at(-1).payload)).toEqual({ lease: [], path: "src/a.js", base_sha: "f1", content });
    expect(fake.calls).toContainEqual({ method: "readFile", args: [change.fork, "f1", "src/a.js"] });
  });

  it("a stale base sha returns 409", async () => {
    const { repo, edit } = await setup("edit-stale");
    repo.at = { m0: { "src/a.js": "function one() {}\n" } };
    const res = await edit({ base_sha: "m0" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "stale_base" }, current_sha: "m1" });
    const { n } = await env.DB.prepare("SELECT count(*) AS n FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE r.name = 'edit-stale'").first();
    expect(n).toBe(0);

    // m0 is older, but the file is the same there, so the edit is not stale.
    repo.at = {};
    expect((await edit({ base_sha: "m0" })).status).toBe(201);
  });

  it("an edit on a held symbol returns the choices", async () => {
    const { edit } = await setup("edit-held");
    const holder = await (await edit({ base_sha: "m1" })).json();
    const res = await edit({ base_sha: "m1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "lease_held" }, holder: holder.id, choices: ["stack", "parallel", "send"] });
  });

  it("choice=stack creates a change stacked on the holder", async () => {
    const { edit } = await setup("edit-stack");
    const holder = await (await edit({ base_sha: "m1" })).json();
    const res = await edit({ base_sha: "m1", choice: "stack" });
    expect(res.status).toBe(201);
    const change = await res.json();
    expect(change).toMatchObject({ state: "waiting", stacked_on: holder.id });
    const job = await env.DB.prepare("SELECT kind, payload FROM jobs WHERE change_id = ?").bind(change.id).first();
    expect(job.kind).toBe("commit");
    expect(JSON.parse(job.payload).wait_for).toBe(holder.id);
  });
});
