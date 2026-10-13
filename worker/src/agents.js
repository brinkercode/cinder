import { error } from "./router.js";
import { personOf } from "./access.js";
import { activeAccount, gitAdmin } from "./accounts.js";
import { AGENT_CHANNELS, DEFAULT_EGRESS, validateAgentVersion, validateTokenLimits } from "./api/contract.js";
import { createArtifacts } from "./artifacts.js";
import { getFleet, modelHarnesses } from "./fleet.js";
import { commit } from "./git/index.js";
import { onPushes } from "./pushes.js";
import { hex, sha256 } from "./router.js";

// lazy: the agents repo is addressed by name, not a repos row id; look it up once it is registered as a repo.
export const AGENTS_REPO = "cinder-agents";
const AGENT_NAME = /^[a-z0-9-]{1,63}$/;
const REF = /^(draft|[1-9]\d*)$/;
// An egress host pattern (runner/internal/egress, path.Match over a lowercased hostname). Without "[" or a backslash every one is well-formed.
export const HOST_PATTERN = /^[a-z0-9*?.-]{1,253}$/;
const FIELDS = ["harness", "model", "effort", "tools", "egress", "web", "limits.max_cost_usd", "limits.max_minutes"];
export { DEFAULT_EGRESS };
// Public code hosts (owner-set) whose Go modules the proxy, sumdb and pkg.go.dev may fetch for any job; a module on any
// other host must be on the job's allowlist, since those services fetch whatever origin a module path names.
export const GO_MODULE_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "golang.org", "google.golang.org", "gopkg.in", "go.googlesource.com", "honnef.co", "go.uber.org", "go.opentelemetry.io", "k8s.io", "sigs.k8s.io"];

// lazy: one-line prompts; bundle agents/*/prompt.md once the Worker build can import Markdown.
const BAKED_IN = {
  developer: "You are cinder's developer. Meet the change's acceptance with the smallest change that works and a test that proves it.\n",
  reviewer: "You are cinder's reviewer. Review one change's diff against its intent; report blockers, each with a repro command.\n",
  resolver: "You are cinder's resolver. Resolve one merge conflict between a change and the target it fell behind, keeping both intents.\n",
};
const BAKED_LOCK = { version: 1, harness: "claude-code", model: "claude-opus-5-5", effort: "default", tools: [],
  limits: { max_cost_usd: 8, max_minutes: 120 }, egress: DEFAULT_EGRESS, egress_mode: "enforce" };

const READY_WAIT_MS = 60_000;
const STUCK_MS = 10 * 60_000;
let bootstrapping = null;

// A fresh deploy (no agent version recorded) creates cinder-agents, commits each baked-in agent tagged agent/<name>/v1
// with its lock as the message, records it as the push event would and makes it stable. Callers in one isolate share one
// bootstrap; across isolates the agents_bootstrap row lock lets one run and the rest go on without it, so claims run the
// built-in default agent until the repo is ready. Failures are logged and retried by the next call, never thrown.
export async function ensureAgentsRepo(env) {
  if (await env.DB.prepare("SELECT 1 FROM agent_versions LIMIT 1").first()) return;
  bootstrapping ??= bootstrapAgents(env).finally(() => { bootstrapping = null; });
  return bootstrapping;
}

