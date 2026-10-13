import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { mergeBlockers } from "../src/queue.js";
import { judgeRisk, riskState, routeChange } from "../src/risk.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, init = {}) =>
  worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: OWNER }), { ...env, ARTIFACTS: fakeArtifacts() });

async function repoId(name) {
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) });
  return (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
}

// A released, stable reviewer agent for fn's duration; other tests run with none.
async function withReviewer(fn) {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES ('agent/reviewer/v1', 'reviewer', 1, 'opencode', 'm', 'default', 'sha256:0', '[]', '{}')"),
    env.DB.prepare("INSERT OR REPLACE INTO channels (agent_name, channel, version) VALUES ('reviewer', 'stable', 1)"),
  ]);
  try {
    return await fn();
  } finally {
    await env.DB.batch([env.DB.prepare("DELETE FROM channels WHERE agent_name = 'reviewer'"), env.DB.prepare("DELETE FROM agent_versions WHERE id = 'agent/reviewer/v1'")]);
  }
}

const input = {
  files: [{ path: "src/a.js", added: 10, removed: 2 }, { path: "src/b.js", added: 3, removed: 0 }],
  intent: "Add retries to the fetcher",
  test_delta: { added: 2, removed: 0 },
  lease_overlaps: [{ change: "c1", symbol: "fetch", at: "2026-10-01T00:00:00.000Z" }],
};

describe("risk", () => {
  it("state builder includes every input", async () => {
    const repo = await repoId("risk-state");
    await env.DB.prepare("INSERT INTO owners (repo, path, owner, weight) VALUES (?1, 'src/a.js', 'ana', 0.9), (?1, 'src/c.js', 'bo', 1)").bind(repo).run();
    expect(await riskState(env.DB, repo, input)).toEqual({
      diff: { files: 2, added: 13, removed: 2 },
      paths: ["src/a.js", "src/b.js"],
      owners: [{ path: "src/a.js", owner: "ana", weight: 0.9 }],
      test_delta: { added: 2, removed: 0 },
      intent: "Add retries to the fetcher",
      lease_overlaps: input.lease_overlaps,
    });
  });

  it("judgment recorded", async () => {
    const repo = await repoId("risk-judge");
    await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'risk', 'clef', 'clef@1')").bind(repo).run();
    const sent = [];
    const AI = fakeClefAI(async (model, body) => (sent.push(body), { risk: { low: 0.1, medium: 0.2, high: 0.7 } }));
    expect(await judgeRisk({ ...env, AI }, repo, input)).toEqual({ risk: { answer: "high", p: 0.7, trusted: false } });
    expect(sent[0].state).toEqual(await riskState(env.DB, repo, input));
    expect(sent[0].questions.risk.options).toEqual(["low", "medium", "high"]);
    const list = (await env.DB.prepare("SELECT j.* FROM judgments j JOIN repos r ON r.id = j.repo_id WHERE r.name = ? AND j.kind = ? ORDER BY j.made_at").bind("risk-judge", "risk").all()).results;
    expect(list.map((j) => [j.kind, j.answer, j.probability])).toEqual([["risk", "high", 0.7]]);
  });

  async function routed(name, answers, state) {
    const repo = await repoId(name);
    await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'risk', 'clef', 'clef@1')").bind(repo).run();
    const id = crypto.randomUUID();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.create({ id, repo_id: repo, target_branch: "main", state: "planned", created_at: new Date().toISOString() }, []);
    // A real change's row, which its risk judgment references.
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', '')").bind(id, repo).run();
    // Only planned is a legal created state; later states are seeded straight into storage.
    await runInDurableObject(stub, async (i) => i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state }));
    const AI = fakeClefAI(async () => ({ risk: answers }));
    return { id, stub, review: await routeChange({ ...env, AI }, repo, id, input) };
  }

  const untrustedNeed = (id) => env.DB.prepare("SELECT 1 FROM needs WHERE kind = 'Untrusted judge' AND change_id = ?").bind(id).first();

  it("an untrusted risk judge routes the change to the reviewer agent, not a person", async () => {
    const { id, review } = await withReviewer(() => routed("risk-route-low", { low: 0.9, medium: 0.05, high: 0.05 }, "planned"));
    expect(review).toEqual({ route: "agent", reason: "risk low, judge not yet trusted", p: 0.9, trusted: false });
    expect((await (await call(`/api/changes/${id}`)).json()).review).toEqual({ ...review, requested: [] });
    expect(await untrustedNeed(id)).toBeNull();
  });

  it("an untrusted high answer also goes to the reviewer agent", async () => {
    const { review } = await withReviewer(() => routed("risk-route-untrusted-high", { low: 0.05, medium: 0.05, high: 0.9 }, "planned"));
    expect(review).toMatchObject({ route: "agent", reason: "risk high, judge not yet trusted" });
  });

  it("an untrusted judge with no reviewer agent still asks a person", async () => {
    const { id, review } = await routed("risk-route-noreviewer", { low: 0.9, medium: 0.05, high: 0.05 }, "planned");
    expect(review).toMatchObject({ route: "human", reason: "no reviewer agent, risk low, judge not yet trusted" });
    expect(await untrustedNeed(id)).not.toBeNull();
  });

  const queued = (id) => ({ kind: "queued", actor: { type: "system", id: "cinder" }, action: "stage.decide", target: id, result: "ok" });

  it("human route blocks until an approving review", async () => {
    const { id, stub, review } = await routed("risk-route-high", { low: 0.1, medium: 0.1, high: 0.8 }, "verifying");
    // Approval reads the target branch's rule before queueing.
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("risk-route-high")), (i) => { i.env = { ...i.env, ARTIFACTS: fakeArtifacts() }; });
    expect(review.route).toBe("human");
    await stub.stageEvent({ kind: "verify_done", actor: { type: "system", id: "test" }, action: "job.report", target: id, result: "ok" },
      { head: "h1", verdict: { sha: "h1", status: "pass", at: new Date().toISOString() } });
    expect(await stub.transition("in_queue", queued(id))).toBeNull();
    expect((await stub.get()).state).toBe("verifying");
    const res = await call(`/api/changes/${id}/review`, { method: "POST", body: JSON.stringify({ verdict: "approve" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).approvals).toEqual([{ actor: { type: "human", id: "owner" }, head_sha: "h1", at: expect.any(String) }]);
    expect((await stub.get()).state).toBe("in_queue");
  });
});

