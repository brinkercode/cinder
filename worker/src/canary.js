import { trustOf } from "./calibration.js";
import { error, sha256 } from "./router.js";

// Per agent version: n changes it ran a job on that ended merged, failed or closed, merged of them merged.
const OUTCOMES = "SELECT agent_version, SUM(outcome = 'merged') AS merged, COUNT(*) AS n FROM agent_outcomes " +
  "WHERE outcome IN ('merged', 'failed', 'closed') GROUP BY agent_version";

// A change ended merged, failed or closed: scores that against every agent version its jobs ran as (a change that fails
// and later merges keeps its last outcome). Then, with the fleet's auto-promote on, each canary with at least the repo's
// trusted count of outcomes and a merge rate at least stable's becomes stable, its share reset to 0.
export async function settleAgents(env, change, outcome) {
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO agent_outcomes (id, agent_version, outcome, change_id, at) SELECT DISTINCT ?1 || ':' || v, v, ?2, ?1, ?3 " +
    "FROM (SELECT COALESCE(json_extract(payload, '$.agent_version'), json_extract(payload, '$.agent')) AS v FROM jobs WHERE change_id = ?1) " +
    "WHERE v GLOB '*@v[0-9]*' ON CONFLICT (id) DO UPDATE SET outcome = excluded.outcome, at = excluded.at").bind(change.id, outcome, at).run();
  if ((await env.DB.prepare("SELECT canary_auto_promote FROM fleet_settings").first("canary_auto_promote")) !== 1) return;
  const { min_outcomes } = await trustOf(env.DB, change.repo_id);
  const { results } = await env.DB.prepare(`WITH o AS (${OUTCOMES}) SELECT c.agent_name, c.version FROM channels c ` +
    "JOIN channels s ON s.agent_name = c.agent_name AND s.channel = 'stable' AND s.version <> c.version " +
    "JOIN o oc ON oc.agent_version = c.agent_name || '@v' || c.version LEFT JOIN o os ON os.agent_version = s.agent_name || '@v' || s.version " +
    "WHERE c.channel = 'canary' AND oc.n >= ? AND oc.merged * 1.0 / oc.n >= COALESCE(os.merged * 1.0 / os.n, 0)").bind(min_outcomes).all();
  for (const { agent_name: name, version } of results) {
    // The events are written only while stable still differs, so a concurrent settle promoting the same canary records one.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO agent_outcomes (id, agent_version, outcome, change_id, at) SELECT ?1, ?2, 'agent_promoted', ?3, ?4 " +
        "WHERE EXISTS (SELECT 1 FROM channels WHERE agent_name = ?5 AND channel = 'stable' AND version <> ?6)")
        .bind(crypto.randomUUID(), `${name}@v${version}`, change.id, at, name, version),
      env.DB.prepare("INSERT INTO agent_channel_events (id, agent_name, kind, version, share, by, at) SELECT ?1, ?2, 'promoted', ?3, NULL, 'auto-promote', ?4 " +
        "WHERE EXISTS (SELECT 1 FROM channels WHERE agent_name = ?2 AND channel = 'stable' AND version <> ?3)").bind(crypto.randomUUID(), name, version, at),
      env.DB.prepare("UPDATE channels SET version = ? WHERE agent_name = ? AND channel = 'stable'").bind(version, name),
      env.DB.prepare("UPDATE canary_shares SET share = 0 WHERE agent_name = ?").bind(name),
    ]);
  }
}

// GET /api/agents/:name/versions: each version with the channel pointing at it (stable when both do), the canary's share
// its merge outcomes, and its web setting with the web responses its jobs had converted to Markdown and the bytes that saved. trusted uses the default threshold: outcomes span repos, so no one repo's applies.
export async function agentVersions(request, env, { name }) {
  const { min_outcomes } = await trustOf(env.DB, null);
  const { results } = await env.DB.prepare(`WITH o AS (${OUTCOMES}) SELECT v.version, r.released_at, COALESCE(o.merged, 0) AS merged, COALESCE(o.n, 0) AS n, ` +
    "(SELECT channel FROM channels WHERE agent_name = v.name AND version = v.version ORDER BY channel = 'stable' DESC LIMIT 1) AS channel, " +
    "COALESCE((SELECT share FROM canary_shares WHERE agent_name = v.name), 0) AS share, COALESCE(w.web, 'raw') AS web, " +
    "(SELECT COALESCE(SUM(converted), 0) FROM job_web_usage WHERE agent_version = v.name || '@v' || v.version) AS converted, " +
    "(SELECT COALESCE(SUM(saved_bytes), 0) FROM job_web_usage WHERE agent_version = v.name || '@v' || v.version) AS saved_bytes FROM agent_versions v " +
    "LEFT JOIN agent_release_web w ON w.name = v.name AND w.version = v.version " +
    "LEFT JOIN agent_releases r ON r.name = v.name AND r.version = v.version LEFT JOIN o ON o.agent_version = v.name || '@v' || v.version " +
    "WHERE v.name = ? ORDER BY v.version").bind(name).all();
  if (!results.length) return error(404, "not_found", `no agent ${name}`);
  return Response.json(results.map((v) => ({ version: v.version, channel: v.channel, share: v.channel === "canary" ? v.share : 0,
    released_at: v.released_at, outcomes: { merged: v.merged, n: v.n, trusted: v.n >= min_outcomes },
    web: { mode: v.web, converted: v.converted, saved_bytes: v.saved_bytes } })));
}

// The agent a review or resolve job runs; develop's is pinned on its change when created, and a merge runs as its develop job did.
const AGENT_OF = { develop: "developer", review: "reviewer", resolve: "resolver" };

// {agent_version: "name@vN"}: the kind's agent's canary for its share of changes (a stable hash of the change id picks
// them), else its stable version, as of now, so a later promote or rollback moves only jobs queued after it; {} when the
// kind has no agent or the agent no version.
export async function channelAgent(env, kind, changeId) {
  const name = AGENT_OF[kind];
  if (!name) return {};
  const { results } = await env.DB.prepare("SELECT c.channel, c.version, COALESCE(s.share, 0) AS share FROM channels c " +
    "LEFT JOIN canary_shares s ON s.agent_name = c.agent_name WHERE c.agent_name = ?").bind(name).all();
  const canary = results.find((c) => c.channel === "canary");
  const bucket = new DataView((await sha256(changeId)).buffer).getUint32(0) % 100;
  const pick = canary && bucket < canary.share ? canary : results.find((c) => c.channel === "stable");
  return pick ? { agent_version: `${name}@v${pick.version}` } : {};
}