async function bootstrapAgents(env) {
  const now = Date.now();
  // The lock outlives the ready wait, so a holder that died frees it.
  const lock = await env.DB.prepare("INSERT INTO agents_bootstrap (id, locked_until) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET locked_until = ?1 " +
    "WHERE locked_until IS NULL OR locked_until < ?2 RETURNING created_at").bind(now + 2 * READY_WAIT_MS, now).first();
  if (!lock) return;
  try {
    const artifacts = createArtifacts(env.ARTIFACTS);
    // Artifacts creates repos asynchronously: get() rejects "being created" until the repo is ready.
    const get = () => artifacts.get(AGENTS_REPO).catch((e) => {
      if (/being created/.test(e?.message)) return "creating";
      throw e;
    });
    const created = (at) => env.DB.prepare("UPDATE agents_bootstrap SET created_at = ? WHERE id = 1").bind(at).run();
    // null when the new repo isn't ready within READY_WAIT_MS.
    const create = async () => {
      await artifacts.create(AGENTS_REPO);
      await created(Date.now());
      for (let wait = 250, start = Date.now(); ; wait *= 2) {
        const repo = await get();
        if (repo !== "creating") return repo;
        if (Date.now() - start > READY_WAIT_MS) return null;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    };
    let repo = await get();
    if (repo === "creating") {
      // A repo first seen creating (made by an older deploy) starts its stuck clock now.
      if (lock.created_at === null) await created(now);
      if (lock.created_at === null || now - lock.created_at < STUCK_MS) return;
      console.warn(`cinder-agents stuck creating since ${new Date(lock.created_at).toISOString()}; deleting and recreating it`);
      await artifacts.delete(AGENTS_REPO);
      repo = await create();
    } else repo ??= await create();
    if (!repo) return;
    let base = null;
    for (const [name, prompt] of Object.entries(BAKED_IN)) {
      const message = JSON.stringify({ name, ...BAKED_LOCK, prompt_hash: `sha256:${hex(await sha256(prompt))}` });
      const tag = `agent/${name}/v1`;
      ({ sha: base } = await commit(repo, { branch: "main", base, message, tag, author: { name: "cinder", email: "cinder@cinder" },
        changes: [{ path: `agents/${name}/prompt.md`, content: prompt }] }));
      await onPushes({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: AGENTS_REPO }, payload: { ref: `refs/tags/${tag}`, after: base, commits: [{ message }] } } }] }, env);
      // The push points canary at a first release; a baked-in version is stable, with no canary to race it.
      await env.DB.prepare("UPDATE channels SET channel = 'stable' WHERE agent_name = ? AND channel = 'canary' AND version = 1").bind(name).run();
    }
  } catch (e) {
    if (e.code !== "conflict") console.error(`cinder-agents bootstrap failed: ${e.message}`);
  } finally {
    await env.DB.prepare("UPDATE agents_bootstrap SET locked_until = NULL WHERE id = 1").run();
  }
}

// name = null reads every agent. lazy: no paging; add it once the registry outgrows one response.
async function agents(env, name = null) {
  // Race legs name their agent version name@vN; races counts decided legs, so wins / races is the win rate. runs counts the
  // changes a version wrote; decided ones ended merged, failed or closed, so merged / decided is its p(merge).
  // lazy: each count scans change_cards; index the card's agent@ver past ~10k changes.
  const card = "FROM change_cards WHERE json_extract(card, '$.agent') = v.name AND json_extract(card, '$.ver') = 'v' || v.version";
  const { results: versions } = await env.DB.prepare(
    "SELECT v.*, r.egress, r.released_at, (SELECT COUNT(won) FROM race_legs WHERE agent = v.name || '@v' || v.version) AS races, " +
    "(SELECT COUNT(*) FROM race_legs WHERE agent = v.name || '@v' || v.version AND won = 1) AS wins, " +
    `(SELECT COUNT(*) ${card}) AS runs, (SELECT COUNT(*) ${card} AND json_extract(card, '$.state') = 'merged') AS merged, ` +
    `(SELECT COUNT(*) ${card} AND json_extract(card, '$.state') IN ('merged', 'failed', 'closed')) AS decided ` +
    "FROM agent_versions v LEFT JOIN agent_releases r ON r.name = v.name AND r.version = v.version WHERE ?1 IS NULL OR v.name = ?1 ORDER BY v.name, v.version",
  ).bind(name).all();
  const { results: channels } = await env.DB.prepare("SELECT agent_name, channel, version FROM channels WHERE ?1 IS NULL OR agent_name = ?1 ORDER BY agent_name, channel")
    .bind(name).all();
  const byName = new Map();
  for (const v of versions) {
    if (!byName.has(v.name)) byName.set(v.name, { name: v.name, versions: [], channels: [] });
    byName.get(v.name).versions.push({ ...v, tools: JSON.parse(v.tools), limits: JSON.parse(v.limits), egress: v.egress && JSON.parse(v.egress) });
  }
  for (const c of channels) byName.get(c.agent_name)?.channels.push({ channel: c.channel, version: c.version });
  return byName;
}

