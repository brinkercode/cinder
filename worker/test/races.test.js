import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { DEFAULT_EGRESS } from "../src/agents.js";
import { expandRace } from "../src/races.js";
import { validateRaceScorecard, validateRaceSummary } from "../src/api/shapes.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

async function setup(name, spec = ["developer@v1", "developer@v2"]) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const res = await call(`/api/repos/${name}/changes`, { intent: "x", race: spec });
  expect(res.status).toBe(201);
  const race = await res.json();
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["verify"] })).json()).token;
  // Develops a leg up to verifying, then reports its verify job.
  const verify = async (change, status, extra) => {
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
    for (const to of ["developing", "verifying"]) {
      await stub.transition(to, { kind: to, actor: { type: "system", id: "test" }, action: "job.report", target: change.id, result: "ok" });
    }
    // A pushed head with a clean guard result, so only the verdict decides the merge gate.
    await stub.stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: change.id, result: "ok" }, { head: "h1", guard: { status: "clear", sha: "h1", at: new Date().toISOString() } });
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(id, change.repo_id, change.id, new Date().toISOString()).run();
    expect((await (await call("/api/work/claim", { kinds: ["verify"] }, runner)).json()).job.id).toBe(id);
    expect((await call(`/api/work/jobs/${id}/report`, { status, ...extra }, runner)).status).toBe(200);
  };
  const state = async (id) => (await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).state;
  const legs = async () => (await env.DB.prepare("SELECT agent FROM race_legs WHERE race_id = ? ORDER BY agent").bind(race.id).all()).results.map((l) => l.agent);
  return { call, fake, race, verify, state, legs };
}

