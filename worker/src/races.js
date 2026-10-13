import { enqueue, queueMergeJob } from "./queue.js";
import { autoPromote } from "./fleet.js";
import { error } from "./router.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const raceEvent = (kind, id) => ({ kind, actor: { type: "system", id: "cinder" }, action: kind === "leased" ? "change.lease" : "change.close", target: id, result: "ok", reason: kind === "leased" ? "race" : "race_lost" });

const AXES = ["agent", "model", "harness"];
const MAX_LEGS = 8;
const isValues = (o) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length > 0 &&
  Object.entries(o).every(([k, v]) => AXES.includes(k) && typeof v === "string" && v);
// A leg's name is its values in axis order, so the same values always give the same name.
const legName = (leg) => AXES.filter((k) => leg[k] !== undefined).map((k) => leg[k]).join(", ");

// Expands `[refA, refB]` or `{agent|model|harness: [...], include, exclude, max_parallel}` (one axis) into
// `{legs: [{name, agent?, model?, harness?}], max_parallel}`, or null when the spec is invalid.
export function expandRace(spec) {
  const race = Array.isArray(spec) ? { agent: spec } : spec;
  const axes = AXES.filter((k) => race?.[k] !== undefined);
  const { include = [], exclude = [], max_parallel: max } = race ?? {};
  if (axes.length !== 1 || !Array.isArray(include) || !Array.isArray(exclude) || ![...include, ...exclude].every(isValues)) return null;
  const values = race[axes[0]];
  if (!Array.isArray(values) || !values.every((v) => typeof v === "string" && v)) return null;
  const matches = (leg, o) => Object.entries(o).every(([k, v]) => leg[k] === v);
  let legs = values.map((v) => ({ [axes[0]]: v }));
  // As in a CI matrix: an include matching a leg's axis value extends that leg, any other is a new leg.
  for (const inc of include) {
    const hit = legs.filter((l) => inc[axes[0]] === l[axes[0]]);
    if (hit.length) hit.forEach((l) => Object.assign(l, inc));
    else legs.push({ ...inc });
  }
  legs = legs.filter((l) => !exclude.some((e) => matches(l, e))).map((l) => ({ name: legName(l), ...l }));
  if (legs.length < 2 || legs.length > MAX_LEGS || new Set(legs.map((l) => l.name)).size !== legs.length) return null;
  if (max !== undefined && !(Number.isInteger(max) && max >= 1)) return null;
  return { legs, max_parallel: max ?? legs.length };
}

// Leases each planned leg's change and queues its develop job with leg `legs[i]`'s values. At most `max` legs develop
// at once, and never more than runners have free slots, since a runner only claims with a free slot.
// Legs take no symbol lease: they share one intent, and only the winner reaches the queue.
export async function startRace(env, changes, { legs: specs, max_parallel: max }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const legs = [];
  for (const [i, change] of changes.entries()) {
    const { name, ...leg } = specs[i];
    legs.push(await changeDO(env, change.id).transition("leased", raceEvent("leased", change.id)));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, ?)")
        .bind(crypto.randomUUID(), change.repo_id, change.id, now, JSON.stringify({ lease: [], wait_for: null, base: null, ...leg, race: id, max_parallel: max })),
      // race_legs.agent holds the leg name: the agent ref on an agent-axis race.
      env.DB.prepare("INSERT INTO race_legs (change_id, race_id, agent, started_at) VALUES (?, ?, ?, ?)").bind(change.id, id, name, now),
    ]);
  }
  return { id, changes: legs };
}

// Records a race leg's first verdict. Once both legs have one, the winner (first green, tie → cheaper) is queued and
// the loser closed. Returns true when `change` is a race leg, whose queueing is the race's to decide.
// leg {model, tokens, tests_passed, tests_total, p_merge, rpm, rpm_limit} is what the runner saw, rpm its peak requests a minute.
export async function settleLeg(env, change, pass, { cost_usd: cost = null, changed_lines: lines = null, new_deps: deps = null, review_findings: findings = null, leg: seen = {} }) {
  const leg = await env.DB.prepare("SELECT race_id, started_at FROM race_legs WHERE change_id = ?").bind(change.id).first();
  if (!leg) return false;
  const ms = Date.now() - Date.parse(leg.started_at);
  await env.DB.batch([
    env.DB.prepare("UPDATE race_legs SET verdict = ?, cost_usd = ?, changed_lines = ?, secs = ? WHERE change_id = ? AND verdict IS NULL")
      .bind(pass ? "pass" : "fail", cost, lines, Math.round(ms / 1000), change.id),
    env.DB.prepare("INSERT OR IGNORE INTO race_scores (change_id, new_deps, review_findings, duration_ms) VALUES (?, ?, ?, ?)").bind(change.id, deps, findings, ms),
    env.DB.prepare("INSERT OR IGNORE INTO race_leg_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(change.id,
      // A runner's value of the wrong type is dropped, not stored.
      ...["model", "tokens", "tests_passed", "tests_total", "p_merge", "rpm", "rpm_limit"].map((k, i) => ((i ? Number.isFinite(seen?.[k]) && seen[k] >= 0 : typeof seen?.[k] === "string") ? seen[k] : null))),
  ]);
  const { results: legs } = await env.DB.prepare("SELECT change_id, verdict, cost_usd, secs, won FROM race_legs WHERE race_id = ?").bind(leg.race_id).all();
  // A decided race lets its legs carry on as ordinary changes (both failed, or the winner re-verifying).
  if (legs.some((l) => l.won !== null)) return false;
  if (legs.some((l) => !l.verdict)) return true;
  const [winner] = legs.filter((l) => l.verdict === "pass").sort((a, b) => a.secs - b.secs || (a.cost_usd ?? Infinity) - (b.cost_usd ?? Infinity));
  // One statement, so of two concurrent reports only one decides.
  const { results: decided } = await env.DB.prepare("UPDATE race_legs SET won = (change_id IS ?) WHERE race_id = ? AND NOT EXISTS (SELECT 1 FROM race_legs WHERE race_id = ? AND won IS NOT NULL) RETURNING change_id")
    .bind(winner?.change_id ?? null, leg.race_id, leg.race_id).all();
  if (!decided.length || !winner) return true;
  await autoPromote(env);
  for (const l of legs.filter((l) => l !== winner)) {
    await changeDO(env, l.change_id).transition("closed", raceEvent("race_lost", l.change_id));
  }
  await enqueue(env, { ...change, id: winner.change_id });
  await queueMergeJob(env, change.repo_id, change.target_branch);
  return true;
}