export async function listAgents(request, env) {
  await ensureAgentsRepo(env);
  return Response.json([...(await agents(env)).values()]);
}

export async function getAgent(request, env, { name }) {
  const agent = (await agents(env, name)).get(name);
  if (!agent) return error(404, "not_found", `no agent ${name}`);
  // ?version's prompt (stable's, else the newest's, by default, the version the Agents page shows); null when its tag has no prompt.
  const version = new URL(request.url).searchParams.get("version") ?? String(agent.channels.find((c) => c.channel === "stable")?.version ?? agent.versions.at(-1).version);
  if (!agent.versions.some((v) => String(v.version) === version)) return error(404, "not_found", `no version ${version} of agent ${name}`);
  const at = await agentAt(env, name, version), prompt = at?.prompt ?? null;
  // The Agents page saves model, prompt and allowlist edits as a draft, returned with its saved_at (null for none) until it is released or discarded.
  const row = await env.DB.prepare("SELECT draft, saved_at FROM agent_drafts WHERE name = ?").bind(name).first();
  const draft = row && { ...JSON.parse(row.draft), saved_at: row.saved_at };
  const marketplace = !!(await env.DB.prepare("SELECT 1 FROM agent_installs WHERE name = ?").bind(name).first());
  return Response.json({ ...agent, marketplace, prompt, draft_model: draft?.model ?? null, draft_egress: draft?.egress ?? at?.egress ?? DEFAULT_EGRESS, draft });
}

// PUT /api/agents/:name/channels/:channel {version, share?}: points the channel at a recorded release; share (canary only)
// is the percent of changes whose review and resolve jobs run the canary.
export async function moveChannel(request, env, { name, channel }) {
  const body = await request.json().catch(() => null);
  if (!AGENT_CHANNELS.includes(channel)) return error(400, "bad_request", `channel must be one of ${AGENT_CHANNELS.join(", ")}`);
  if (!Number.isInteger(body?.version) || body.version < 1) return error(400, "bad_request", "version must be an integer >= 1");
  const { share } = body;
  if (share !== undefined && (channel !== "canary" || !Number.isInteger(share) || share < 0 || share > 100)) {
    return error(400, "bad_request", "share must be an integer 0-100, on the canary channel only");
  }
  const known = await env.DB.prepare("SELECT 1 FROM agent_versions WHERE name = ? AND version = ?").bind(name, body.version).first();
  if (!known) return error(404, "not_found", `no version ${body.version} of agent ${name}`);
  // The event is written first in the batch, so it compares against stable as it was: a move down is a rollback, and
  // re-pointing stable at the version it already has records nothing.
  const event = channel === "stable"
    ? env.DB.prepare("INSERT INTO agent_channel_events (id, agent_name, kind, version, share, by, at) SELECT ?1, ?2, " +
      "CASE WHEN ?3 < s.version THEN 'rolled_back' ELSE 'promoted' END, ?3, NULL, ?4, ?5 FROM (SELECT (SELECT version FROM channels " +
      "WHERE agent_name = ?2 AND channel = 'stable') AS version) s WHERE s.version IS NULL OR s.version <> ?3")
    : env.DB.prepare("INSERT INTO agent_channel_events (id, agent_name, kind, version, share, by, at) VALUES (?1, ?2, 'canary', ?3, " +
      "COALESCE(?6, (SELECT share FROM canary_shares WHERE agent_name = ?2), 0), ?4, ?5)");
  await env.DB.batch([
    event.bind(crypto.randomUUID(), name, body.version, personOf(request), new Date().toISOString(), ...(channel === "stable" ? [] : [share ?? null])),
    env.DB.prepare("INSERT INTO channels (agent_name, channel, version) VALUES (?1, ?2, ?3) ON CONFLICT (agent_name, channel) DO UPDATE SET version = ?3")
      .bind(name, channel, body.version),
    ...(share === undefined ? [] : [env.DB.prepare("INSERT INTO canary_shares (agent_name, share) VALUES (?1, ?2) ON CONFLICT (agent_name) DO UPDATE SET share = ?2").bind(name, share)]),
  ]);
  return Response.json({ channel, version: body.version, ...(share !== undefined && { share }) });
}