describe("races", () => {
  it("race creates two forks and two develop jobs", async () => {
    const { fake, race, state } = await setup("race-forks");
    expect(race.changes).toHaveLength(2);
    const forks = fake.calls.filter((c) => c.method === "fork").map((c) => c.args[1]);
    expect(forks).toEqual(race.changes.map((c) => c.fork));
    expect(new Set(forks).size).toBe(2);
    const { results } = await env.DB.prepare("SELECT change_id, payload FROM jobs WHERE kind = 'develop' AND status = 'queued' AND change_id IN (?, ?) ORDER BY payload")
      .bind(race.changes[0].id, race.changes[1].id).all();
    expect(results.map((j) => ({ change_id: j.change_id, ...JSON.parse(j.payload) }))).toEqual([
      expect.objectContaining({ change_id: race.changes[0].id, agent: "developer@v1", race: race.id }),
      expect.objectContaining({ change_id: race.changes[1].id, agent: "developer@v2", race: race.id }),
    ]);
    expect(await state(race.changes[0].id)).toBe("leased");
  });

  it("race comparison fields present: verdict, cost, time, changed lines", async () => {
    const { race, verify } = await setup("race-compare");
    await verify(race.changes[0], "done", { cost_usd: 1.5, changed_lines: 40 });
    await verify(race.changes[1], "failed", { cost_usd: 0.5, changed_lines: 12 });
    const { results } = await env.DB.prepare("SELECT change_id, agent, verdict, cost_usd, secs, changed_lines FROM race_legs WHERE race_id = ? ORDER BY agent")
      .bind(race.id).all();
    expect(results).toEqual([
      { change_id: race.changes[0].id, agent: "developer@v1", verdict: "pass", cost_usd: 1.5, secs: expect.any(Number), changed_lines: 40 },
      { change_id: race.changes[1].id, agent: "developer@v2", verdict: "fail", cost_usd: 0.5, secs: expect.any(Number), changed_lines: 12 },
    ]);
  });

  it("race winner queued, loser closed", async () => {
    const { race, verify, state } = await setup("race-win");
    const [a, b] = race.changes;
    await verify(a, "done", { cost_usd: 1, changed_lines: 3 });
    // The first green waits for its rival's verdict before it queues.
    expect(await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(a.id).first()).toBeNull();
    await verify(b, "failed", { cost_usd: 1, changed_lines: 3 });
    expect(await state(a.id)).toBe("in_queue");
    expect(await state(b.id)).toBe("closed");
    const { results } = await env.DB.prepare("SELECT change_id FROM queue_entries WHERE change_id IN (?, ?)").bind(a.id, b.id).all();
    expect(results).toEqual([{ change_id: a.id }]);
    expect(await env.DB.prepare("SELECT 1 FROM jobs WHERE kind = 'merge' AND change_id = ?").bind(a.id).first()).not.toBeNull();
  });

  it("scorecard lists all axes per leg", async () => {
    const { race, verify } = await setup("race-scorecard");
    await verify(race.changes[0], "done", { cost_usd: 1.5, changed_lines: 40, new_deps: 2, review_findings: 3 });
    await verify(race.changes[1], "failed", { cost_usd: 0.5, changed_lines: 12, new_deps: 0, review_findings: 1 });
    const res = await worker.fetch(new Request(`http://cinder.test/api/races/${race.id}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(validateRaceScorecard(card)).toEqual({ ok: true, errors: [] });
    expect(card.legs).toEqual([
      { change_id: race.changes[0].id, leg: "developer@v1", verdict: "pass", diff_lines: 40, new_deps: 2, review_findings: 3, cost_usd: 1.5, duration_ms: expect.any(Number), won: 1 },
      { change_id: race.changes[1].id, leg: "developer@v2", verdict: "fail", diff_lines: 12, new_deps: 0, review_findings: 1, cost_usd: 0.5, duration_ms: expect.any(Number), won: 0 },
    ]);
  });

  it("the race list includes a decided race with its winner", async () => {
    const { race, verify } = await setup("race-list", ["lister@v1", "lister@v2"]);
    await verify(race.changes[0], "failed", {});
    await verify(race.changes[1], "done", {});
    const get = async (q) => (await worker.fetch(new Request(`http://cinder.test/api/races${q}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env)).json();
    const list = await get("?agent=lister");
    expect(list.map(validateRaceSummary)).toEqual([{ ok: true, errors: [] }]);
    expect(list[0]).toMatchObject({ id: race.id, winner: "lister@v2" });
    expect(list[0].legs.map((l) => [l.change_id, l.leg, l.verdict, l.won])).toEqual([
      [race.changes[0].id, "lister@v1", "fail", 0], [race.changes[1].id, "lister@v2", "pass", 1],
    ]);
    expect((await get("")).some((r) => r.id === race.id)).toBe(true);
    expect(await get("?agent=list")).toEqual([]);
  });

  it("the race list leaves out a race that has recorded only one leg so far", async () => {
    // A race running one leg at a time records the second when it starts developing.
    await env.DB.prepare("INSERT INTO race_legs (change_id, race_id, agent, started_at) VALUES ('one-leg-c', 'one-leg-race', 'developer@v1', ?)")
      .bind(new Date().toISOString()).run();
    const res = await worker.fetch(new Request("http://cinder.test/api/races", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    const races = await res.json();
    expect(races.map((r) => r.id)).not.toContain("one-leg-race");
    for (const r of races) expect(validateRaceSummary(r)).toEqual({ ok: true, errors: [] });
  });

  it("promote sets the change head to the leg head", async () => {
    const { call, race, state } = await setup("race-promote");
    const [a, b] = race.changes;
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, 'aaa'), (?, 'bbb')").bind(a.id, b.id).run();
    expect((await call(`/api/changes/${a.id}/promote`, { leg: "developer@v3" })).status).toBe(404);
    const res = await call(`/api/changes/${a.id}/promote`, { leg: "developer@v2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: a.id, head: "bbb", fork: b.fork });
    const got = await worker.fetch(new Request(`http://cinder.test/api/changes/${a.id}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    expect((await got.json()).head_sha).toBe("bbb");
    // The other leg is closed and its develop job cancelled.
    expect(await state(b.id)).toBe("closed");
    const job = await env.DB.prepare("SELECT id FROM jobs WHERE change_id = ? AND kind = 'develop'").bind(b.id).first("id");
    expect(await env.DB.prepare("SELECT 1 FROM job_cancels WHERE job_id = ?").bind(job).first()).not.toBeNull();
  });

  it("promote records race_won for the winning version", async () => {
    const { call, race } = await setup("race-promote-won");
    const [a, b] = race.changes;
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, 'bbb')").bind(b.id).run();
    expect((await call(`/api/changes/${b.id}/promote`, { leg: "developer@v2" })).status).toBe(200);
    const { results } = await env.DB.prepare("SELECT agent_version, outcome FROM agent_outcomes WHERE change_id IN (?, ?)").bind(a.id, b.id).all();
    // The losing leg closes, which scores a closed outcome against the version it ran (src/canary.js).
    expect(results).toEqual([{ agent_version: "developer@v2", outcome: "race_won" }, { agent_version: "developer@v1", outcome: "closed" }]);
    const won = await env.DB.prepare("SELECT agent, won FROM race_legs WHERE race_id = ? ORDER BY agent").bind(race.id).all();
    expect(won.results).toEqual([{ agent: "developer@v1", won: 0 }, { agent: "developer@v2", won: 1 }]);
  });

  it("expands two versions into two legs with distinct ids", async () => {
    const { fake, race, legs } = await setup("race-matrix", { agent: ["developer@v1", "developer@v2"] });
    const ids = race.changes.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(new Set(fake.calls.filter((c) => c.method === "fork").map((c) => c.args[1])).size).toBe(2);
    expect(await legs()).toEqual(["developer@v1", "developer@v2"]);
  });

  it("exclude removes a leg", async () => {
    const { race, legs } = await setup("race-exclude", { agent: ["developer@v1", "developer@v2", "developer@v3"], exclude: [{ agent: "developer@v2" }] });
    expect(race.changes).toHaveLength(2);
    expect(await legs()).toEqual(["developer@v1", "developer@v3"]);
  });

  it("leg names are stable across re-expansion", () => {
    const spec = { model: ["opus", "sonnet"], include: [{ model: "opus", harness: "claude" }, { model: "haiku" }] };
    const names = expandRace(spec).legs.map((l) => l.name);
    expect(names).toEqual(["opus, claude", "sonnet", "haiku"]);
    expect(expandRace(structuredClone(spec)).legs.map((l) => l.name)).toEqual(names);
  });

  it("max_parallel holds back legs beyond it until a running leg's slot frees", async () => {
    const { call, race } = await setup("race-parallel", { harness: ["claude", "codex"], max_parallel: 1 });
    // Other tests' develop jobs share this database; only this race's legs stay claimable.
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE kind = 'develop' AND status = 'queued' AND json_extract(payload, '$.race') IS NOT ?").bind(race.id).run();
    const dev = (await (await call("/api/runners", { name: "dev", kinds: ["develop"], slots: 2 })).json()).token;
    const first = await (await call("/api/work/claim", { kinds: ["develop"], slots_free: 2 }, dev)).json();
    expect((await call("/api/work/claim", { kinds: ["develop"], slots_free: 1 }, dev)).status).toBe(204);
    expect((await call(`/api/work/jobs/${first.job.id}/report`, { status: "done" }, dev)).status).toBe(200);
    expect((await call("/api/work/claim", { kinds: ["develop"], slots_free: 1 }, dev)).status).toBe(200);
  });

  it("a race's two legs claim with their own harness and model", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES ('agent/dev/v3', 'dev', 3, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{}')"),
      env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES ('agent/dev-open/v1', 'dev-open', 1, 'opencode', 'workers-ai/qwen', 'default', 'h', '[]', '{}')"),
      env.DB.prepare("INSERT OR IGNORE INTO agent_releases (name, version, egress, released_at) VALUES ('dev', 3, '[\"*.github.com\"]', '2026-10-05T00:00:00Z')"),
    ]);
    const { call, race } = await setup("race-locks", ["dev@v3", "dev-open@v1"]);
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE kind = 'develop' AND status = 'queued' AND json_extract(payload, '$.race') IS NOT ?").bind(race.id).run();
    const dev = (await (await call("/api/runners", { name: "dev", kinds: ["develop"], slots: 2 })).json()).token;
    const claims = await Promise.all(race.changes.map(async () => (await call("/api/work/claim", { kinds: ["develop"], slots_free: 2 }, dev)).json()));
    expect(claims.map((c) => c.agent).sort((a, b) => a.agent.localeCompare(b.agent))).toEqual([
      { agent: "dev", name: "dev", version: 3, harness: "claude-code", model: "claude-opus-5-5", egress: ["*.github.com"], egress_mode: "enforce", web: "raw",
        prompt: "", limits: { max_spend: null, max_repairs: null, max_tokens: null, max_tokens_month: null, tokens_month: 0, max_minutes: null } },
      { agent: "dev-open", name: "dev-open", version: 1, harness: "opencode", model: "workers-ai/qwen", egress: DEFAULT_EGRESS, egress_mode: "enforce", web: "raw",
        prompt: "", limits: { max_spend: null, max_repairs: null, max_tokens: null, max_tokens_month: null, tokens_month: 0, max_minutes: null } },
    ]);
  });
});
