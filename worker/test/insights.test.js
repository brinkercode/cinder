import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateInsights } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, init = {}) =>
  worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: OWNER }), { ...env, ARTIFACTS: fakeArtifacts() });

describe("insights", () => {
  it("win rate untrusted below 30 races", async () => {
    await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "ins-races" }) });
    const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind("ins-races").first()).id;
    // v1 races 30 times and wins 20; v2 races 29 times and wins 9. One undecided leg counts for neither.
    const legs = [
      ...Array.from({ length: 30 }, (_, i) => ["developer@v1", i < 20 ? 1 : 0]),
      ...Array.from({ length: 29 }, (_, i) => ["developer@v2", i < 9 ? 1 : 0]),
      ["developer@v2", null],
    ];
    await env.DB.batch(legs.flatMap(([agent, won], i) => [
      env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'closed', '2026-10-04T00:00:00Z')").bind(`ins-${i}`, repo),
      env.DB.prepare("INSERT INTO race_legs (change_id, race_id, agent, started_at, won) VALUES (?, ?, ?, '2026-10-04T00:00:00Z', ?)").bind(`ins-${i}`, `race-${i}`, agent, won),
    ]));
    const res = await call("/api/repos/ins-races/insights?from=2026-10-01T00:00:00Z&to=2026-10-05T00:00:00Z");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateInsights(body)).toEqual({ ok: true, errors: [] });
    expect(body.trust).toEqual({ min_outcomes: 200, min_races: 30 });
    expect(body.win_rates).toEqual([
      { agent: "developer@v1", value: 20 / 30, count: 30 },
      { agent: "developer@v2", untrusted: true, count: 29 },
    ]);
    expect((await call("/api/repos/missing/insights")).status).toBe(404);
  });
});

const get = async (repo, q) => (await worker.fetch(new Request(`http://cinder.test/api/repos/${repo}/insights${q}`, {
  headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
}), env)).json();
const addRepo = (id, name) => env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', '')").bind(id, name).run();
const stage = (cost_usd, verdict, started_at) => ({
  change_id: "x", stage: "develop", agent_version: "dev@1", harness: "claude-code", model: "m", cost_usd, duration_ms: 1, session: "s", verdict, dirty: false, started_at,
});
// The Analytics Engine points ChangeDO writes for a change's events and stage reports.
const track = (repo, id, events, stages) => {
  for (const e of events) env.INSIGHTS.writeDataPoint({ indexes: [repo], blobs: ["event", id, e.from_state, e.to_state, "agent", "dev@1"], doubles: [Date.parse(e.at), 0, 0, 0] });
  for (const s of stages) env.INSIGHTS.writeDataPoint({ indexes: [repo], blobs: ["stage", id, s.stage, s.verdict], doubles: [Date.parse(s.started_at), s.cost_usd, 0, 0] });
};

it("insights computes cost, parallelism and conflict rate without ChangeDO calls", async () => {
  await addRepo("ri-ae", "insights-ae");
  // a1 develops 00:00-12:00 and merges after two sessions; a2 develops 12:00-18:00 and conflicts.
  const ev = (from_state, to_state, at) => ({ from_state, to_state, at: `2026-10-01T${at}:00:00Z` });
  for (const id of ["a1", "a2"]) await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, 'ri-ae', 'main', 'draft', '')").bind(id).run();
  track("ri-ae", "a1", [ev("draft", "developing", "00"), ev("developing", "verifying", "12"), ev("in_queue", "conflict", "12"), ev("in_queue", "merged", "13")],
    [stage(1, "fail", "2026-10-01T01:00:00Z"), stage(2, "pass", "2026-10-01T02:00:00Z")]);
  track("ri-ae", "a2", [ev("draft", "developing", "12"), ev("developing", "conflict", "18")], []);
  await env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, change_id, tokens, cost_usd) VALUES ('ae1', 'ri-ae', '2026-10-01T01:00:00Z', 'a1', 1, 3)").run();
  const noDO = () => { throw new Error("ChangeDO called"); };
  const res = await (await worker.fetch(new Request("http://cinder.test/api/repos/insights-ae/insights?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z", { headers: OWNER }),
    { ...env, CHANGE_DO: { get: noDO, idFromName: noDO } })).json();
  expect([res.cost_per_merged_change, res.parallelism, res.conflict_rate]).toEqual([{ value: 3, count: 1 }, { value: 18 / 24, count: 2 }, { value: 1, count: 1 }]);
});

it("insights answers 503 naming Account Analytics: Read when the deploy token lacks it", async () => {
  await addRepo("ri-perm", "insights-perm");
  vi.stubGlobal("fetch", async () => new Response("", { status: 403 }));
  const res = await worker.fetch(new Request("http://cinder.test/api/repos/insights-perm/insights", { headers: OWNER }), { ...env, INSIGHTS_SQL: undefined, CF_DEPLOY_TOKEN: "t" });
  vi.unstubAllGlobals();
  expect(res.status).toBe(503);
  expect((await res.json()).error.message).toContain("Account Analytics: Read");
});