// GET /api/agents/:name/history: its releases and channel moves, newest first (validateAgentHistory).
export async function agentHistory(request, env, { name }) {
  const { results } = await env.DB.prepare("SELECT 'released' AS kind, version, NULL AS share, " +
    // The requester of the newest release job queued before the version was recorded; none for a baked-in version.
    "(SELECT q.person FROM jobs j JOIN job_requesters q ON q.job_id = j.id WHERE j.kind = 'release' AND json_extract(j.payload, '$.name') = ?1 " +
    "AND j.created_at <= released_at ORDER BY j.created_at DESC LIMIT 1) AS by, released_at AS at FROM agent_releases WHERE name = ?1 " +
    "UNION ALL SELECT kind, version, share, by, at FROM agent_channel_events WHERE agent_name = ?1 ORDER BY at DESC").bind(name).all();
  // lazy: the whole history, unpaged; page it once an agent passes a few hundred moves.
  return Response.json(results);
}

// PUT /api/agents/:name/draft {harness, model, effort, tools, egress, web?, limits, prompt}: saves it as the draft the next release commits.
export async function putDraft(request, env, { name }) {
  if (!AGENT_NAME.test(name)) return error(400, "bad_request", "name must be 1-63 chars of [a-z0-9-]");
  const { harness, model, effort, tools, egress = DEFAULT_EGRESS, web = "markdown", limits, prompt } = (await request.json().catch(() => null)) ?? {};
  const draft = { harness, model, effort, tools, egress, web, limits, prompt };
  // A draft has no id, version or prompt hash until it is released, so those are placeholders here.
  const { errors } = validateAgentVersion({ ...draft, id: "draft", name, version: 1, prompt_hash: "draft" });
  if (typeof prompt !== "string") errors.push("prompt: expected string");
  if (!Array.isArray(egress) || !egress.every((h) => typeof h === "string" && HOST_PATTERN.test(h))) errors.push("egress: expected array of host patterns of [a-z0-9.-] with * or ? wildcards");
  if (errors.length) return error(400, "bad_request", errors.join("; "));
  if (!modelHarnesses(model).includes(harness)) return error(422, "model_not_for_harness", `model ${model} is not available for harness ${harness}`);
  // An agent installed from the marketplace keeps its installed prompt; every other setting stays editable.
  if (await env.DB.prepare("SELECT 1 FROM agent_installs WHERE name = ?").bind(name).first()) {
    const latest = await env.DB.prepare("SELECT MAX(version) AS v FROM agent_versions WHERE name = ?").bind(name).first("v");
    const at = latest && await agentAt(env, name, String(latest));
    if (at && at.prompt !== prompt) return error(409, "prompt_locked", `agent ${name} was installed from the marketplace; its prompt is locked`);
  }
  await env.DB.prepare("INSERT INTO agent_drafts (name, draft, saved_at) VALUES (?1, ?2, ?3) ON CONFLICT (name) DO UPDATE SET draft = ?2, saved_at = ?3")
    .bind(name, JSON.stringify(draft), new Date().toISOString()).run();
  return Response.json(draft);
}