it("a touched path matching the rule's route goes to a person whatever the risk", async () => {
  const repo = await repoId("risk-route-path");
  const id = crypto.randomUUID();
  await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).create({ id, repo_id: repo, target_branch: "main", state: "planned", created_at: new Date().toISOString() }, []);
  const rule = { queue: true, judges: 1, risk: 10, route: ["db/*", "src/b.js"] };
  expect(await routeChange(env, repo, id, input, rule)).toMatchObject({ route: "human", reason: "touches src/b.js" });
});

it("airlock is reflected in readiness immediately: an airlocked risk judge's next verdict no longer auto-merges", async () => {
  const repo = await repoId("risk-judge-airlock");
  const put = (path, body) => call(`/api/repos/risk-judge-airlock/judges/risk${path}`, { method: "PUT", body: JSON.stringify(body) });
  expect((await put("", { backend: "clef", model_version: "clef@1", min_outcomes: 1 })).status).toBe(200);
  const scored = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO judgments (id, repo_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, 'risk', 'clef', 'clef@1', 's', 'q', 'low', 0.9, '')").bind(scored, repo).run();
  await env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) VALUES (?, 'low', 1, '')").bind(scored).run();
  const AI = fakeClefAI(async () => ({ risk: { low: 0.9, medium: 0.05, high: 0.05 } }));
  const route = async () => {
    const id = crypto.randomUUID();
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).create({ id, repo_id: repo, target_branch: "main", state: "planned", created_at: new Date().toISOString() }, []);
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', '')").bind(id, repo).run();
    return (await routeChange({ ...env, AI }, repo, id, input)).reason;
  };
  expect(await route()).toBe("risk low, judge trusted");
  const on = await put("/airlock", { on: true });
  expect(await on.json()).toEqual({ kind: "risk", airlock: true, min_outcomes: 1, min_confidence: null });
  expect(await route()).toBe("no reviewer agent, risk low, judge not yet trusted");
  expect((await put("/airlock", { on: "yes" })).status).toBe(400);
  expect((await call("/api/repos/risk-judge-airlock/judges/route/airlock", { method: "PUT", body: JSON.stringify({ on: true }) })).status).toBe(404);
});

it("a trusted agent route with no released reviewer agent goes to a person", async () => {
  const repo = await repoId("risk-no-reviewer");
  await call("/api/repos/risk-no-reviewer/judges/risk", { method: "PUT", body: JSON.stringify({ backend: "clef", model_version: "clef@1", min_outcomes: 1 }) });
  const scored = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO judgments (id, repo_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, 'risk', 'clef', 'clef@1', 's', 'q', 'low', 0.9, '')").bind(scored, repo).run();
  await env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) VALUES (?, 'low', 1, '')").bind(scored).run();
  const id = crypto.randomUUID();
  await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).create({ id, repo_id: repo, target_branch: "main", state: "planned", created_at: new Date().toISOString() }, []);
  await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', '')").bind(id, repo).run();
  const AI = fakeClefAI(async () => ({ risk: { low: 0.05, medium: 0.9, high: 0.05 } }));
  expect(await routeChange({ ...env, AI }, repo, id, input)).toMatchObject({ route: "human", reason: "no reviewer agent, risk medium", trusted: true });
});