it("insights cost_per_merged_change matches usage_logs for merged changes, and conflict_rate ≤ 1", async () => {
  await addRepo("ri1", "insights-cost");
  // i1 conflicted twice, then merged; runners reported its stages at $0. i2 failed; i3 conflicted and is still open.
  const log = {
    i1: [[stage(0, "fail", "2026-10-01T01:00:00Z"), stage(0, "pass", "2026-10-01T02:00:00Z")], [{ from_state: "in_queue", to_state: "conflict", at: "2026-10-01T02:30:00Z" },
      { from_state: "in_queue", to_state: "conflict", at: "2026-10-01T02:40:00Z" }, { from_state: "in_queue", to_state: "merged", at: "2026-10-01T03:00:00Z" }]],
    i2: [[stage(0, "fail", "2026-10-01T04:00:00Z")], [{ from_state: "developing", to_state: "failed", at: "2026-10-01T05:00:00Z" }]],
    i3: [[], [{ from_state: "in_queue", to_state: "conflict", at: "2026-10-01T06:00:00Z" }]],
  };
  for (const [id, [stages, events]] of Object.entries(log)) {
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, 'ri1', 'main', 'draft', '')").bind(id).run();
    track("ri1", id, events, stages);
  }
  // i1's spend includes a call made before the window; i2's spend is not a merged change's.
  const usage = [["u1", "2026-09-30T23:00:00Z", "i1", 1.5], ["u2", "2026-10-01T01:00:00Z", "i1", 2.5], ["u3", "2026-10-01T04:00:00Z", "i2", 3]];
  await env.DB.batch(usage.map(([id, at, change, cost]) => env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, change_id, tokens, cost_usd) VALUES (?, 'ri1', ?, ?, 1, ?)").bind(id, at, change, cost)));
  const res = await get("insights-cost", "?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z");
  expect([res.cost_per_merged_change, res.conflict_rate]).toEqual([{ value: 4, count: 1 }, { value: 1, count: 1 }]);
  expect(res.daily[0].conflict_rate).toBe(1);
  expect(validateInsights(res)).toEqual({ ok: true, errors: [] });
});

it("a series with no data is untrusted", async () => {
  await addRepo("ri2", "insights-empty");
  const res = await get("insights-empty", "?from=2026-10-01T00:00:00Z&to=2026-10-03T00:00:00Z");
  const none = { untrusted: true, count: 0 };
  expect(res).toEqual({
    trust: { min_outcomes: 200, min_races: 30 },
    from: "2026-10-01T00:00:00.000Z", to: "2026-10-03T00:00:00.000Z",
    cost_per_merged_change: none, parallelism: none, conflict_rate: none, tokens_per_merged_change: none, win_rates: [],
    changes_per_day: none, merges_per_day: none, lead_time_hours: none, review_time_hours: none, failure_rate: none, deploys_per_day: none,
    change_fail_rate: none, top_agents: [], top_people: [],
    brier: [{ day: "2026-10-01", ...none }, { day: "2026-10-02", ...none }],
    daily: ["2026-10-01", "2026-10-02"].map((day) => ({ day, tokens: 0, cache_reads: 0, merged: 0, parallelism: 0, conflict_rate: 0 })),
    series: Array.from({ length: 48 }, (_, i) => ({ at: new Date(Date.parse("2026-10-01") + i * 3600000).toISOString(), merged: 0, passed: 0, failed: 0, tokens: 0, cost_usd: 0 })),
    calibration: { count: 0, brier: null, bins: [] }, lease_conflicts: { conflicts: 0, leases: 0 },
    usage: { tokens: 0, cost_usd: 0, by_agent: [], by_person: [], by_change: [] }, lists: expect.any(Array),
  });
  expect(validateInsights(res)).toEqual({ ok: true, errors: [] });
});

it("each insights metric names the list that backs it", async () => {
  await addRepo("ri-lists", "insights-lists");
  const res = await get("insights-lists", "?from=2026-10-01T00:00:00Z&to=2026-10-03T00:00:00Z");
  expect(res.lists).toEqual([
    { metric: "change_fail_rate", list: { path: "/api/repos/insights-lists/changes", query: { state: "failed", since: "2026-10-01T00:00:00.000Z" } } },
    { metric: "lease_conflicts", list: { path: "/api/repos/insights-lists/lease-map", query: {} } },
    { metric: "calibration", list: { path: "/api/repos/insights-lists/judges", query: {} } },
    { metric: "usage.by_agent", list: { path: "/api/agents", query: {} } },
  ]);
});