// DELETE /api/agents/:name/draft: discards the saved draft; released versions are untouched.
export async function discardDraft(request, env, { name }) {
  const { meta } = await env.DB.prepare("DELETE FROM agent_drafts WHERE name = ?").bind(name).run();
  if (!meta.changes) return error(404, "not_found", `agent ${name} has no draft`);
  return new Response(null, { status: 204 });
}

// POST /api/agents/:name/release {channel?, note?}: queues a job that commits the latest draft and tags it agent/<name>/vN;
// the push that records vN points channel at it. The job carries the draft, so the saved draft is cleared.
export async function releaseAgent(request, env, { name }) {
  const { channel, note } = (await request.json().catch(() => null)) ?? {};
  if (channel !== undefined && !AGENT_CHANNELS.includes(channel)) return error(400, "bad_request", `channel must be one of ${AGENT_CHANNELS.join(", ")}`);
  if (note !== undefined && (typeof note !== "string" || note.length > 500)) return error(400, "bad_request", "note must be a string of at most 500 chars");
  const draft = await agentAt(env, name, "draft");
  if (!draft) return error(409, "no_draft", `agent ${name} has no draft to release`);
  if (draft.secrets !== undefined) return error(422, "agents_get_no_secrets", `agent ${name} declares secrets; agents never receive keystore secrets`);
  const res = await queueJob(env, personOf(request), "release", { name, draft, channel, note: note?.trim() || undefined });
  await env.DB.prepare("DELETE FROM agent_drafts WHERE name = ?").bind(name).run();
  return res;
}

// POST /api/agents/:name/egress {host, verdict: allow|deny, channel}: queues the release of a copy of the version channel
// points to, with host added to (allow) or removed from (deny) its egress; the push that records it points channel at it.
export async function releaseEgress(request, env, { name }) {
  const { host, verdict, channel } = (await request.json().catch(() => null)) ?? {};
  if (!AGENT_CHANNELS.includes(channel)) return error(400, "bad_request", `channel must be one of ${AGENT_CHANNELS.join(", ")}`);
  if (verdict !== "allow" && verdict !== "deny") return error(400, "bad_request", "verdict must be allow or deny");
  if (typeof host !== "string" || !HOST_PATTERN.test(host)) return error(400, "bad_request", "host must be a host pattern of [a-z0-9.-] with * or ? wildcards");
  const from = await env.DB.prepare("SELECT version FROM channels WHERE agent_name = ? AND channel = ?").bind(name, channel).first("version");
  const at = from && await agentAt(env, name, String(from));
  if (!at) return error(404, "not_found", `agent ${name} has no ${channel} version`);
  const egress = verdict === "allow" ? [...new Set([...at.egress, host])] : at.egress.filter((h) => h !== host);
  const { harness, model, effort, tools, web, limits, prompt } = at;
  // lazy: the runner numbers the release when it runs, so a release queued meanwhile can take this number; return the job's
  // version once release jobs report one.
  const version = await env.DB.prepare("SELECT MAX(version) + 1 AS next FROM agent_versions WHERE name = ?").bind(name).first("next");
  await queueJob(env, personOf(request), "release", { name, draft: { harness, model, effort, tools, egress, web, limits, prompt }, channel });
  return Response.json({ version, channel, egress }, { status: 202 });
}

async function queueJob(env, person, kind, payload) {
  const job = { id: crypto.randomUUID(), repo_id: AGENTS_REPO, kind, change_id: null, status: "queued", runner_id: null, lease_expires_at: null, created_at: new Date().toISOString() };
  await env.DB.batch([env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(job.id, job.repo_id, job.kind, job.status, job.created_at, JSON.stringify(payload)),
  env.DB.prepare("INSERT INTO job_requesters (job_id, person) VALUES (?, ?)").bind(job.id, person)]);
  return Response.json(job, { status: 202 });
}

