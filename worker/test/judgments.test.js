import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { validateJudge, validateJudges } from "../src/api/contract.js";
import worker from "../src/index.js";
import { calibrate } from "../src/calibration.js";
import { CLEF_MODELS } from "../src/s1/client.js";
import { binding } from "../src/keystore.js";
import { refreshPolicy } from "../src/policy.js";
import { judge, recordJudgment, recordOutcome, recordRiskOutcome, recordVerdict } from "../src/judgments.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, init = {}) =>
  worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: OWNER }), { ...env, ARTIFACTS: fakeArtifacts() });

async function repoId(name) {
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) });
  return (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
}

// A repo's judgments (of kind, when given) with their outcome's actual and correct (null while open).
const judgmentsOf = async (name, kind = null) => (await env.DB.prepare("SELECT j.*, o.actual, o.correct FROM judgments j JOIN repos r ON r.id = j.repo_id " +
  "LEFT JOIN outcomes o ON o.judgment_id = j.id WHERE r.name = ?1 AND (?2 IS NULL OR j.kind = ?2) ORDER BY j.made_at, j.id").bind(name, kind).all()).results;

const judgment = (repo, kind) => ({
  repo, kind, backend: "stat", model: "stat-1", state_hash: "sha256:01", question: "touches outside lease?", answer: "no", p: 0.8,
});

describe("judgments and outcomes", () => {
  it("outcome links to its judgment", async () => {
    const repo = await repoId("jdg-link");
    const id = await recordJudgment(env.DB, judgment(repo, "lease"));
    const open = await recordJudgment(env.DB, judgment(repo, "lease"));
    await recordJudgment(env.DB, judgment(repo, "risk"));
    await recordOutcome(env.DB, id, "yes", "2026-10-04T10:00:00.000Z");

    const { results } = await env.DB.prepare("SELECT * FROM outcomes WHERE judgment_id IN (?, ?)").bind(id, open).all();
    expect(results).toEqual([{ judgment_id: id, actual: "yes", correct: 0, observed_at: "2026-10-04T10:00:00.000Z" }]);
    await expect(recordOutcome(env.DB, "no-such-judgment", "yes", "2026-10-04T10:00:00.000Z")).rejects.toThrow();
  });

  it("second outcome for one judgment is rejected", async () => {
    const repo = await repoId("jdg-twice");
    const id = await recordJudgment(env.DB, judgment(repo, "flake"));
    await recordOutcome(env.DB, id, "no", "2026-10-04T10:00:00.000Z");
    await expect(recordOutcome(env.DB, id, "yes", "2026-10-04T11:00:00.000Z")).rejects.toThrow();
    const [j] = await judgmentsOf("jdg-twice", "flake");
    expect(j).toMatchObject({ actual: "no", correct: 1 });
  });
});

describe("risk outcomes from follow-ups", () => {
  // A queued change with this intent on repo, merged at `at`; returns its id.
  async function merge(repo, intent, at) {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'in_queue', ?)").bind(id, repo, at).run();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await runInDurableObject(stub, (i) => i.ctx.storage.put({ change: { id, repo_id: repo, target_branch: "main", state: "in_queue", intent }, events: [] }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    await stub.transition("merged", { kind: "merged", actor: { type: "system", id: "cinder" }, action: "job.report", target: "x", result: "ok" });
    vi.useRealTimers();
    return id;
  }
  const outcome = (change) => env.DB.prepare("SELECT o.actual, o.correct FROM outcomes o JOIN judgments j ON j.id = o.judgment_id WHERE j.change_id = ?").bind(change).first();
  const risk = async (repo, id) => recordJudgment(env.DB, { repo, change: id, kind: "risk", backend: "stat", model: "stat-1", state_hash: id, question: "will this change be reverted?", answer: "yes", p: 0.9 });

  it("revert creates a risky outcome", async () => {
    const repo = await repoId("jdg-revert");
    const a = await merge(repo, "add the parser", "2026-10-01T10:00:00.000Z");
    const late = await merge(repo, "add the lexer", "2026-09-01T10:00:00.000Z");
    await risk(repo, a);
    await risk(repo, late);
    const b = await merge(repo, `Revert ${a} and ${late}`, "2026-10-10T10:00:00.000Z");
    expect(await outcome(a)).toEqual({ actual: "yes", correct: 1 });
    // Named after its 14 days: already safe, the revert doesn't make it risky.
    expect(await outcome(late)).toEqual({ actual: "no", correct: 0 });
    expect(await outcome(b)).toBeNull();
  });
});

