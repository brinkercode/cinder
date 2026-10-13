import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, init = {}, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } }), { ...env, ARTIFACTS: fake });
  const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });
  expect((await post("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await post(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const fork = fake.repos.get(change.fork);
  fork.commits.unshift({ sha: "h1" }, { sha: "b1" });
  const lines = (n, at, text) => Array.from({ length: n }, (_, i) => (i === at ? text : `line ${i + 1}`)).join("\n") + "\n";
  fork.at = { b1: { "a.js": lines(20, -1), "gone.md": "old\n" }, h1: { "a.js": lines(20, 9, "changed"), "new.md": "n\n" } };
  const { id: runnerId, token } = await (await post("/api/runners", { name: `${name}-runner`, kinds: ["review"] })).json();
  const job = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload, runner_id, lease_expires_at)
    VALUES (?, ?, 'review', ?, 'claimed', ?, ?, ?, ?)`).bind(job, change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ base: "b1" }),
    runnerId, new Date(Date.now() + 60000).toISOString()).run();
  return { call, job, token };
}

it("a runner holding a review job gets its change's diff from the server", async () => {
  const { call, job, token } = await setup("review-diff");
  const res = await call(`/api/work/jobs/${job}/diff`, {}, token);
  expect(res.status).toBe(200);
  expect((await res.json()).diff).toBe(`diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -7,7 +7,7 @@
 line 7
 line 8
 line 9
-line 10
+changed
 line 11
 line 12
 line 13
diff --git a/gone.md b/gone.md
--- a/gone.md
+++ /dev/null
@@ -1,1 +0,0 @@
-old
diff --git a/new.md b/new.md
--- /dev/null
+++ b/new.md
@@ -0,0 +1,1 @@
+n
`);
});

it("a runner without that job gets 403", async () => {
  const { call, job } = await setup("review-diff-other");
  const { token: other } = await (await call("/api/runners", { method: "POST", body: JSON.stringify({ name: "review-diff-stranger", kinds: ["review"] }) })).json();
  expect((await call(`/api/work/jobs/${job}/diff`, {}, other)).status).toBe(403);
});