// GET /api/agents/:name/versions/:version: that version's lock and prompt, read from its release tag (validateAgentVersionDetail).
export async function agentVersion(request, env, { name, version }) {
  const at = /^[1-9]\d*$/.test(version) && await agentAt(env, name, version);
  if (!at) return error(404, "not_found", `no agent version ${name}@v${version}`);
  return Response.json(at);
}

// "draft" is the saved draft; a version number is the released row plus its prompt at tag agent/<name>/vN.
async function agentAt(env, name, ref) {
  if (ref === "draft") {
    const draft = await env.DB.prepare("SELECT draft FROM agent_drafts WHERE name = ?").bind(name).first("draft");
    // A draft saved before the web setting existed releases with the default.
    return draft && { web: "markdown", ...JSON.parse(draft) };
  }
  const v = await env.DB.prepare("SELECT v.*, r.egress, COALESCE(w.web, 'raw') AS web FROM agent_versions v " +
    "LEFT JOIN agent_releases r ON r.name = v.name AND r.version = v.version LEFT JOIN agent_release_web w ON w.name = v.name AND w.version = v.version " +
    "WHERE v.name = ? AND v.version = ?").bind(name, Number(ref)).first();
  if (!v) return null;
  const prompt = await createArtifacts(env.ARTIFACTS).readFile(AGENTS_REPO, `agent/${name}/v${ref}`, `agents/${name}/prompt.md`);
  // A version recorded before agent_releases has the default egress.
  return prompt === null ? null : { ...v, egress: v.egress ? JSON.parse(v.egress) : DEFAULT_EGRESS, tools: JSON.parse(v.tools), limits: JSON.parse(v.limits), prompt };
}

// Line diff from an LCS table. lazy: O(lines²) memory; switch to Myers if prompts pass a few thousand lines.
export function lineDiff(a, b) {
  // A final "\n" ends the last line rather than starting an empty one, and "" has no lines.
  const split = (t) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const x = split(a), y = split(b);
  const lcs = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(` ${x[i++]}`);
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push(`-${x[i++]}`);
    else out.push(`+${y[j++]}`);
  }
  return out;
}

// GET /api/agents/:name/diff?from&to: changed fields, with added tools, egress hosts outside the default and raised limits flagged as widening.
export async function diffAgent(request, env, { name }) {
  const params = new URL(request.url).searchParams;
  const [from, to] = [params.get("from"), params.get("to")];
  if (!REF.test(from ?? "") || !REF.test(to ?? "")) return error(400, "bad_request", "from and to must each be a version number or draft");
  const [a, b] = [await agentAt(env, name, from), await agentAt(env, name, to)];
  if (!a || !b) return error(404, "not_found", `no ${a ? to : from} of agent ${name}`);
  const get = (o, path) => path.split(".").reduce((x, k) => x?.[k], o);
  const fields = FIELDS.flatMap((field) => {
    const [x, y] = [get(a, field), get(b, field)];
    if (JSON.stringify(x) === JSON.stringify(y)) return [];
    if (field === "egress") return [{ field, from: x, to: y, widens: (y ?? []).some((h) => !DEFAULT_EGRESS.includes(h) && !x?.includes(h)) }];
    const widens = field === "tools" ? y.some((t) => !x.includes(t)) : field.startsWith("limits.") && y > x;
    return [{ field, from: x, to: y, widens }];
  });
  return Response.json({ from, to, fields, prompt: lineDiff(a.prompt, b.prompt) });
}

// Listings account ?1 may see: one visible to the organization shows only in its publisher's account and organization.
const LISTINGS = "SELECT l.name, l.description, p.version, COALESCE(p.visibility, 'instance') AS visibility, p.account_id, a.slug FROM agent_listings l " +
  "LEFT JOIN agent_publications p ON p.name = l.name LEFT JOIN accounts a ON a.id = p.account_id " +
  "WHERE (p.visibility IS NOT 'organization' OR p.account_id = ?1 OR a.org_id = (SELECT org_id FROM accounts WHERE id = ?1))";

