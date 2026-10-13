import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { validateRepairRound } from "../src/api/shapes.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A change (developed by `agent` when given) whose develop job reported done: it waits in verifying with a verify job queued.
async function setup(name, agent, commit) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x", ...(agent && { agent_version: agent }) })).json();
  // Earlier tests leave jobs queued on other repos; only this change's jobs stay claimable.
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed') AND change_id <> ?").bind(change.id).run();
  // The agent's pushed commit on its fork, which no push event has reported yet.
  if (commit) Object.assign(fake.repos.get(change.fork), { branches: ["main"], commits: [{ sha: commit }] });
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop", "verify"] })).json()).token;
  const claim = async (kind) => (await (await call("/api/work/claim", { kinds: [kind] }, runner)).json()).job.id;
  const report = async (id, body) => (await (await call(`/api/work/jobs/${id}/report`, body, runner)).json()).change;
  expect((await report(await claim("develop"), { status: "done" })).state).toBe("verifying");
  const failVerify = async (detail) => report(await claim("verify"), { status: "failed", detail });
  const developJobs = async () => (await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'develop' AND status = 'queued'")
    .bind(change.id).all()).results.map((r) => JSON.parse(r.payload));
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  return { call, change, claim, report, failVerify, developJobs, stub, fake };
}

describe("repair", () => {
  it("a failed verify on an agent change queues a develop job carrying the failing log as repair 1 of 2", async () => {
    const { change, failVerify, developJobs, stub } = await setup("repair-verify");
    const after = await failVerify("FAIL src/a.test.js: expected 2, got 3");
    expect(after).toMatchObject({ state: "needs_fix", repair: { round: 1, max: 2 } });
    expect(await developJobs()).toEqual([{ repair: 1, max: 2, failure: "FAIL src/a.test.js: expected 2, got 3" }]);
    expect((await stub.get()).events.at(-1)).toMatchObject({ kind: "repair_started", round: 1, max: 2, check: "verify" });
    const card = await (await worker.fetch(new Request("http://cinder.test/api/repos/repair-verify/changes", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env)).json();
    expect(card.find((c) => c.id === change.id).repair).toEqual({ round: 1, max: 2, check: "verify" });
  });

  it("request changes on an agent change queues a repair with the review threads", async () => {
    const { call, change, developJobs, stub } = await setup("repair-review");
    expect((await call(`/api/changes/${change.id}/threads`, { path: "src/a.js", side: "old", line: 3, body: "keep this guard" })).status).toBe(201);
    expect((await call(`/api/changes/${change.id}/review`, { verdict: "request_changes", body: "split the helper" })).status).toBe(200);
    expect(await developJobs()).toEqual([{ repair: 1, max: 2, failure: "src/a.js:3: keep this guard\n\nsplit the helper" }]);
    expect((await stub.get()).events.find((e) => e.kind === "repair_started")).toMatchObject({ round: 1, max: 2, check: "review" });
  });

  it("a third failure after two repairs fails the change with repairs exhausted and queues nothing", async () => {
    const { claim, report, failVerify, developJobs, stub } = await setup("repair-exhausted");
    for (const n of [1, 2]) {
      expect((await failVerify(`fail ${n}`)).repair).toEqual({ round: n, max: 2, check: "verify" });
      expect((await report(await claim("develop"), { status: "done" })).state).toBe("verifying");
    }
    const failed = await failVerify("fail 3");
    expect(failed.state).toBe("failed");
    expect((await stub.get()).events.at(-1)).toMatchObject({ kind: "repairs_exhausted", reason: "repairs exhausted (2 of 2): fail 3" });
    expect(await developJobs()).toEqual([]);
  });

  it("an agent's develop report makes the fork's head the change's head before its push event, so the verify verdict is for that head", async () => {
    const { change, claim, report, stub, fake } = await setup("verdict-head", undefined, "t1");
    const fork = (await stub.get()).fork;
    const head = (await (await fake.get(fork)).log({ ref: change.target_branch, limit: 1 }))[0].sha;
    expect((await stub.get()).head).toBe(head);
    await report(await claim("verify"), { status: "done" });
    expect((await stub.get()).verdict).toMatchObject({ sha: head, status: "pass" });
  });

  it("a race leg's repair runs on the agent its develop job named, since the change records no agent_version", async () => {
    const { change, failVerify, developJobs } = await setup("repair-leg");
    await env.DB.prepare("UPDATE jobs SET payload = json_set(payload, '$.agent', 'dev-open@v1') WHERE change_id = ? AND kind = 'develop'").bind(change.id).run();
    await failVerify("fail");
    expect(await developJobs()).toEqual([{ repair: 1, max: 2, failure: "fail", agent: "dev-open@v1" }]);
  });

  it("a verify that can't merge onto a moved target converges the change instead of queueing a repair", async () => {
    const { change, failVerify, developJobs, stub } = await setup("verify-conflict");
    const after = await failVerify("##[group]Fetch change\nAuto-merging src/index.js\nCONFLICT (content): Merge conflict in src/index.js\nAutomatic merge failed");
    expect(after.state).toBe("converging");
    expect(await developJobs()).toEqual([]);
    const converge = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'converge' AND status = 'queued'").bind(change.id).first("payload");
    expect(JSON.parse(converge)).toMatchObject({ return_to: "verifying" });
    expect((await stub.get()).events.some((e) => e.kind === "repair_started")).toBe(false);
  });

  it("max_repairs from the agent's lock overrides the default of 2", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES ('agent/fixer/v1', 'fixer', 1, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{\"max_repairs\":3}')").run();
    const { claim, report, failVerify, developJobs } = await setup("repair-lock", "fixer@v1");
    for (const n of [1, 2]) {
      await failVerify(`fail ${n}`);
      await report(await claim("develop"), { status: "done" });
    }
    expect((await failVerify("fail 3")).state).toBe("needs_fix");
    // The repair runs on the change's own version, not the harness default.
    expect(await developJobs()).toEqual([{ repair: 3, max: 3, failure: "fail 3", agent: "fixer@v1" }]);
  });

  it("GET repairs lists one round per repair in order with what the agent did, the verifier result and the tokens", async () => {
    const { change, claim, report, failVerify } = await setup("repair-rounds");
    await failVerify("fail 1");
    await env.DB.prepare("INSERT INTO usage_logs VALUES ('u-r1', 'r', ?, ?, null, null, 120, 0.01)").bind(new Date().toISOString(), change.id).run();
    await report(await claim("develop"), { status: "done" });
    await failVerify("fail 2");
    const res = await worker.fetch(new Request(`http://cinder.test/api/changes/${change.id}/repairs`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    const rounds = await res.json();
    expect(rounds.map((r) => ({ ...r, at: undefined }))).toEqual([
      { round: 1, check: "verify", did: "pushed a fix", result: "fail", reason: "fail 2", tokens: 120 },
      { round: 2, check: "verify", did: null, result: null, reason: null, tokens: 0 },
    ]);
    for (const r of rounds) expect(validateRepairRound(r).errors).toEqual([]);
  });

  it("a person-driven change in needs_fix queues no job", async () => {
    const { failVerify, developJobs, stub } = await setup("repair-person");
    await stub.setDriver("ann@example.com");
    const after = await failVerify("FAIL");
    expect(after.state).toBe("needs_fix");
    expect(after.repair).toBeUndefined();
    expect(await developJobs()).toEqual([]);
  });
});
