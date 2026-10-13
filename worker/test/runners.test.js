import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, inject, it } from "vitest";
import { validateClaim } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

it("worker+runner integration: one change goes from leased through verify to merged", async () => {
  const relay = inject("runnerRelay");
  const fake = fakeArtifacts({ remote: (name) => `${relay.root}/${name}.git` });
  const call = (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(new Request(`http://cinder.test${path}`,
    { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
  const git = (...args) => fetch(`${relay.url}/git`, { method: "POST", body: JSON.stringify(args) });
  const start = async (bin, kinds) => fetch(`${relay.url}/start`, { method: "POST",
    body: JSON.stringify({ bin, token: (await (await call("/api/runners", { name: bin, kinds })).json()).token }) });

  // The target: main with a check that passes only once the fake harness has written hello.txt.
  await git("init", "-q", "--bare", "-b", "main", "it-run.git");
  await git("clone", "-q", "it-run.git", "seed");
  await git("-C", "seed", "commit", "-q", "--allow-empty", "-m", "seed");
  await git("-C", "seed", "push", "-q", "origin", "HEAD:main");
  // Earlier test files leave jobs queued; only this change's jobs may be claimed.
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  expect((await call("/api/repos", { name: "it-run" })).status).toBe(201);
  fake.repos.get("it-run").files[".cinder.yml"] = "check: test -f hello.txt\n";
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("it-run")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call("/api/repos/it-run/changes", { intent: "say hello" })).json();
  await git("clone", "-q", "--bare", "it-run.git", `${change.fork}.git`);
  expect(change.state).toBe("leased");

  // Runners start as their job is queued: each claims at once instead of waiting out its empty-queue backoff.
  const starts = { leased: ["cinder-agent", ["develop"]], verifying: ["cinder-verify", ["verify"]], in_queue: ["cinder-agent", ["merge"]] };
  const seen = [];
  for (let state = change.state; state !== "merged";) {
    expect(Date.now() - Date.parse(change.created_at), `stuck in ${state}`).toBeLessThan(80000);
    // The fake Artifacts sends no push event, so the develop push's guard result is recorded here: clean, on the fork's head.
    if (state === "verifying" && starts.verifying) {
      const head = (await (await git("--git-dir", `${change.fork}.git`, "rev-parse", "main")).json()).trim();
      await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push",
        target: head, result: "ok" }, { head, guard: { status: "clear", sha: head, at: new Date().toISOString() } });
    }
    if (starts[state]) await start(...starts[state]);
    delete starts[state];
    const next = await fetch(`${relay.url}/next`);
    if (next.status === 204) {
      await new Promise((r) => setTimeout(r, 50));
    } else {
      const req = await next.json();
      const res = await call(req.path, req.body ? JSON.parse(req.body) : null, req.auth.slice(7), req.method);
      const text = await res.text();
      if (req.path === "/api/work/claim" && res.status === 200) expect(validateClaim(JSON.parse(text))).toEqual({ ok: true, errors: [] });
      if (req.path.endsWith("/report")) seen.push(JSON.parse(req.body).status);
      await fetch(`${relay.url}/reply/${req.id}`, { method: "POST", body: JSON.stringify({ status: res.status, text }) });
    }
    state = (await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).get()).state;
  }
  expect(seen).toEqual(["done", "done", "done"]);
  // The merge landed the harness's file on the target's main.
  expect(await (await git("--git-dir", "it-run.git", "show", "main:hello.txt")).json()).toBe("hello\n");
}, 90000);

const register = (body) => worker.fetch(new Request("http://cinder.test/api/runners", { method: "POST", body: JSON.stringify(body) }), env);
const poolToken = async (name) => {
  const owner = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`,
    { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), env);
  const pool = await (await owner("POST", "/api/workers/byo-pools", { name, labels: ["linux"] })).json();
  return (await (await owner("POST", `/api/workers/byo-pools/${pool.id}/tokens`)).json()).token;
};

it("refuses a pool token that already registered a worker", async () => {
  const pool_token = await poolToken("rn-once");
  expect((await register({ name: "rn-once-1", kinds: ["verify"], pool_token })).status).toBe(201);
  const again = await register({ name: "rn-once-2", kinds: ["verify"], pool_token });
  expect(again.status).toBe(401);
  expect((await again.json()).error.code).toBe("bad_pool_token");
  expect(await env.DB.prepare("SELECT count(*) AS n FROM runner_tokens WHERE name = 'rn-once-2'").first("n")).toBe(0);
});

it("refuses a BYO registration asking for the merge kind", async () => {
  const pool_token = await poolToken("rn-merge");
  for (const kinds of [["merge"], ["verify", "release"], ["history"]]) {
    const res = await register({ name: "rn-merge-1", kinds, pool_token });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  }
  expect(await env.DB.prepare("SELECT count(*) AS n FROM runner_tokens WHERE name = 'rn-merge-1'").first("n")).toBe(0);
  // The refusals didn't spend the token: an allowed kind still registers.
  expect((await register({ name: "rn-merge-2", kinds: ["verify"], pool_token })).status).toBe(201);
});