describe("judge calibration", () => {
  it("PAV on a known sequence gives the textbook result", () => {
    const xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    const { calibrated } = calibrate(xs.map((p, i) => ({ p, y: [1, 3, 2, 4, 3, 5][i] })));
    expect(xs.map(calibrated)).toEqual([1, 2.5, 2.5, 3.5, 3.5, 5]);
    expect(calibrate([]).calibrated(0.7)).toBe(0.7);
  });

  it("fewer than minOutcomes outcomes gives trusted=false", () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({ p: 0.8, y: i % 2 }));
    expect(calibrate(pairs.slice(0, 29), 30)).toMatchObject({ count: 29, trusted: false });
    expect(calibrate(pairs, 30)).toMatchObject({ count: 30, trusted: true });
    expect(calibrate([], 30)).toMatchObject({ count: 0, trusted: false, brier: null, bins: [] });
  });

  it("Brier score of a perfect judge is 0", async () => {
    const repo = await repoId("jdg-brier");
    // Only a configured judge is listed: point the repo's risk judge at the series this test records.
    await env.DB.prepare("UPDATE judge_config SET backend = 'stat', model_version = 'stat-1' WHERE repo_id = ? AND kind = 'risk'").bind(repo).run();
    const right = await recordJudgment(env.DB, { ...judgment(repo, "risk"), p: 1 });
    const wrong = await recordJudgment(env.DB, { ...judgment(repo, "risk"), p: 0 });
    await recordJudgment(env.DB, { ...judgment(repo, "risk"), p: 0.5 });
    await recordOutcome(env.DB, right, "no", "2026-10-04T10:00:00.000Z");
    await recordOutcome(env.DB, wrong, "yes", "2026-10-04T10:00:00.000Z");
    const judges = (await (await call("/api/repos/jdg-brier/judges")).json()).judges.filter((j) => j.count);
    expect(judges).toHaveLength(1);
    expect(validateJudge(judges[0])).toEqual({ ok: true, errors: [] });
    expect(judges[0]).toMatchObject({ count: 2, trusted: false, brier: 0 });
    expect(judges[0].bins).toEqual([
      { lo: 0, hi: 0.1, count: 1, mean_p: 0, observed: 0 },
      { lo: 0.9, hi: 1, count: 1, mean_p: 1, observed: 1 },
    ]);
    expect((await call("/api/repos/missing/judges")).status).toBe(404);
  });

  it("with judgments 10 and 100 days old, ?weeks=4 counts only the recent one in count, bins and brier", async () => {
    const repo = await repoId("jdg-window");
    await env.DB.prepare("UPDATE judge_config SET backend = 'stat', model_version = 'stat-1' WHERE repo_id = ? AND kind = 'risk'").bind(repo).run();
    const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
    for (const [days, p, label] of [[10, 1, "no"], [100, 0, "no"]]) {
      const id = await recordJudgment(env.DB, { ...judgment(repo, "risk"), p });
      await env.DB.prepare("UPDATE judgments SET made_at = ? WHERE id = ?").bind(ago(days), id).run();
      await recordOutcome(env.DB, id, label, ago(days));
    }
    const risk = async (q) => (await (await call(`/api/repos/jdg-window/judges${q}`)).json()).judges.find((j) => j.kind === "risk");
    expect(await risk("?weeks=4")).toMatchObject({ count: 1, total: 2, brier: 0, bins: [{ lo: 0.9, hi: 1, count: 1, mean_p: 1, observed: 1 }] });
    expect(await risk("")).toMatchObject({ count: 2, total: 2, brier: 0.5 });
  });
});