// GET /api/races/:id → each leg's scorecard (shapes/race-scorecard.js).
export async function getScorecard(request, env, { id }) {
  const { results: legs } = await env.DB.prepare("SELECT l.change_id, agent AS leg, verdict, changed_lines AS diff_lines, new_deps, review_findings, cost_usd, duration_ms, won " +
    "FROM race_legs l LEFT JOIN race_scores s ON s.change_id = l.change_id WHERE race_id = ? ORDER BY agent").bind(id).all();
  return legs.length ? Response.json({ id, legs }) : error(404, "not_found", `no race ${id}`);
}

// GET /api/races?agent= → every race, or every race one of agent's legs ran in, newest first: {id, winner, legs} with
// winner the won leg's name (null until decided) and legs as in the scorecard (shapes/race-summary.js).
// lazy: unpaged, add a cursor on started_at past ~1k races.
export async function listRaces(request, env) {
  const agent = new URL(request.url).searchParams.get("agent") || null;
  const { results } = await env.DB.prepare("SELECT race_id, l.change_id, agent AS leg, verdict, changed_lines AS diff_lines, new_deps, review_findings, cost_usd, duration_ms, won, " +
    "started_at, model, tokens, tests_passed, tests_total, p_merge, rpm, rpm_limit FROM race_legs l LEFT JOIN race_scores s ON s.change_id = l.change_id LEFT JOIN race_leg_stats t ON t.change_id = l.change_id " +
    "WHERE race_id IN (SELECT race_id FROM race_legs WHERE ?1 IS NULL OR agent = ?1 OR substr(agent, 1, length(?1) + 1) = ?1 || '@') " +
    "ORDER BY started_at DESC, race_id, agent").bind(agent).all();
  const races = new Map();
  for (const { race_id: id, ...leg } of results) {
    const race = races.get(id) ?? races.set(id, { id, winner: null, legs: [] }).get(id);
    race.legs.push(leg);
    if (leg.won === 1) race.winner = leg.leg;
  }
  return Response.json([...races.values()]);
}

// POST /api/changes/:id/promote {leg} → the change, carrying leg's fork and head. Every other leg of change :id's race
// is closed and its jobs cancelled, and the leg's agent version scores race_won. Overrides an automatic decision.
export async function promoteLeg(request, env, { id }) {
  const body = await request.json().catch(() => null);
  if (typeof body?.leg !== "string" || !body.leg) return error(400, "bad_request", "leg must be a leg name");
  const { results: legs } = await env.DB.prepare("SELECT l.change_id, l.race_id, l.agent, h.head_sha FROM race_legs l LEFT JOIN change_heads h ON h.change_id = l.change_id " +
    "WHERE l.race_id = (SELECT race_id FROM race_legs WHERE change_id = ?)").bind(id).all();
  if (!legs.length) return error(404, "not_found", `change ${id} is not a race leg`);
  const leg = legs.find((l) => l.agent === body.leg);
  if (!leg) return error(404, "not_found", `no leg ${body.leg} in change ${id}'s race`);
  if (!leg.head_sha) return error(409, "no_head", `leg ${body.leg} has no head yet`);
  const stub = changeDO(env, id);
  const change = await stub.get();
  if (["merged", "closed", "failed"].includes(change.state)) return error(409, "illegal_transition", `cannot promote onto a ${change.state} change`);
  const others = legs.filter((l) => l.change_id !== id);
  // moveHead cancels the change's own jobs, which only a real head move should do.
  if (leg.change_id !== id) await stub.moveHead(leg.head_sha, (await changeDO(env, leg.change_id).get()).fork);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?1, ?2) ON CONFLICT DO UPDATE SET head_sha = ?2").bind(id, leg.head_sha),
    ...others.map((l) => env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE change_id = ? AND status IN ('queued', 'claimed')").bind(l.change_id)),
    env.DB.prepare("UPDATE race_legs SET won = (change_id = ?) WHERE race_id = ?").bind(leg.change_id, leg.race_id),
    // race_legs.agent is the leg name: the agent version on an agent-axis race.
    env.DB.prepare("INSERT INTO agent_outcomes (id, agent_version, outcome, change_id, at) VALUES (?, ?, 'race_won', ?, ?)")
      .bind(crypto.randomUUID(), leg.agent, id, new Date().toISOString()),
  ]);
  await autoPromote(env);
  // An already closed (or merged) leg refuses the transition and stays as it is.
  for (const l of others) await changeDO(env, l.change_id).transition("closed", raceEvent("race_lost", l.change_id));
  return Response.json(await stub.get());
}