it("a high-risk trusted answer still routes to a person", async () => {
  const repo = await repoId("risk-trusted-high");
  await call("/api/repos/risk-trusted-high/judges/risk", { method: "PUT", body: JSON.stringify({ backend: "clef", model_version: "clef@1", min_outcomes: 1 }) });
  const scored = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO judgments (id, repo_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, 'risk', 'clef', 'clef@1', 's', 'q', 'low', 0.9, '')").bind(scored, repo).run();
  await env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) VALUES (?, 'low', 1, '')").bind(scored).run();
  const id = crypto.randomUUID();
  await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).create({ id, repo_id: repo, target_branch: "main", state: "planned", created_at: new Date().toISOString() }, []);
  await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', '')").bind(id, repo).run();
  const AI = fakeClefAI(async () => ({ risk: { low: 0.05, medium: 0.05, high: 0.9 } }));
  expect(await routeChange({ ...env, AI }, repo, id, input)).toMatchObject({ route: "human", reason: "risk high", trusted: true });
});

it("a repo policy requiring a human approval still requires it", async () => {
  const repo = await repoId("risk-policy-human");
  await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'risk', 'clef', 'clef@1')").bind(repo).run();
  await withReviewer(async () => {
    const id = crypto.randomUUID();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.create({ id, repo_id: repo, target_branch: "main", state: "planned", created_at: new Date().toISOString() }, []);
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', '')").bind(id, repo).run();
    const AI = fakeClefAI(async () => ({ risk: { low: 0.9, medium: 0.05, high: 0.05 } }));
    const rule = { queue: true, judges: 1, risk: 10, route: ["src/b.js"] };
    expect(await routeChange({ ...env, AI }, repo, id, input, rule)).toMatchObject({ route: "human", reason: "touches src/b.js", trusted: false });
    expect((await mergeBlockers(env, await stub.get())).map((b) => b.code)).toContain("approval_missing");
  });
});

describe("comment- and documentation-only routing", () => {
  // A trusted judge answering high, which alone would hold the change for a person.
  async function routeTrustedHigh(name, diff) {
    const repo = await repoId(name);
    await call(`/api/repos/${name}/judges/risk`, { method: "PUT", body: JSON.stringify({ backend: "clef", model_version: "clef@1", min_outcomes: 1 }) });
    const scored = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO judgments (id, repo_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, 'risk', 'clef', 'clef@1', 's', 'q', 'low', 0.9, '')").bind(scored, repo).run();
    await env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) VALUES (?, 'low', 1, '')").bind(scored).run();
    const id = crypto.randomUUID();
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).create({ id, repo_id: repo, target_branch: "main", state: "planned", created_at: new Date().toISOString() }, []);
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', '')").bind(id, repo).run();
    const AI = fakeClefAI(async () => ({ risk: { low: 0.05, medium: 0.05, high: 0.9 } }));
    return routeChange({ ...env, AI }, repo, id, { ...input, files: diff.map((f) => ({ path: f.path, added: 0, removed: 0 })), diff });
  }

  it("a change whose diff only edits comments is routed without human review as a comment-only change", async () => {
    const diff = [
      { path: "src/a.js", status: "modified", lines: [" const a = 1;", "-// old note", "+// new note", "+", "+/* block note */"] },
      { path: "run.py", status: "modified", lines: [" x = 1", "+# why x is 1"] },
      { path: "db/q.sql", status: "modified", lines: ["+-- index hint"] },
      { path: "index.html", status: "modified", lines: ["+<!-- banner -->"] },
      { path: "README.md", status: "modified", lines: ["+anything"] },
    ];
    expect(await routeTrustedHigh("risk-comment-only", diff)).toMatchObject({ route: "auto", reason: "comment-only change" });
  });

  it("a change that edits one code line next to comments keeps the risk judge's route", async () => {
    const diff = [{ path: "src/a.js", status: "modified", lines: ["+// new note", "-const a = 1;", "+const a = 2;"] }];
    expect(await routeTrustedHigh("risk-comment-code", diff)).toMatchObject({ route: "human", reason: "risk high" });
  });

  it("code hidden on a comment-looking line keeps the risk judge's route", async () => {
    for (const line of ["+  * evil()", "+/* a */ evil(); /* b */", "+/* note */ evil()"]) {
      const diff = [{ path: "src/a.js", status: "modified", lines: ["+// note", line] }];
      expect(await routeTrustedHigh(`risk-hidden-${line.length}`, diff), line).toMatchObject({ route: "human", reason: "risk high" });
    }
  });

  it("a documentation-only change is routed as documentation-only", async () => {
    const diff = [
      { path: "docs/usage/changes.md", status: "modified", lines: ["-old", "+new"] },
      { path: "docs/guide.mdx", status: "added", lines: ["+# Guide"] },
      { path: "NOTES.txt", status: "added", lines: ["+note"] },
    ];
    expect(await routeTrustedHigh("risk-docs-only", diff)).toMatchObject({ route: "auto", reason: "documentation-only change" });
  });
});
