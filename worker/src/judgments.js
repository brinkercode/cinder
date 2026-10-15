import { JUDGMENT_KINDS, KIND_QUESTIONS } from "./api/contract.js";
import { brierByWeek, calibrate, trustOf } from "./calibration.js";
import { binding } from "./keystore.js";
import { error, hex, sha256 } from "./router.js";
import { BACKENDS, CLEF_MODELS, JEV_BASE_URL, createS1Client, isPinnedModel } from "./s1/client.js";
import { notify } from "./webhooks.js";
import { clearNeeds, raiseNeeds } from "./needs.js";

// repo is the repo id. Returns the new judgment id.
export async function recordJudgment(db, { repo, change = null, kind, backend, model, state_hash, question, answer, p }) {
  if (!JUDGMENT_KINDS.includes(kind)) throw new Error(`unknown judgment kind ${kind}`);
  const id = crypto.randomUUID();
  await db.batch([db.prepare(
    "INSERT INTO judgments (id, repo_id, change_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, repo, change, kind, backend, model, state_hash, question, answer, p, new Date().toISOString()),
  ...(change ? [db.prepare("INSERT INTO change_search (change_id, source, text) VALUES (?, 'question', ?)").bind(change, question)] : [])]);
  if (kind === "risk" && change) await syncDisagreement(db, repo, change);
  return id;
}

// Each judge's latest risk judgment on change reads as risky (answer high, or yes with p over 0.5) or not. One of
// each raises a Judges disagree need; agreement again clears it.
async function syncDisagreement(db, repo, change) {
  const { results } = await db.prepare("SELECT backend, answer = 'high' OR (answer = 'yes' AND probability > 0.5) AS risky FROM judgments j " +
    "WHERE change_id = ? AND kind = 'risk' AND made_at = (SELECT max(made_at) FROM judgments WHERE change_id = j.change_id AND kind = 'risk' AND backend = j.backend)")
    .bind(change).all();
  const risky = results.find((r) => r.risky);
  const safe = results.find((r) => !r.risky);
  const text = risky && safe && `${risky.backend} judges change ${change} risky, ${safe.backend} judges it safe. A human call breaks the tie.`;
  await clearNeeds(db, "Judges disagree", repo, change, text ? [text] : []);
  if (text) await raiseNeeds(db, repo, [{ kind: "Judges disagree", change, text, actions: ["Merge", "Reject", "Open change"] }]);
}

// Humans and agents judge risk like any model judge: p that the change gets reverted, scored by the same outcome.
const RISK_P = { low: 0.1, medium: 0.5, high: 0.9 };
const riskJudgment = (change, backend, model, risk) => ({
  repo: change.repo_id, change: change.id, kind: "risk", backend, model, state_hash: change.id,
  question: "will this change be reverted?", answer: "yes", p: RISK_P[risk],
});

// change: { id, repo_id }. A failing review reads as high risk, a passing one as low.
export function recordVerdict(db, change, { agent, version, person, verdict }) {
  if (verdict !== "pass" && verdict !== "fail") throw new Error(`unknown verdict ${verdict}`);
  const backend = person ? `human:${person}` : `agent:${agent}@${version}`;
  return recordJudgment(db, riskJudgment(change, backend, backend, verdict === "fail" ? "high" : "low"));
}

// reverted: "yes" | "no". Scores every open risk judgment on the change, whoever made it.
export async function recordRiskOutcome(db, change_id, reverted, observed_at) {
  await db.prepare(
    "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, ?2, answer = ?2, ?3 FROM judgments " +
    "WHERE change_id = ?1 AND kind = 'risk' AND id NOT IN (SELECT judgment_id FROM outcomes)",
  ).bind(change_id, reverted, observed_at).run();
}

// On a change's merge at `at`: a merged change its intent names (a revert or follow-up fix) within 14 days of that
// merge is risky ("yes"); risk judgments still open on changes merged over 14 days ago are safe ("no").
// lazy: the safe sweep runs on the repo's next merge, so a quiet repo's outcomes wait; add a cron trigger if that matters.
export async function scoreMerge(db, change, at) {
  const since = new Date(Date.parse(at) - 14 * 86400000).toISOString();
  await db.prepare("INSERT OR IGNORE INTO change_merges (change_id, repo_id, merged_at) VALUES (?, ?, ?)").bind(change.id, change.repo_id, at).run();
  const { results } = await db.prepare("SELECT change_id AS id FROM change_merges WHERE repo_id = ? AND change_id <> ? AND merged_at >= ? AND instr(?, change_id) > 0")
    .bind(change.repo_id, change.id, since, change.intent ?? "").all();
  for (const { id } of results) await recordRiskOutcome(db, id, "yes", at);
  // Merged whole and clean: an open split judgment proved right only if it said no, an open guard judgment only if it saw no
  // hazard. lazy: a secret found after the merge doesn't re-score the guard; score reverts for a secret once they're detected.
  await db.prepare(
    "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, 'no', answer = 'no', ?2 FROM judgments " +
    "WHERE change_id = ?1 AND kind IN ('split', 'guard') AND id NOT IN (SELECT judgment_id FROM outcomes)",
  ).bind(change.id, at).run();
  await db.prepare(
    "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT j.id, 'no', j.answer = 'no', ?3 FROM judgments j " +
    "JOIN change_merges m ON m.change_id = j.change_id WHERE m.repo_id = ?1 AND m.merged_at < ?2 AND j.kind = 'risk' AND j.id NOT IN (SELECT judgment_id FROM outcomes)",
  ).bind(change.repo_id, since, at).run();
}

// Judges earn trust in shadow: every answer is recorded, acted on or not, and scored against what happened under the
// default action. A change cinder stacked after a collision verified: its seam judgment proved right ("yes") when either
// side wrote a collided symbol's signature, i.e. the overlap was an interface both needed changed; else "no".
export async function scoreSeam(db, changeId, at) {
  await db.prepare(
    "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, actual, answer = actual, ?2 FROM (SELECT id, answer, " +
    "IIF(EXISTS (SELECT 1 FROM collisions c JOIN change_writes w ON w.symbol = c.symbol AND w.change_id IN (c.ours, c.theirs) " +
    "WHERE c.ours = ?1 AND w.kind = 'signature'), 'yes', 'no') AS actual FROM judgments " +
    "WHERE change_id = ?1 AND kind = 'seam' AND id NOT IN (SELECT judgment_id FROM outcomes))",
  ).bind(changeId, at).run();
}

// A collision judgment on change A about change B asks this question; either direction counts as the pair (A, B).
export const collisionQuestion = (id) => `Will this change collide with ${id}?`;
export const COLLISION_GUIDE = "The target branch moved because that change merged. The state holds this change's intent, how many commits it is " +
  "behind the target, and overlap: the symbols both changes leased. Answer yes when rebasing this change onto the new target will conflict " +
  "textually or break behaviour it relies on: both edit the bodies of overlapping symbols, or the merged change renamed, removed or re-typed " +
  "something this change calls. Answer no when overlap is empty or only shared reads, or when it is behind only on unrelated files.";

// A merge-tree probe of change against a target holding theirs: collided is "yes" | "no". Scores the open collision
// judgments of each pair, but only while no judgment of that pair has an outcome yet.
export async function recordCollisionOutcomes(db, change_id, theirs, collided, observed_at) {
  for (const b of theirs) {
    await db.prepare(
      "WITH pair AS (SELECT id, answer FROM judgments WHERE kind = 'collision' AND ((change_id = ?1 AND question = ?2) OR (change_id = ?3 AND question = ?4))) " +
      "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, ?5, answer = ?5, ?6 FROM pair " +
      "WHERE NOT EXISTS (SELECT 1 FROM outcomes WHERE judgment_id IN (SELECT id FROM pair))",
    ).bind(change_id, collisionQuestion(b), b, collisionQuestion(change_id), collided, observed_at).run();
  }
}

// label is what reality answered; the outcome is correct when it equals the judgment's answer.
// outcomes.judgment_id is the primary key, so a second outcome for one judgment throws.
export async function recordOutcome(db, judgment_id, label, observed_at) {
  const { meta } = await db.prepare(
    "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, ?2, answer = ?2, ?3 FROM judgments WHERE id = ?1",
  ).bind(judgment_id, label, observed_at).run();
  if (meta.changes !== 1) throw new Error(`no judgment ${judgment_id}`);
}

// One entry per configured judge (one per kind); a new model version starts a new series, kept as that judge's history.
export async function listJudges(request, env, { name }) {
  const repo = await env.DB.prepare(
    "SELECT r.id, a.repo_id IS NOT NULL AS airlock FROM repos r LEFT JOIN airlock_repos a ON a.repo_id = r.id WHERE r.name = ?",
  ).bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  // ?weeks= (1 to 52) windows count, bins, brier and the weekly trend to the last N weeks; omitted, they're all time with a
  // 12-week trend. Trust (trusted, total) is always all time.
  const asked = new URL(request.url).searchParams.get("weeks");
  const weeks = Math.min(Math.max(Math.trunc(+asked) || 12, 1), 52);
  const { results } = await env.DB.prepare(
    "SELECT j.kind, j.backend, j.model_version, j.probability AS p, o.correct AS y, o.observed_at, j.change_id IS NULL AS inherited FROM judgments j JOIN outcomes o ON o.judgment_id = j.id " +
    "WHERE j.repo_id = ? ORDER BY j.kind, j.backend, j.model_version",
  ).bind(repo.id).all();
  // When each series ran.
  const { results: spans } = await env.DB.prepare(
    "SELECT kind, backend, model_version, MIN(made_at) AS since, MAX(made_at) AS until FROM judgments WHERE repo_id = ? GROUP BY 1, 2, 3",
  ).bind(repo.id).all();
  // Calls that fell back to the kind's default verdict in the last 7 days, newest reason first.
  const { results: failures } = await env.DB.prepare(
    "SELECT kind, backend, model_version, reason, count FROM judge_failures WHERE repo_id = ? AND last_at >= ? ORDER BY last_at DESC",
  ).bind(repo.id, new Date(Date.now() - 7 * 86400e3).toISOString()).all();
  // The ten newest verdicts per series, scored or still pending; inherited ones have no change. agent is the agent@version
  // that wrote the change, null for a person's.
  const { results: verdicts } = await env.DB.prepare(
    "SELECT kind, backend, model_version, change_id, p, correct, agent, made_at FROM (SELECT j.kind, j.backend, j.model_version, j.change_id, j.probability AS p, o.correct, j.made_at, " +
    "json_extract(c.card, '$.agent') || '@' || json_extract(c.card, '$.ver') AS agent, " +
    "ROW_NUMBER() OVER (PARTITION BY j.kind, j.backend, j.model_version ORDER BY j.made_at DESC, j.id) AS n " +
    "FROM judgments j LEFT JOIN outcomes o ON o.judgment_id = j.id LEFT JOIN change_cards c ON c.change_id = j.change_id WHERE j.repo_id = ?) WHERE n <= 10 ORDER BY n",
  ).bind(repo.id).all();
  const trust = await trustOf(env.DB, repo.id);
  const { results: configs } = await env.DB.prepare("SELECT c.kind, c.backend, c.model_version, coalesce(s.airlock, 0) AS airlock, s.min_outcomes, s.min_confidence FROM judge_config c " +
    "LEFT JOIN judge_settings s ON s.repo_id = c.repo_id AND s.kind = c.kind WHERE c.repo_id = ?")
    .bind(repo.id).all();
  const key = (r) => JSON.stringify([r.kind, r.backend, r.model_version]);
  const series = Map.groupBy(results, key);
  const span = new Map(spans.map((s) => [key(s), s]));
  // A series' calibration, fallbacks and newest verdicts.
  const row = ([kind, backend, model_version], cfg) => {
    const k = key({ kind, backend, model_version });
    const pairs = series.get(k) ?? [];
    const all = calibrate(pairs, cfg?.min_outcomes ?? trust.min_outcomes), trend = brierByWeek(pairs, weeks);
    const { count, brier, bins } = asked ? calibrate(pairs.filter((r) => r.observed_at >= trend[0].week), 0) : all;
    const fell = failures.filter((f) => f.kind === kind && f.backend === backend && f.model_version === model_version);
    const fallbacks = fell.reduce((n, f) => n + f.count, 0);
    // lazy: answered calls aren't counted, so outcomes stand in for them; failing once defaults reach the scored verdicts.
    const health = !fallbacks ? "healthy" : fallbacks < all.count ? "degraded" : "failing";
    const recent = verdicts.filter((v) => v.kind === kind && v.backend === backend && v.model_version === model_version)
      .map((v) => ({ repo: name, change_id: v.change_id, p: v.p, correct: v.correct === null ? null : v.correct === 1, made_at: v.made_at, ...(v.agent && { agent: v.agent }) }));
    return { kind, backend, model_version, question: KIND_QUESTIONS[kind], count, total: all.count, trusted: all.trusted, brier, bins, since: span.get(k)?.since ?? null,
      // Imported history has no change (as in recent); lazy: a live judgment made without a change counts too, until judgments record their source.
      inherited: pairs.filter((r) => r.inherited).length, trend, health, reason: fell[0]?.reason ?? null, fallbacks, recent, config: cfg ? configOf(cfg) : null };
  };
  const reviewer = (k) => /^(human|agent):/.test(JSON.parse(k)[1]);
  // One entry per configured judge, listed before its first outcome with count 0, plus each person or agent reviewer whose
  // verdicts are scored. A model series of a configured kind that isn't its current one (a model it ran before a swap)
  // rides along as that judge's history; one of a kind no judge is configured for is left out.
  const judges = [...configs.map((cfg) => ({ ...row([cfg.kind, cfg.backend, cfg.model_version], cfg),
    history: [...series.keys()].filter((k) => k !== key(cfg) && !reviewer(k) && JSON.parse(k)[0] === cfg.kind).map((k) => {
      const { backend, model_version, count, trusted, brier, bins, since, trend } = row(JSON.parse(k), cfg);
      return { backend, model_version, count, trusted, brier, bins, since, until: span.get(k).until, trend };
    }) })),
  ...[...series.keys()].filter(reviewer).map((k) => row(JSON.parse(k)))];
  return Response.json({ airlock: isAirlocked(env, repo), trust, judges });
}

const configOf = (c) => ({ kind: c.kind, airlock: c.airlock === 1, min_outcomes: c.min_outcomes, min_confidence: c.min_confidence });

// Airlock is on globally (env AIRLOCK = "true") or for the repo.
const isAirlocked = (env, repo) => env.AIRLOCK === "true" || repo.airlock === 1;

export async function stateHash(state) {
  return `sha256:${hex(await sha256(JSON.stringify(state)))}`;
}

// Asks the backend configured for (repo, kind), records each answer and returns { [question]: { answer, p, trusted } }
// with p calibrated on that (kind, backend, model_version) series. trusted is false while the series has too few
// outcomes, when the kind has no backend configured, airlock refuses it or the backend fails: the caller then applies the kind's safe default.
// A judge in its own airlock scores and records as usual, but its answers are never trusted; below its min_confidence it abstains.
// A refused or failed call is never silent: each answer carries the reason, which is logged and counted in judge_failures.
export async function judge(env, repo, kind, state, questions, change) {
  const results = Object.fromEntries(Object.keys(questions).map((n) => [n, { answer: null, p: null, trusted: false }]));
  const cfg = await env.DB.prepare(
    "SELECT c.backend, c.model_version, c.base_url, s.airlock AS judge_airlock, s.min_outcomes, s.min_confidence, a.repo_id IS NOT NULL AS airlock FROM judge_config c " +
    "LEFT JOIN judge_settings s ON s.repo_id = c.repo_id AND s.kind = c.kind LEFT JOIN airlock_repos a ON a.repo_id = c.repo_id WHERE c.repo_id = ? AND c.kind = ?",
  ).bind(repo, kind).first();
  if (!cfg) return results;
  // jev's TypeSafe key is the Keystore's unexpired TYPESAFE_API_KEY: the repo's own, else the global one. The global key
  // goes to the default base URL only: a repo's base_url is set on that repo, so it gets the repo's own key or none.
  const keyId = cfg.backend === "jev" && await env.DB.prepare("SELECT id FROM keystore_secrets WHERE name = 'TYPESAFE_API_KEY' AND " +
    "((scope = 'global' AND coalesce(?3, ?4) = ?4) OR (scope = 'repo' AND repo = (SELECT name FROM repos WHERE id = ?1))) AND (expires_at IS NULL OR expires_at > ?2) ORDER BY scope = 'global' LIMIT 1")
    .bind(repo, new Date().toISOString(), cfg.base_url, JEV_BASE_URL).first("id");
  let client, res;
  try {
    client = createS1Client({ backend: cfg.backend, model: cfg.model_version, env, baseUrl: cfg.base_url ?? undefined,
      apiKey: keyId ? await env.SECRETS.read(binding(keyId)) : undefined,
      metadata: { repo, ...(change && { change }) }, airlock: isAirlocked(env, cfg) });
  } catch (err) {
    // A backend that can't be built (e.g. the clef default without an AI binding) falls back like a failed call.
    res = { ok: false, error: err.message };
  }
  res ??= await client.ask(state, questions);
  if (!res.ok) {
    console.warn(`judge ${kind}: untrusted default: ${res.error}`);
    await env.DB.prepare(
      "INSERT INTO judge_failures (repo_id, kind, backend, model_version, reason, count, last_at) VALUES (?, ?, ?, ?, ?, 1, ?) " +
      "ON CONFLICT (repo_id, kind, backend, model_version, reason) DO UPDATE SET count = count + 1, last_at = excluded.last_at",
    ).bind(repo, kind, cfg.backend, cfg.model_version, res.error, new Date().toISOString()).run();
    for (const r of Object.values(results)) r.reason = res.error;
    return results;
  }
  const { results: pairs } = await env.DB.prepare(
    "SELECT j.probability AS p, o.correct AS y FROM judgments j JOIN outcomes o ON o.judgment_id = j.id " +
    "WHERE j.repo_id = ? AND j.kind = ? AND j.backend = ? AND j.model_version = ?",
  ).bind(repo, kind, cfg.backend, cfg.model_version).all();
  const { trusted, calibrated } = calibrate(pairs, cfg.min_outcomes ?? (await trustOf(env.DB, repo)).min_outcomes);
  const state_hash = await stateHash(state);
  for (const name of Object.keys(questions)) {
    // A score is P(yes); a choice maps options to probabilities. Either way the answer is the likeliest one.
    const a = res.answers[name];
    const entries = typeof a === "number" ? [["yes", a], ["no", 1 - a]] : Object.entries(a ?? {});
    const [answer, p] = entries.reduce((best, e) => (e[1] > best[1] ? e : best), [null, -1]);
    if (answer === null || !(p >= 0 && p <= 1) || p < (cfg.min_confidence ?? 0)) continue;
    const id = await recordJudgment(env.DB, { repo, change, kind, backend: cfg.backend, model: cfg.model_version, state_hash, question: questions[name].prompt, answer, p });
    await notify(env, repo, "judgment", { id, change_id: change ?? null, kind, question: questions[name].prompt, answer, p });
    results[name] = { answer, p: calibrated(p), trusted: trusted && !cfg.judge_airlock };
  }
  return results;
}

const repoIdOf = async (env, name) => (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first())?.id;

// PUT /api/repos/:name/airlock {on}: airlock on keeps the repo's judges on AIRLOCK_BACKENDS from the next judgment.
export async function putAirlock(request, env, { name }) {
  const body = await request.json().catch(() => null);
  if (typeof body?.on !== "boolean") return error(400, "invalid_airlock", "on: expected boolean");
  const repo = await repoIdOf(env, name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const sql = body.on ? "INSERT OR IGNORE INTO airlock_repos (repo_id) VALUES (?)" : "DELETE FROM airlock_repos WHERE repo_id = ?";
  await env.DB.prepare(sql).bind(repo).run();
  return Response.json({ airlock: body.on });
}

// A judge setting's errors: the backend and pinned model that answer kind, base_url (https, required for systemone-http), and the
// optional min_outcomes (integer >= 1) and min_confidence (0..1).
function judgeErrors(kind, body) {
  const errors = [];
  if (!JUDGMENT_KINDS.includes(kind)) errors.push(`kind: expected one of ${JUDGMENT_KINDS.join(", ")}`);
  if (!BACKENDS.includes(body?.backend)) errors.push(`backend: expected one of ${BACKENDS.join(", ")}`);
  if (!isPinnedModel(body?.model_version)) errors.push("model_version: expected name@version, not latest");
  else if (["clef", "clef-flash"].includes(body.backend) && !Object.hasOwn(CLEF_MODELS, body.model_version)) errors.push(`model_version: expected one of ${Object.keys(CLEF_MODELS).join(", ")}`);
  const baseUrl = body?.base_url ?? null;
  if (baseUrl !== null && !(/^https:\/\//.test(baseUrl) && URL.canParse(baseUrl))) errors.push("base_url: expected an https URL");
  if (body?.backend === "systemone-http" && baseUrl === null) errors.push("base_url: required for systemone-http");
  if (body?.min_outcomes != null && !(Number.isInteger(body.min_outcomes) && body.min_outcomes >= 1)) errors.push("min_outcomes: expected integer >= 1");
  if (body?.min_confidence != null && !(typeof body.min_confidence === "number" && body.min_confidence >= 0 && body.min_confidence <= 1)) errors.push("min_confidence: expected 0..1");
  return errors;
}

// Two statements, for one batch. A kind configured for the first time starts in airlock; changing it keeps its airlock as it was.
const saveJudge = (db, repo, kind, b) => [db.prepare(
  "INSERT INTO judge_settings (repo_id, kind, airlock, min_outcomes, min_confidence) VALUES (?1, ?2, NOT EXISTS (SELECT 1 FROM judge_config WHERE repo_id = ?1 AND kind = ?2), ?3, ?4) " +
  "ON CONFLICT (repo_id, kind) DO UPDATE SET min_outcomes = excluded.min_outcomes, min_confidence = excluded.min_confidence",
).bind(repo, kind, b.min_outcomes ?? null, b.min_confidence ?? null),
db.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version, base_url) VALUES (?, ?, ?, ?, ?)")
  .bind(repo, kind, b.backend, b.model_version, b.base_url ?? null)];

// PUT /api/repos/:name/judges/:kind {backend, model_version, base_url?, min_outcomes?, min_confidence?}: which backend and pinned model answer the kind.
export async function putJudge(request, env, { name, kind }) {
  const body = await request.json().catch(() => null);
  const errors = judgeErrors(kind, body);
  if (errors.length) return error(400, "invalid_judge", errors.join("; "));
  const repo = await repoIdOf(env, name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  await env.DB.batch(saveJudge(env.DB, repo, kind, body));
  return Response.json({ kind, backend: body.backend, model_version: body.model_version, base_url: body.base_url ?? null });
}

// PUT /api/repos/:name/judges/:kind/airlock {on}: from its next judgment the kind's judge still scores, but its verdict counts only with airlock off.
export async function putJudgeAirlock(request, env, { name, kind }) {
  const body = await request.json().catch(() => null);
  if (typeof body?.on !== "boolean") return error(400, "invalid_airlock", "on: expected boolean");
  const repo = await repoIdOf(env, name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const row = await env.DB.prepare("INSERT INTO judge_settings (repo_id, kind, airlock) SELECT repo_id, kind, ?1 FROM judge_config WHERE repo_id = ?2 AND kind = ?3 " +
    "ON CONFLICT (repo_id, kind) DO UPDATE SET airlock = excluded.airlock RETURNING kind, airlock, min_outcomes, min_confidence").bind(body.on ? 1 : 0, repo, kind).first();
  if (!row) return error(404, "not_found", `no ${kind} judge on ${name}`);
  return Response.json(configOf(row));
}

// .cinder.yml's `judges` map ({kind: {backend, model_version, base_url?, min_outcomes?, min_confidence?}}) onto judge_config and judge_settings, so a
// merged change that adds or swaps a judge takes effect. Kinds it leaves out keep their setting. Throws on any bad entry, before writing.
export async function syncJudges(env, name, judges) {
  if (judges == null) return;
  if (typeof judges !== "object" || Array.isArray(judges)) throw new Error(".cinder.yml: judges: expected a map of judgment kinds");
  const num = (v) => (v == null ? null : Number(v)); // parseYaml leaves scalars as strings
  const entries = Object.entries(judges).map(([kind, j]) => [kind, { ...j, min_outcomes: num(j?.min_outcomes), min_confidence: num(j?.min_confidence) }]);
  const errors = entries.flatMap(([kind, j]) => judgeErrors(kind, j).map((e) => `judges.${kind}: ${e}`));
  if (errors.length) throw new Error(`.cinder.yml: ${errors.join("; ")}`);
  const repo = await repoIdOf(env, name);
  if (repo && entries.length) await env.DB.batch(entries.flatMap(([kind, j]) => saveJudge(env.DB, repo, kind, j)));
}