describe("humans and agents as judges", () => {
  async function change(name) {
    const repo = await repoId(name);
    const id = `${name}-c1`;
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', ?)")
      .bind(id, repo, "2026-10-04T10:00:00.000Z").run();
    return { id, repo_id: repo };
  }

  it("risk outcome attaches to the human judgment too", async () => {
    const c = await change("echo-outcome");
    await recordVerdict(env.DB, c, { person: "owner", verdict: "fail" });
    await recordVerdict(env.DB, c, { agent: "reviewer", version: 3, verdict: "pass" });
    await recordRiskOutcome(env.DB, c.id, "yes", "2026-10-04T12:00:00.000Z");
    const list = await judgmentsOf("echo-outcome", "risk");
    expect(list.map((j) => [j.backend, j.probability, j.correct === 1]).sort()).toEqual([
      ["agent:reviewer@3", 0.1, true],
      ["human:owner", 0.9, true],
    ]);
  });

  it("the judges list includes recent verdicts for a judge with outcomes", async () => {
    const c = await change("echo-recent");
    await recordVerdict(env.DB, c, { person: "owner", verdict: "fail" });
    await recordRiskOutcome(env.DB, c.id, "no", "2026-10-04T12:00:00.000Z");
    const judges = (await (await call("/api/repos/echo-recent/judges")).json()).judges.filter((j) => j.count);
    expect(judges.map((j) => [j.backend, j.recent])).toEqual([
      ["human:owner", [{ repo: "echo-recent", change_id: c.id, p: 0.9, correct: false, made_at: expect.any(String) }]],
    ]);
  });

  it("a judge's recent verdict names the agent@version that wrote the change", async () => {
    const c = await change("echo-agent");
    await env.DB.prepare("INSERT INTO change_cards (change_id, card) VALUES (?, ?)").bind(c.id, JSON.stringify({ agent: "developer", ver: "v8" })).run();
    await recordVerdict(env.DB, c, { person: "owner", verdict: "fail" });
    await recordRiskOutcome(env.DB, c.id, "no", "2026-10-04T12:00:00.000Z");
    const { judges } = await (await call("/api/repos/echo-agent/judges")).json();
    expect(judges.find((j) => j.backend === "human:owner").recent[0].agent).toBe("developer@v8");
  });

  it("reliability data lists human and agent backends", async () => {
    const c = await change("echo-judges");
    await recordVerdict(env.DB, c, { person: "owner", verdict: "pass" });
    await recordVerdict(env.DB, c, { agent: "reviewer", version: 3, verdict: "fail" });
    await recordRiskOutcome(env.DB, c.id, "no", "2026-10-04T12:00:00.000Z");
    const judges = (await (await call("/api/repos/echo-judges/judges")).json()).judges.filter((j) => j.count);
    for (const j of judges) expect(validateJudge(j)).toEqual({ ok: true, errors: [] });
    expect(judges.map((j) => [j.kind, j.backend, j.count])).toEqual([
      ["risk", "agent:reviewer@3", 1],
      ["risk", "human:owner", 1],
    ]);
  });
});