// GET /api/marketplace: the bundled agents plus every agent published here that the active account may see, each with
// its listed versions (up to the published one), the newest one's harness, model, tools and egress, its race record
// (wins / races is the win rate), installs and tokens per merged change. Prompts, limits and keys are never listed.
export async function listCatalog(request, env) {
  await ensureAgentsRepo(env);
  const account = activeAccount(request);
  const [{ results: listings }, { results: installs }, fleet] = await Promise.all([
    env.DB.prepare(LISTINGS).bind(account).all(),
    env.DB.prepare("SELECT template, COUNT(*) AS n FROM agent_installs GROUP BY template").all(),
    getFleet(request, env).then((r) => r.json()),
  ]);
  const listed = new Map(listings.map((l) => [l.name, l]));
  const installsOf = new Map(installs.map((i) => [i.template, i.n]));
  const usage = new Map(fleet.agents.map((a) => [a.name, a]));
  const catalog = [];
  for (const a of (await agents(env)).values()) {
    const l = listed.get(a.name), u = usage.get(a.name);
    if (!l && !Object.hasOwn(BAKED_IN, a.name)) continue;
    const versions = a.versions.filter((v) => !l?.version || v.version <= l.version), latest = versions.at(-1);
    catalog.push({ name: a.name, source: l ? "published" : "bundled", description: l?.description ?? BAKED_IN[a.name].trim(),
      publisher: l ? l.slug ?? "this instance" : "cinder", harness: latest.harness, model: latest.model,
      tools: latest.tools, egress: latest.egress ?? DEFAULT_EGRESS, versions: versions.map((v) => v.version),
      wins: versions.reduce((n, v) => n + v.wins, 0), races: versions.reduce((n, v) => n + v.races, 0), installs: installsOf.get(a.name) ?? 0,
      tokens_per_merge: u?.merged ? Math.round(u.tokens / u.merged) : null, visibility: l ? l.visibility : null, mine: Boolean(l?.account_id) && l.account_id === account });
  }
  return Response.json(catalog);
}