describe("insights daily series", () => {
  afterEach(() => vi.useRealTimers());
  const event = { kind: "merged", actor: { type: "system", id: "cinder" }, action: "job.report", target: "x", result: "ok" };
  // A change in the queue on repo `name`, optionally reporting a session, merged at `at`.
  async function merge(name, id, at, tokens) {
    const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'in_queue', ?)").bind(id, repo, at).run();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await runInDurableObject(stub, (i) => i.ctx.storage.put({ change: { id, repo_id: repo, target_branch: "main", state: "in_queue" }, events: [] }));
    if (tokens) await stub.report({ ...stage(1, "pass", at), change_id: id, tokens, cache_reads: tokens / 2 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    expect(await stub.transition("merged", event)).toMatchObject({ state: "merged" });
    vi.useRealTimers();
  }

  it("two days of merges produce two daily points", async () => {
    await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "ins-daily" }) });
    await merge("ins-daily", "d1", "2026-10-01T10:00:00Z", 100);
    await merge("ins-daily", "d2", "2026-10-02T10:00:00Z", 40);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const body = await (await call("/api/repos/ins-daily/insights?days=2")).json();
    vi.useRealTimers();
    expect(validateInsights(body)).toEqual({ ok: true, errors: [] });
    expect(body.daily).toEqual([
      { day: "2026-10-01", tokens: 100, cache_reads: 50, merged: 1, parallelism: 0, conflict_rate: 0 },
      { day: "2026-10-02", tokens: 40, cache_reads: 20, merged: 1, parallelism: 0, conflict_rate: 0 },
    ]);
  });

  it("tokens per merged change equals the sum of tokens divided by merges", async () => {
    await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "ins-tokens" }) });
    await merge("ins-tokens", "t1", "2026-10-01T10:00:00Z", 100);
    await merge("ins-tokens", "t2", "2026-10-01T11:00:00Z", 30);
    await merge("ins-tokens", "t3", "2026-10-02T10:00:00Z", 20);
    const body = await (await call("/api/repos/ins-tokens/insights?from=2026-10-01T00:00:00Z&to=2026-10-03T00:00:00Z")).json();
    expect(body.tokens_per_merged_change).toEqual({ value: (100 + 30 + 20) / 3, count: 3 });
  });
});

it("the usage lens includes runs from outside cinder: a gateway row without cinder metadata is grouped apart and tagged outside", async () => {
  await addRepo("ri-usage", "insights-usage");
  await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES ('u-1', 'ri-usage', 'main', 'merged', '')").run();
  track("ri-usage", "u-1", [{ from_state: "in_queue", to_state: "merged", at: "2026-10-01T03:00:00Z" }], [stage(1, "pass", "2026-10-01T02:00:00Z")]);
  const rows = [
    { id: "g1", at: "2026-10-01T01:00:00Z", change_id: "u-1", agent_version: "developer@v7", person: "maya", tokens: 1000, cost_usd: 1.5 },
    { id: "g2", at: "2026-10-01T02:00:00Z", agent_version: "claude-code", person: "maya", tokens: 400, cost_usd: 0.5 },
  ];
  await env.DB.batch(rows.map((r) => env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, change_id, agent_version, person, tokens, cost_usd) VALUES (?, 'ri-usage', ?, ?, ?, ?, ?, ?)")
    .bind(r.id, r.at, r.change_id ?? null, r.agent_version, r.person, r.tokens, r.cost_usd)));
  const res = await get("insights-usage", "?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z");
  expect(validateInsights(res)).toEqual({ ok: true, errors: [] });
  const [inside, outside] = [{ outside: false, tokens: 1000, cost_usd: 1.5, merged: 1 }, { outside: true, tokens: 400, cost_usd: 0.5, merged: 0 }];
  expect(res.usage).toEqual({ tokens: 1400, cost_usd: 2, by_agent: [{ name: "developer@v7", ...inside }, { name: "claude-code", ...outside }],
    by_person: [{ name: "maya", ...inside }, { name: "maya", ...outside }], by_change: [{ change_id: "u-1", cost_usd: 1.5 }] });
  expect(res.series.reduce((n, b) => [n[0] + b.merged, n[1] + b.passed, n[2] + b.tokens], [0, 0, 0])).toEqual([1, 0, 1400]);
});


it("a by_agent row for a registered agent version carries its token limits", async () => {
  await addRepo("ri-limits", "insights-limits");
  await env.DB.prepare("INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
    "VALUES ('av-lim', 'limdev', 3, 'claude-code', 'm', 'default', 'h', '[]', '{\"max_tokens\":200000,\"max_cost_usd\":5}')").run();
  await env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, change_id, agent_version, person, tokens, cost_usd) VALUES ('gl1', 'ri-limits', '2026-10-01T01:00:00Z', 'x', 'limdev@v3', 'maya', 10, 0.1)").run();
  const res = await get("insights-limits", "?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z");
  expect(validateInsights(res)).toEqual({ ok: true, errors: [] });
  expect(res.usage.by_agent[0].limits).toEqual({ max_tokens: 200000, max_tokens_month: null });
});