describe("judge configuration", () => {
  const configure = (repo, kind, backend, model) =>
    env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, ?, ?, ?)").bind(repo, kind, backend, model).run();
  it("the judges list shows only configured judges: an earlier model is history and an unconfigured kind is left out", async () => {
    const repo = await repoId("jdg-configured");
    await configure(repo, "risk", "clef", "clef@2");
    const scored = async (kind, backend, model) => recordOutcome(env.DB, await recordJudgment(env.DB, { ...judgment(repo, kind), backend, model }), "no", "2026-10-04T10:00:00.000Z");
    await scored("risk", "clef", "clef@2");
    await scored("risk", "clef", "clef@1");
    await env.DB.prepare("DELETE FROM judge_config WHERE repo_id = ? AND kind = 'flake'").bind(repo).run();
    await scored("flake", "stat", "stat-1");
    const { judges } = await (await call("/api/repos/jdg-configured/judges")).json();
    const risk = judges.filter((j) => j.kind === "risk");
    expect(risk.map((j) => [j.backend, j.model_version, j.count])).toEqual([["clef", "clef@2", 1]]);
    expect(risk[0].history).toMatchObject([{ backend: "clef", model_version: "clef@1", count: 1, trusted: false }]);
    expect(judges.some((j) => j.kind === "flake")).toBe(false);
    for (const j of judges) expect(validateJudge(j)).toEqual({ ok: true, errors: [] });
  });

  const fakeAI = (answers) => {
    const models = [];
    return { models, ...fakeClefAI(async (model) => (models.push(model), answers === null ? Promise.reject(new Error("down")) : answers)) };
  };
  const Q = { touches: { kind: "score", prompt: "touches outside lease?" } };
  // The repo's TYPESAFE_API_KEY Keystore entry, read as cinder-secrets reads it through its binding.
  const typesafeKey = async (name, value) => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO keystore_secrets (id, name, kind, scope, repo, owner, store_id, store_secret_id, store_secret_name, created_at) VALUES (?, 'TYPESAFE_API_KEY', 'api_key', 'repo', ?, 'owner', 'store1', ?, ?, ?)")
      .bind(id, name, id, `cinder_${id}`, new Date().toISOString()).run();
    return { ...env, SECRETS: { read: async (b) => (b === binding(id) ? value : null) } };
  };

  it("a jev judge reads its key from the saved credential", async () => {
    const repo = await repoId("jdg-jev-key");
    await configure(repo, "risk", "jev", "jev@1");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ answers: { touches: 0.9 } }));
    try {
      expect((await judge({ ...env, TYPESAFE_API_KEY: "worker-secret" }, repo, "risk", {}, Q)).touches.reason).toMatch(/TYPESAFE_API_KEY Keystore secret/);
      expect(fetch).not.toHaveBeenCalled();
      expect((await judge(await typesafeKey("jdg-jev-key", "ts-saved-key"), repo, "risk", {}, Q)).touches.answer).toBe("yes");
      expect(new Request(...fetch.mock.calls[0]).headers.get("authorization")).toBe("Bearer ts-saved-key");
    } finally {
      fetch.mockRestore();
    }
  });

  it("a new repo gets every judge that delivery calls, and no unused one", async () => {
    const repo = await repoId("jdg-defaults");
    const { results } = await env.DB.prepare("SELECT kind, backend, model_version FROM judge_config WHERE repo_id = ? ORDER BY kind").bind(repo).all();
    expect(results.map((r) => [r.kind, r.backend, r.model_version])).toEqual([
      ["collision", "clef-flash", "clef-flash@2"], ["flake", "clef", "clef@2"], ["guard", "clef-flash", "clef-flash@2"], ["lease", "clef-flash", "clef-flash@2"],
      ["resembles_vuln", "clef", "clef@2"], ["risk", "clef", "clef@2"], ["seam", "clef-flash", "clef-flash@2"], ["split", "clef-flash", "clef-flash@2"],
    ]);
  });

  it("lease questions route to clef-flash", async () => {
    const repo = await repoId("jdg-lease-flash");
    const AI = fakeAI({ touches: 0.2 });
    expect(await judge({ ...env, AI }, repo, "lease", {}, Q)).toEqual({ touches: { answer: "no", p: 0.8, trusted: false } });
    expect(AI.models).toEqual([CLEF_MODELS["clef-flash@2"]]);
  });

  it("a clef judge's Workers AI call carries the AI Gateway option with repo and change metadata", async () => {
    const repo = await repoId("jdg-gateway");
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES ('ch-1', ?, 'main', 'open', '')").bind(repo).run();
    const options = [];
    const AI = fakeClefAI(async (model, body, opts) => (options.push(opts), { touches: 0.2 }));
    await judge({ ...env, AI, AI_GATEWAY_ID: "cinder" }, repo, "lease", {}, Q, "ch-1");
    expect(options).toEqual([{ gateway: { id: "cinder", metadata: { repo, change: "ch-1" } } }]);
  });

  it("kind routed to its configured backend", async () => {
    const repo = await repoId("jdg-route");
    await configure(repo, "lease", "clef", "clef@1");
    await configure(repo, "risk", "clef-flash", "clef-flash@1");
    const AI = fakeAI({ touches: 0.2 });
    expect(await judge({ ...env, AI }, repo, "risk", { files: ["a.js"] }, Q)).toEqual({ touches: { answer: "no", p: 0.8, trusted: false } });
    await judge({ ...env, AI }, repo, "lease", { files: ["a.js"] }, Q);
    expect(AI.models).toEqual([CLEF_MODELS["clef-flash@1"], CLEF_MODELS["clef@1"]]);
    const list = await judgmentsOf("jdg-route");
    expect(list.map((j) => [j.kind, j.backend, j.model_version, j.answer, j.probability])).toEqual(expect.arrayContaining([
      ["risk", "clef-flash", "clef-flash@1", "no", 0.8], ["lease", "clef", "clef@1", "no", 0.8],
    ]));
  });

  it("each default judge's model call reaches a valid Workers AI catalog model ID", async () => {
    const repo = await repoId("jdg-catalog");
    const { results } = await env.DB.prepare("SELECT kind FROM judge_config WHERE repo_id = ?").bind(repo).all();
    expect(results).toHaveLength(8);
    for (const { kind } of results) {
      const AI = fakeAI({ touches: 0.2 });
      expect(await judge({ ...env, AI }, repo, kind, {}, Q)).toEqual({ touches: { answer: "no", p: 0.8, trusted: false } });
      expect(AI.models).toEqual([expect.stringMatching(/^@cf\/[\w-]+\/[\w.-]+$/)]);
    }
  });

  it("an AI failure yields a verdict marked untrusted with the reason recorded", async () => {
    const repo = await repoId("jdg-ai-down");
    const untrusted = { touches: { answer: null, p: null, trusted: false, reason: "s1: request failed: down" } };
    expect(await judge({ ...env, AI: fakeAI(null) }, repo, "risk", {}, Q)).toEqual(untrusted);
    expect(await judge({ ...env, AI: fakeAI(null) }, repo, "risk", {}, Q)).toEqual(untrusted);
    const { results } = await env.DB.prepare("SELECT kind, backend, model_version, reason, count FROM judge_failures WHERE repo_id = ?").bind(repo).all();
    expect(results).toEqual([{ kind: "risk", backend: "clef", model_version: "clef@2", reason: "s1: request failed: down", count: 2 }]);
  });

  it("untrusted judgment flagged so the caller uses the default", async () => {
    const repo = await repoId("jdg-trust");
    await env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, 30)").bind(repo).run();
    const untrusted = { touches: { answer: null, p: null, trusted: false } };
    await env.DB.prepare("DELETE FROM judge_config WHERE repo_id = ?").bind(repo).run();
    expect(await judge({ ...env, AI: fakeAI({ touches: 0.9 }) }, repo, "lease", {}, Q)).toEqual(untrusted);
    await configure(repo, "lease", "clef", "clef@1");
    expect(await judge({ ...env, AI: fakeAI(null) }, repo, "lease", {}, Q)).toEqual({ touches: { ...untrusted.touches, reason: "s1: request failed: down" } });
    for (let i = 0; i < 29; i++) {
      await recordOutcome(env.DB, await recordJudgment(env.DB, { ...judgment(repo, "lease"), backend: "clef", model: "clef@1", answer: "yes", p: 0.9 }), "yes", "2026-10-04T10:00:00.000Z");
    }
    const ai = { ...env, AI: fakeAI({ touches: 0.9 }) };
    expect(await judge(ai, repo, "lease", {}, Q)).toEqual({ touches: { answer: "yes", p: 1, trusted: false } });
    const [last] = (await judgmentsOf("jdg-trust")).filter((j) => j.actual === null);
    await recordOutcome(env.DB, last.id, "yes", "2026-10-04T11:00:00.000Z");
    expect(await judge(ai, repo, "lease", {}, Q)).toEqual({ touches: { answer: "yes", p: 1, trusted: true } });
  });

  it("with airlock on, a kind configured for jev is answered by the fallback, never jev", async () => {
    const repo = await repoId("jdg-airlock");
    await configure(repo, "risk", "jev", "jev@1");
    await env.DB.prepare("INSERT INTO airlock_repos (repo_id) VALUES (?)").bind(repo).run();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ answers: { touches: 0.9 } }));
    try {
      expect(await judge({ ...env, TYPESAFE_API_KEY: "k" }, repo, "risk", {}, Q)).toEqual({ touches: { answer: null, p: null, trusted: false, reason: expect.stringMatching(/airlock is on/) } });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
    expect(await judgmentsOf("jdg-airlock")).toEqual([]);
  });

  const put = (path, body) => call(path, { method: "PUT", body: JSON.stringify(body) });

  it("turning the airlock on refuses a hosted backend on the next judgment", async () => {
    const repo = await repoId("jdg-airlock-put");
    expect((await put("/api/repos/jdg-airlock-put/judges/risk", { backend: "jev", model_version: "jev@1" })).status).toBe(200);
    const keyed = await typesafeKey("jdg-airlock-put", "ts-saved-key");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ answers: { touches: 0.9 } }));
    try {
      const ask = () => judge(keyed, repo, "risk", {}, Q);
      expect((await ask()).touches.answer).toBe("yes");
      expect(fetch).toHaveBeenCalledTimes(1);
      const on = await put("/api/repos/jdg-airlock-put/airlock", { on: true });
      expect(await on.json()).toEqual({ airlock: true });
      expect(await ask()).toEqual({ touches: { answer: null, p: null, trusted: false, reason: expect.stringMatching(/airlock is on/) } });
      expect(fetch).toHaveBeenCalledTimes(1);
      await put("/api/repos/jdg-airlock-put/airlock", { on: false });
      expect((await ask()).touches.answer).toBe("yes");
    } finally {
      fetch.mockRestore();
    }
    expect((await put("/api/repos/jdg-airlock-put/airlock", { on: "yes" })).status).toBe(400);
    expect((await put("/api/repos/missing/airlock", { on: true })).status).toBe(404);
  });

  it("an unknown backend returns 400", async () => {
    const repo = await repoId("jdg-backend-put");
    const res = await put("/api/repos/jdg-backend-put/judges/risk", { backend: "gpt-hosted", model_version: "x@1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("backend");
    for (const bad of [{ backend: "clef", model_version: "clef@latest" }, { backend: "systemone-http", model_version: "s1@1" }, { backend: "clef", model_version: "clef@2", base_url: "ftp://x" }]) {
      expect((await put("/api/repos/jdg-backend-put/judges/risk", bad)).status).toBe(400);
    }
    expect((await put("/api/repos/jdg-backend-put/judges/nope", { backend: "clef", model_version: "clef@2" })).status).toBe(400);
    const ok = { backend: "systemone-http", model_version: "s1@2", base_url: "https://s1.lan:8080" };
    expect((await put("/api/repos/jdg-backend-put/judges/risk", ok)).status).toBe(200);
    expect(await env.DB.prepare("SELECT backend, model_version, base_url FROM judge_config WHERE repo_id = ? AND kind = 'risk'").bind(repo).first())
      .toEqual(ok);
  });

  it("PUT /judges/:kind rejects a plain http base_url", async () => {
    await repoId("jdg-http-url");
    const res = await put("/api/repos/jdg-http-url/judges/risk", { backend: "systemone-http", model_version: "s1@2", base_url: "http://s1.lan:8080" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("base_url: expected an https URL");
  });

  it("a jev judge with its own base_url never gets the global key, only the repo's", async () => {
    const repo = await repoId("jdg-jev-url");
    await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version, base_url) VALUES (?, 'risk', 'jev', 'jev@1', 'https://jev.attacker.example')").bind(repo).run();
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO keystore_secrets (id, name, kind, scope, repo, owner, store_id, store_secret_id, store_secret_name, created_at) VALUES (?, 'TYPESAFE_API_KEY', 'api_key', 'global', NULL, 'owner', 'store1', ?, ?, ?)")
      .bind(id, id, `cinder_${id}`, new Date().toISOString()).run();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ answers: { touches: 0.9 } }));
    try {
      const global = { ...env, SECRETS: { read: async (b) => (b === binding(id) ? "global-key" : null) } };
      expect((await judge(global, repo, "risk", {}, Q)).touches.reason).toMatch(/TYPESAFE_API_KEY Keystore secret/);
      expect(fetch).not.toHaveBeenCalled();
      await env.DB.prepare("UPDATE judge_config SET base_url = NULL WHERE repo_id = ? AND kind = 'risk'").bind(repo).run();
      expect((await judge(global, repo, "risk", {}, Q)).touches.answer).toBe("yes");
      expect(new Request(...fetch.mock.calls[0]).headers.get("authorization")).toBe("Bearer global-key");
      await env.DB.prepare("UPDATE judge_config SET base_url = 'https://jev.attacker.example' WHERE repo_id = ? AND kind = 'risk'").bind(repo).run();
      expect((await judge(await typesafeKey("jdg-jev-url", "repo-key"), repo, "risk", {}, Q)).touches.answer).toBe("yes");
      expect(fetch.mock.calls[1][0]).toBe("https://jev.attacker.example/v1/systemone");
      expect(new Request(...fetch.mock.calls[1]).headers.get("authorization")).toBe("Bearer repo-key");
    } finally {
      fetch.mockRestore();
      await env.DB.prepare("DELETE FROM keystore_secrets WHERE id = ?").bind(id).run();
    }
  });

  it("PUT /judges/:kind rejects a clef version with no mapped model", async () => {
    await repoId("jdg-clef-model");
    const res = await put("/api/repos/jdg-clef-model/judges/risk", { backend: "clef", model_version: "clef@3" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("model_version: expected one of clef@1");
    expect((await put("/api/repos/jdg-clef-model/judges/risk", { backend: "clef-flash", model_version: "clef-flash@3" })).status).toBe(400);
    expect((await put("/api/repos/jdg-clef-model/judges/risk", { backend: "clef", model_version: "clef@1" })).status).toBe(200);
  });

  it("a judgment from a self-hosted backend appears in the judges view", async () => {
    const repo = await repoId("jdg-kev");
    const kev = { backend: "systemone-http", model_version: "kev@1", base_url: "https://s1.lab.example" };
    expect((await put("/api/repos/jdg-kev/judges/risk", kev)).status).toBe(200);
    // Cloudflare Access in front of the Tunnel turns away any request without the service token.
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
      url === "https://s1.lab.example/v1/systemone" && init.headers["cf-access-client-id"] === "kev.access" && init.headers["cf-access-client-secret"] === "s3cret"
        ? Response.json({ answers: { touches: 0.9 } }) : new Response("forbidden", { status: 403 }));
    try {
      const lab = { ...env, S1_ACCESS_CLIENT_ID: "kev.access", S1_ACCESS_CLIENT_SECRET: "s3cret" };
      expect((await judge(lab, repo, "risk", {}, Q)).touches.answer).toBe("yes");
    } finally {
      fetch.mockRestore();
    }
    const [j] = await judgmentsOf("jdg-kev", "risk");
    await recordOutcome(env.DB, j.id, "yes", "2026-10-04T10:00:00.000Z");
    const judges = (await (await call("/api/repos/jdg-kev/judges")).json()).judges.filter((j) => j.count);
    expect(judges.map((x) => [x.kind, x.backend, x.model_version, x.count])).toEqual([["risk", "systemone-http", "kev@1", 1]]);
  });

  it("fallbacks to the default verdict are listed per judge with a count, a reason and health", async () => {
    const repo = await repoId("jdg-fallbacks");
    await configure(repo, "risk", "clef", "clef@1");
    for (let i = 0; i < 2; i++) await recordOutcome(env.DB, await recordJudgment(env.DB, { ...judgment(repo, "risk"), backend: "clef", model: "clef@1" }), "no", "2026-10-04T10:00:00.000Z");
    const list = async () => (await (await call("/api/repos/jdg-fallbacks/judges")).json()).judges.filter((j) => j.count).map(({ health, reason, fallbacks }) => ({ health, reason, fallbacks }));
    expect(await list()).toEqual([{ health: "healthy", reason: null, fallbacks: 0 }]);
    await judge({ ...env, AI: fakeAI(null) }, repo, "risk", {}, Q);
    expect(await list()).toEqual([{ health: "degraded", reason: "s1: request failed: down", fallbacks: 1 }]);
    await judge(env, repo, "risk", {}, Q);
    expect(await list()).toEqual([{ health: "failing", reason: "s1: clef needs the AI binding", fallbacks: 2 }]);
    // Older than 7 days no longer counts.
    await env.DB.prepare("UPDATE judge_failures SET last_at = '2026-01-01T00:00:00.000Z' WHERE repo_id = ?").bind(repo).run();
    expect(await list()).toEqual([{ health: "healthy", reason: null, fallbacks: 0 }]);
  });

  it("a configured judge with no outcomes is listed with count 0", async () => {
    const repo = await repoId("jdg-unscored");
    await configure(repo, "risk", "clef", "clef@new");
    const body = await (await call("/api/repos/jdg-unscored/judges")).json();
    expect(validateJudges(body)).toEqual({ ok: true, errors: [] });
    expect(body.judges.find((j) => j.kind === "risk")).toMatchObject({ backend: "clef", model_version: "clef@new", count: 0, trusted: false, brier: null, bins: [], recent: [] });
  });

  it("airlock state is shown in GET /api/repos/:r/judges", async () => {
    const repo = await repoId("jdg-airlock-get");
    const get = async (e = {}) => (await worker.fetch(new Request("http://cinder.test/api/repos/jdg-airlock-get/judges", { headers: OWNER }), { ...env, ARTIFACTS: fakeArtifacts(), ...e })).json();
    const off = await get();
    expect(validateJudges(off)).toEqual({ ok: true, errors: [] });
    expect(off).toMatchObject({ airlock: false, trust: { min_outcomes: 200, min_races: 30 } });
    expect((await get({ AIRLOCK: "true" })).airlock).toBe(true);
    await env.DB.prepare("INSERT INTO airlock_repos (repo_id) VALUES (?)").bind(repo).run();
    expect((await get()).airlock).toBe(true);
  });
  it("a judge abstains below its minimum confidence", async () => {
    const repo = await repoId("jdg-min-conf");
    await put("/api/repos/jdg-min-conf/judges/lease", { backend: "clef", model_version: "clef@1", min_confidence: 0.9 });
    expect(await judge({ ...env, AI: fakeAI({ touches: 0.2 }) }, repo, "lease", {}, Q)).toEqual({ touches: { answer: null, p: null, trusted: false } });
    expect(await judgmentsOf("jdg-min-conf")).toEqual([]);
    expect((await judge({ ...env, AI: fakeAI({ touches: 0.95 }) }, repo, "lease", {}, Q)).touches.answer).toBe("yes");
  });

  it("a merged .cinder.yml judges entry adds a judge in airlock and swaps another's model", async () => {
    const fake = fakeArtifacts();
    await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "jdg-yml" }) }), { ...env, ARTIFACTS: fake });
    const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = 'jdg-yml'").first()).id;
    const yml = (judges) => { fake.repos.get("jdg-yml").files[".cinder.yml"] = `judges:\n${judges}`; return refreshPolicy({ ...env, ARTIFACTS: fake }, "jdg-yml", "main"); };
    // Every kind a repo starts with is configured, so take one away to add it back from .cinder.yml.
    await env.DB.prepare("DELETE FROM judge_config WHERE repo_id = ? AND kind = 'flake'").bind(repo).run();
    await yml("  flake:\n    backend: clef\n    model_version: clef@1\n    min_confidence: 0.7\n  risk:\n    backend: clef-flash\n    model_version: clef-flash@1\n");
    const config = async () => (await env.DB.prepare("SELECT c.kind, c.backend, c.model_version, coalesce(s.airlock, 0) AS airlock, s.min_outcomes, s.min_confidence FROM judge_config c " +
      "LEFT JOIN judge_settings s ON s.repo_id = c.repo_id AND s.kind = c.kind WHERE c.repo_id = ? AND c.kind IN ('flake', 'risk') ORDER BY c.kind")
      .bind(repo).all()).results;
    expect(await config()).toEqual([
      { kind: "flake", backend: "clef", model_version: "clef@1", airlock: 1, min_outcomes: null, min_confidence: 0.7 },
      { kind: "risk", backend: "clef-flash", model_version: "clef-flash@1", airlock: 0, min_outcomes: null, min_confidence: null },
    ]);
    await expect(yml("  risk:\n    backend: clef\n    model_version: clef@latest\n")).rejects.toThrow(/judges.risk: model_version/);
    expect((await config())[1].backend).toBe("clef-flash");
  });
});
