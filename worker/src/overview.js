// The account behind the Repos page: GET /api/overview and PUT /api/account (api/shapes/overview.js).
import { WHEN_REACHED } from "./api/shapes/account.js";
import { ALERT_THRESHOLDS } from "./api/shapes/overview.js";
import { error } from "./router.js";

// The account row and its budget: this UTC month's tokens across every repo (archived ones too), reset on the 1st.
export async function accountOf(env) {
  const now = new Date();
  const [start, resets] = [0, 1].map((m) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1)).toISOString());
  const [account, spent] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM account WHERE id = 1"),
    env.DB.prepare("SELECT COALESCE(SUM(tokens), 0) AS n FROM usage_logs WHERE at >= ?").bind(start),
  ]);
  const row = account.results[0];
  return { row, start, budget: { tokens: row.budget_tokens, spent: spent.results[0].n, resets_at: resets, alerts: JSON.parse(row.alerts) } };
}

// This UTC month's model spend (usage_logs, the same rows the overview's budget and per-repo spend sum) against the
// budget: paused at or above it, unless the policy is alert only.
export async function budgetUse(db) {
  const { tokens, spent, when } = await db.prepare("SELECT budget_tokens AS tokens, (SELECT COALESCE(SUM(tokens), 0) FROM usage_logs WHERE at >= ?) AS spent, " +
    "COALESCE((SELECT when_reached FROM budget_policy WHERE id = 1), 'pause') AS \"when\" FROM account WHERE id = 1").bind(new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z").first();
  const now = new Date();
  return { tokens, spent, when, paused: when === "pause" && tokens !== null && spent >= tokens,
    resets_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() };
}

// GET /api/account → Account (api/shapes/account.js): the budget, this month's model spend, whether agent work is paused,
// the when-reached policy, when the month resets and the owners who can raise the budget (org.manage).
export async function getAccount(request, env) {
  const [{ tokens, spent, paused, when, resets_at }, { results }] = await Promise.all([budgetUse(env.DB), env.DB.prepare("SELECT email FROM person_roles WHERE role = 'owner'").all()]);
  const owners = [...new Set([...(env.OWNERS ?? "").split(",").map((o) => o.trim().toLowerCase()).filter(Boolean), ...results.map((r) => r.email)])];
  return Response.json({ budget_tokens: tokens, spent, paused, when_reached: when, resets_at, owners });
}

// GET /api/overview: agents counts claimed jobs with an unexpired lease; a repo never pushed to shows its creation time.
export async function getOverview(request, env) {
  const { row, start, budget } = await accountOf(env);
  const [repos, archived] = await env.DB.batch([
    env.DB.prepare(`SELECT id AS repo_id, COALESCE(m.description, '') AS description, m.language, COALESCE(m.pushed_at, created_at) AS pushed_at,
      (SELECT COUNT(*) FROM jobs j WHERE j.repo_id = repos.id AND j.status = 'claimed' AND j.lease_expires_at > ?1) AS agents,
      (SELECT COALESCE(SUM(tokens), 0) FROM usage_logs u WHERE u.repo_id = repos.id AND u.at >= ?2) AS spent
      FROM repos LEFT JOIN repo_meta m ON m.repo_id = repos.id WHERE m.archived_at IS NULL ORDER BY name`).bind(new Date().toISOString(), start),
    env.DB.prepare("SELECT name, archived_at FROM repos JOIN repo_meta m ON m.repo_id = repos.id WHERE archived_at IS NOT NULL ORDER BY name"),
  ]);
  return Response.json({
    account: { id: env.CF_ACCOUNT_ID ?? null, name: row.name, git_host: row.git_host ?? new URL(request.url).host },
    budget, repos: repos.results, archived: archived.results,
  });
}

// PUT /api/account {name?, git_host?, budget_tokens?: integer > 0 or null, alerts?: [10 to 100 in steps of 5], when_reached?: pause | alert}
// → 204: sets the keys sent. The router limits it to owners (org.manage).
export async function putAccount(request, env) {
  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return error(400, "bad_request", "expected a JSON object");
  const { name, git_host: host, budget_tokens: tokens, alerts, when_reached: when } = body;
  const errors = [];
  if (name !== undefined && !(typeof name === "string" && /^[^\r\n]{1,100}$/.test(name.trim()))) errors.push("name: expected 1-100 chars on one line");
  // A bare host, with an optional port: anything URL would read differently (a path, credentials) is refused.
  if (host !== undefined && !(typeof host === "string" && host !== "" && URL.parse(`https://${host}`)?.host === host.toLowerCase())) errors.push("git_host: expected a host name");
  if (tokens !== undefined && !(tokens === null || (Number.isInteger(tokens) && tokens > 0))) errors.push("budget_tokens: expected null or an integer > 0");
  if (alerts !== undefined && !(Array.isArray(alerts) && alerts.every((t) => ALERT_THRESHOLDS.includes(t)))) errors.push("alerts: expected an array of 10 to 100 in steps of 5");
  if (when !== undefined && !WHEN_REACHED.includes(when)) errors.push(`when_reached: expected one of ${WHEN_REACHED.join(", ")}`);
  if (errors.length) return error(400, "bad_request", errors.join("; "));
  const sets = Object.entries({
    name: name?.trim(), git_host: host?.toLowerCase(), budget_tokens: tokens, alerts: alerts && JSON.stringify([...new Set(alerts)].sort((a, b) => a - b)),
  }).filter(([, v]) => v !== undefined);
  if (sets.length) await env.DB.prepare(`UPDATE account SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = 1`).bind(...sets.map(([, v]) => v)).run();
  if (when) await env.DB.prepare("INSERT INTO budget_policy VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET when_reached = excluded.when_reached").bind(when).run();
  return new Response(null, { status: 204 });
}