// POST /api/agents/:name/install {template, account_id, version, channel}: queues a release of the template's version
// as the new agent name in the installer's account (Git Admin there), which the runner tags agent/<name>/v1 on channel.
// The install pins that version and copies its prompt, model, tools and egress but not its token limits, so the
// installer's budget applies; its runs use the requester's model credentials like any agent's, and its record starts at 0.
export async function installAgent(request, env, { name }) {
  const { template, account_id: account, version, channel } = (await request.json().catch(() => null)) ?? {};
  if (!AGENT_NAME.test(name)) return error(400, "bad_request", "name must be 1-63 chars of [a-z0-9-]");
  if (typeof template !== "string" || typeof account !== "string" || !Number.isInteger(version) || !AGENT_CHANNELS.includes(channel)) {
    return error(400, "bad_request", `body must be {template, account_id, version: integer, channel: one of ${AGENT_CHANNELS.join(", ")}}`);
  }
  if (!(await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(account).first())) return error(404, "not_found", `no account ${account}`);
  if (!(await gitAdmin(request, env, account))) return error(403, "forbidden", "installing an agent needs Git Admin on the account");
  const listing = await env.DB.prepare(`${LISTINGS} AND l.name = ?2`).bind(account, template).first();
  const listed = listing || Object.hasOwn(BAKED_IN, template);
  const pinned = listed && (!listing?.version || version <= listing.version) && (await agents(env, template)).get(template)?.versions.some((v) => v.version === version);
  if (!pinned) return error(404, "not_found", `no ${template}@v${version} in the catalog`);
  const taken = await env.DB.prepare("SELECT 1 FROM agent_versions WHERE name = ?1 UNION ALL " +
    "SELECT 1 FROM jobs WHERE kind = 'release' AND status IN ('queued', 'claimed') AND json_extract(payload, '$.name') = ?1").bind(name).first();
  if (taken) return error(409, "conflict", `agent ${name} already exists`);
  const at = await agentAt(env, template, String(version));
  if (!at) return error(404, "not_found", `template ${template} has no prompt at v${version}`);
  const { harness, model, effort, tools, egress, limits: { max_cost_usd, max_minutes }, prompt } = at;
  // A release that never lands leaves its row; a later install of the same name replaces it.
  await env.DB.prepare("INSERT OR REPLACE INTO agent_installs VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(name, template, version, account, channel, personOf(request), new Date().toISOString()).run();
  return queueJob(env, personOf(request), "release", { name, draft: { harness, model, effort, tools, egress, limits: { max_cost_usd, max_minutes }, prompt }, channel });
}

// POST /api/agents/:name/publish {version, description, visibility}: lists one of this instance's agent versions in the
// catalog from the active account, for its organization or the whole instance. Only the version's prompt, model, tools
// and egress are installable; the catalog lists none of its secrets, keys, limits or changes.
export async function publishAgent(request, env, { name }) {
  const { version, description, visibility } = (await request.json().catch(() => null)) ?? {};
  if (typeof description !== "string" || !description.trim() || description.length > 500) return error(400, "bad_request", "description must be 1-500 chars");
  if (!Number.isInteger(version) || !["organization", "instance"].includes(visibility)) return error(400, "bad_request", "body must be {version: integer, description, visibility: organization or instance}");
  if (!(await env.DB.prepare("SELECT 1 FROM agent_versions WHERE name = ? AND version = ?").bind(name, version).first())) return error(404, "not_found", `no agent version ${name}@v${version}`);
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO agent_listings (name, description, listed_at) VALUES (?1, ?2, ?3) ON CONFLICT (name) DO UPDATE SET description = ?2").bind(name, description.trim(), at),
    env.DB.prepare("INSERT OR REPLACE INTO agent_publications VALUES (?, ?, ?, ?)").bind(name, version, visibility, activeAccount(request)),
  ]);
  return Response.json({ name, version, description: description.trim(), visibility });
}

// PUT /api/agents/:name/versions/:version/limits {max_tokens, max_tokens_month}: saves the version's token limits per run
// and per month (null clears one); its other limits are kept.
export async function putTokenLimits(request, env, { name, version }) {
  const body = await request.json().catch(() => null);
  const { ok, errors } = validateTokenLimits(body);
  if (!ok) return error(400, "bad_request", errors.join("; "));
  const limits = { max_tokens: body.max_tokens, max_tokens_month: body.max_tokens_month };
  const saved = await env.DB.prepare("UPDATE agent_versions SET limits = json_set(limits, '$.max_tokens', ?, '$.max_tokens_month', ?) " +
    "WHERE name = ? AND version = ? RETURNING id").bind(limits.max_tokens, limits.max_tokens_month, name, Number(version)).first();
  if (!saved) return error(404, "not_found", `no agent version ${name}@v${version}`);
  return Response.json(limits);
}

// "dev@2", "dev@v2" or "dev@canary" → the agent_versions id, e.g. "agent/dev/v2".
export async function resolveAgent(env, spec) {
  const [name, ref = ""] = String(spec).split("@");
  let version = /^v?[1-9]\d*$/.test(ref) ? Number(ref.replace("v", "")) : null;
  if (AGENT_CHANNELS.includes(ref)) {
    version = (await env.DB.prepare("SELECT version FROM channels WHERE agent_name = ? AND channel = ?").bind(name, ref).first())?.version;
  }
  const row = version && await env.DB.prepare("SELECT id FROM agent_versions WHERE name = ? AND version = ?").bind(name, version).first();
  if (!row) throw new Error(`cannot resolve agent ${spec}`);
  return row.id;
}
