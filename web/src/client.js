import {
  validateAgent, validateAgentEntry, validateBoardChange, validateChange, validateChangeCheck, validateChangeCommit, validateChangeDetail, validateChangePage, validateChangePreview, validateInsights, validateIntentHint, validateJudges, validateJudgment, validateLeaseMap, validateNeed,
  validateQueueEntry, validateRace, validateRepo, validateRepoOverview, validateRepoPolicy, validateReviewThread,
  validateAuthorship, validateCodeFile, validateCodePage, validateCodeTree, validateGroup, validateKeystore, validateKeystoreUsage, validatePerson, validatePool, validateRunner, validateWatchtower, validateEgress, validateDependency,
  validateBranch, validateCodeHit, validateCodeLog, validateCompare, validateWikiComment, validateWikiPage, validateWikiSearchHit, validateWikiTree, validateWikiVersion, validateFlowRun, validateEnvironment, validateEnvironmentTree, validateCommitDiff, validateDiffFile, ACTIVITY_METRICS,
  DONE_STATES, validateRelease, validateTag, validateModelAccess, validateByoPool, validateFleet, validateCatalogModel, validateRaceSummary, validateMe, validateFlowList,
} from "../../worker/src/api/contract.js";
import agents from "../../worker/src/api/fixtures/agents.json";
import board from "../../worker/src/api/fixtures/board.json";
import branches from "../../worker/src/api/fixtures/branches.json";
import changePages from "../../worker/src/api/fixtures/change-pages.json";
import changes from "../../worker/src/api/fixtures/changes.json";
import codePage from "../../worker/src/api/fixtures/code-page.json";
import compare from "../../worker/src/api/fixtures/compare.json";
import egress from "../../worker/src/api/fixtures/egress.json";
import insights from "../../worker/src/api/fixtures/insights.json";
import intentHints from "../../worker/src/api/fixtures/intent-hints.json";
import judges from "../../worker/src/api/fixtures/judges.json";
import judgments from "../../worker/src/api/fixtures/judgments.json";
import leaseMap from "../../worker/src/api/fixtures/lease-map.json";
import needs from "../../worker/src/api/fixtures/needs.json";
import queue from "../../worker/src/api/fixtures/queue.json";
import overview from "../../worker/src/api/fixtures/repo-overview.json";
import races from "../../worker/src/api/fixtures/races.json";
import repoPolicies from "../../worker/src/api/fixtures/repo-policies.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import runners from "../../worker/src/api/fixtures/runners.json";
import pools from "../../worker/src/api/fixtures/pools.json";
import byoPools from "../../worker/src/api/fixtures/byo-pools.json";
import people from "../../worker/src/api/fixtures/people.json";
import groups from "../../worker/src/api/fixtures/groups.json";
import keystore from "../../worker/src/api/fixtures/keystore.json";
import watchtower from "../../worker/src/api/fixtures/watchtower.json";

const LISTS = {
  "/api/repos": [validateRepo, repos],
  "/api/changes": [validateChange, changes],
  "/api/queue": [validateQueueEntry, queue],
  "/api/judgments": [validateJudgment, judgments],
  "/api/agents": [validateAgentEntry, agents],
  "/api/board": [validateBoardChange, board],
  // Fixture-only until the worker serves it.
  "/api/change-pages": [validateChangePage, changePages],
  "/api/races": [validateRace, races],
  "/api/repo-policies": [validateRepoPolicy, repoPolicies],
  "/api/intent-hints": [validateIntentHint, intentHints],
  "/api/needs": [validateNeed, needs],
  "/api/workers": [validateRunner, runners],
  "/api/workers/pools": [validatePool, pools],
  "/api/workers/byo-pools": [validateByoPool, byoPools],
  "/api/people": [validatePerson, people],
  "/api/groups": [validateGroup, groups],
};

// A new feature's calls go in web/src/api/<feature>.js, built on fixtures, fetchJson, postJson and checked from here.
export const fixtures = () => import.meta.env.VITE_FIXTURES === "1";
// No bearer token: Cloudflare Access's JWT, sent by the edge with every same-origin request, identifies the person.

// A 401 means no valid session: error states ask to sign in again (ui.jsx State). Holds the 401's error code.
let expired = null;
export const sessionExpired = () => expired;

// One request per URL for the page: callers share the in-flight GET and its answer until a live event, a write or
// invalidate() drops it. A failed GET is not kept. Each caller gets its own copy, so one can't mutate another's.
const cache = new Map();
export const invalidate = () => cache.clear();
export function fetchJson(path) {
  let p = cache.get(path);
  if (!p) {
    p = request(path);
    cache.set(path, p);
    p.catch(() => { if (cache.get(path) === p) cache.delete(path); });
  }
  return p.then(structuredClone);
}

async function request(path) {
  // A request that never got an answer ("Failed to fetch") names its path like an HTTP failure does.
  let res;
  try {
    res = await fetch(path);
  } catch (e) {
    throw new Error(`${path}: ${e.message}`, { cause: e });
  }
  if (!res.ok) {
    // The request line the error states print: "GET /api/repos → 503 index unavailable · req 7f3a91c2".
    const { message: reason, code } = (await res.json().catch(() => null))?.error ?? {};
    if (res.status === 401) expired = code ?? "unauthorized";
    const req = res.headers.get("cf-ray");
    // lazy: change.jsx and changes.jsx still prepend "GET " and expect the bare form; unify once they take the full line.
    const status = { status: res.status, code };
    if (!reason && !req) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), status);
    throw Object.assign(new Error(`GET ${path} → ${res.status} ${reason ?? res.statusText}${req ? ` · req ${req}` : ""}`), status);
  }
  return res.json();
}

const OBJECTS = {
  // lazy: fixtures only; live, codeFor composes the page from /tree, /file and /authorship.
  "/api/code-page": [validateCodePage, codePage],
  "/api/keystore": [validateKeystore, keystore],
  // The account's Secrets Store secrets against its cap (Settings › Keystore).
  "/api/keystore/usage": [validateKeystoreUsage, { used: 5, limit: 100 }],
  "/api/me": [validateMe, { email: null, owner: true }],
};

const load = (path, fixture) => (fixtures() ? fixture : fetchJson(path));

// Every list is checked against contract.js; a response that doesn't match throws instead of rendering.
export function checked(path, body, validate) {
  if (!Array.isArray(body)) throw new Error(`${path}: expected array`);
  body.forEach((item, i) => {
    const { ok, errors } = validate(item);
    if (!ok) throw new Error(`${path}[${i}]: ${errors.join("; ")}`);
  });
  return body;
}

// Live, GET /api/overview serves the account, budget and each repo's metadata; the page's counts come from each repo's changes.
// lazy: slots, lead judge and last merge stay empty until an endpoint serves them.
async function liveOverview() {
  const today = new Date().toISOString().slice(0, 10);
  const [repos, base] = await Promise.all([list("/api/repos"), fetchJson("/api/overview")]);
  const changes = await Promise.all(repos.map(async (r) => {
    const path = `/api/repos/${encodeURIComponent(r.name)}/changes`;
    return checked(path, await fetchJson(path), validateChange);
  }));
  return {
    ...base, slots: 0,
    merged_today: changes.flat().filter((c) => c.state === "merged" && c.updated_at.startsWith(today)).length,
    // lazy: verifier outcomes read from change states (merged passed, failed failed) until an endpoint serves them.
    // A repo created between the two reads has no overview row yet; the next load shows it.
    repos: repos.flatMap((r, i) => {
      const row = base.repos.find((x) => x.repo_id === r.id);
      const n = (s) => changes[i].filter((c) => c.state === s).length;
      const runs = n("merged") + n("failed");
      return row ? [{ ...row, lead_judge: null, last_merge: null, conflicts: n("conflict"),
        active: changes[i].filter((c) => !DONE_STATES.includes(c.state)).length,
        merged: changes[i].filter((c) => c.state === "merged" && c.updated_at.startsWith(today.slice(0, 7))).length,
        verifier: { n: runs, pass: runs ? Math.round(n("merged") / runs * 1000) / 10 : null } }] : [];
    }),
  };
}

// An object checked against contract.js; a mismatch throws instead of rendering.
function valid(path, body, validate) {
  const { ok, errors } = validate(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

export async function get(path) {
  const [validate, fixture] = OBJECTS[path];
  return valid(path, await load(path, fixture), validate);
}

// GET path, one object checked with validate (an array is a mismatch).
const getObject = async (path, validate) => valid(path, await fetchJson(path), validate);

// GET path, the list's items or the object checked with validate.
export async function getValid(path, validate) {
  const body = await fetchJson(path);
  return Array.isArray(body) ? checked(path, body, validate) : valid(path, body, validate);
}

export const getOverview = async () => valid("/api/overview", fixtures() ? overview : await liveOverview(), validateRepoOverview);

// The likeliest collision on holder's change among the lease map's edges, { p, judge }, or null when none was judged.
const strongest = (edges, holder) => edges.filter((e) => e.a === holder || e.b === holder).sort((x, y) => y.p - x.p).map(({ p, judge }) => ({ p, judge }))[0] ?? null;

export async function getLeaseMap(repo, target) {
  const path = `/api/repos/${encodeURIComponent(repo)}/lease-map${target ? `?target=${encodeURIComponent(target)}` : ""}`;
  const body = await load(path, leaseMap);
  const { ok, errors } = validateLeaseMap(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// ?state=all: the Findings card lists dismissed and fixed findings too.
export async function getWatchtower(repo) {
  const path = `/api/repos/${encodeURIComponent(repo)}/watchtower?state=all`;
  const body = await load(path, watchtower);
  const { ok, errors } = validateWatchtower(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

export async function getEgress(repo, window) {
  const path = `/api/repos/${encodeURIComponent(repo)}/egress?window=${window}`;
  const body = await load(path, egress);
  const { ok, errors } = validateEgress(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

export async function branchesFor(repo) {
  const path = `/api/repos/${encodeURIComponent(repo)}/branches`;
  return checked(path, await load(path, branches), validateBranch);
}

// POST /api/repos/:name/branches: a new branch at the default branch's head; DELETE removes one (owner or maintainer).
export const createBranch = (repo, name) => postJson(`/api/repos/${encodeURIComponent(repo)}/branches`, { name });
export const deleteBranch = (repo, name) => postJson(`/api/repos/${encodeURIComponent(repo)}/branches/${encodeURIComponent(name)}`, undefined, "DELETE");

// diff is null while the compare job runs (202).
export async function compareFor(repo, base, head) {
  const path = `/api/repos/${encodeURIComponent(repo)}/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`;
  const body = await load(path, compare);
  const { ok, errors } = validateCompare(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// lazy: fixture mode serves no inventory; add a dependencies fixture when the page needs a demo.
export async function getDependencies(repo) {
  const path = `/api/repos/${encodeURIComponent(repo)}/dependencies`;
  return checked(path, await load(path, []), validateDependency);
}

// GET /api/repos/:name/sbom saved as a file. It goes through fetch and a blob so a 401 shows as an error, not a broken download.
export async function downloadSbom(repo) {
  if (fixtures()) return;
  const bom = await fetchJson(`/api/repos/${encodeURIComponent(repo)}/sbom`);
  const href = URL.createObjectURL(new Blob([JSON.stringify(bom, null, 2)], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href, download: `${repo.replace(/\//g, "-")}.cdx.json` }).click();
  setTimeout(() => URL.revokeObjectURL(href)); // deferred: revoking at once can cancel the download
}

// POST /api/repos/:name/watchtower/scans starts a scan. Fixture mode starts nothing.
export const startScan = async (repo) => postJson(`/api/repos/${encodeURIComponent(repo)}/watchtower/scans`, {});
// POST /api/findings/:id/dismiss, /reopen and /fix. Fixture mode posts nothing; fix returns the change it opened.
export const dismissFinding = async (id, reason) => postJson(`/api/findings/${encodeURIComponent(id)}/dismiss`, { reason });
export const reopenFinding = async (id) => postJson(`/api/findings/${encodeURIComponent(id)}/reopen`, {});
export const fixFinding = async (id) => postJson(`/api/findings/${encodeURIComponent(id)}/fix`, {});
// PATCH /api/repos/:name/dependencies turns auto-fix on or off for one package; PUT settings pauses the repo's daily scans.
// Fixture mode sends nothing.
export const pauseScans = async (repo, paused) => postJson(`/api/repos/${encodeURIComponent(repo)}/settings`, { scans_paused: paused }, "PUT");
export const setAutoFix = async (repo, ecosystem, name, on) => postJson(`/api/repos/${encodeURIComponent(repo)}/dependencies`, { ecosystem, name, auto_fix: on }, "PATCH");

// GET /api/repos/:name/insights over the last `hours`, counting only changes that target `branch` (default: the repo's default branch).
export async function getInsights(repo, hours, branch) {
  const path = `/api/repos/${encodeURIComponent(repo)}/insights?from=${new Date(Date.now() - hours * 3600000).toISOString()}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;
  const body = await load(path, insights);
  const { ok, errors } = validateInsights(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

export async function list(path) {
  const [validate, fixture] = LISTS[path];
  return checked(path, await load(path, fixture), validate);
}

// Live, GET /api/agents serves each agent's versions and channels; the page's entry is built from them.
// lazy: race lists, prompts and token limits stay empty until an endpoint serves them.
// page: also read races.
export async function agentList(page = null) {
  if (fixtures()) return list("/api/agents");
  const path = "/api/agents";
  const [agents, races] = await Promise.all([fetchJson(path), page ? fetchJson("/api/races") : []]);
  return checked(path, agents, validateAgent).map((a) => {
    const versions = a.versions.toSorted((x, y) => y.version - x.version);
    const channel = (n) => a.channels.find((c) => c.version === n)?.channel ?? "retired";
    return {
      name: a.name, role: versions[0].harness,
      // Race legs are named <agent>@v<N>.
      races: races.filter((r) => r.legs.some((l) => l.leg.startsWith(`${a.name}@`))).map((r) => ({ id: r.id, change_id: r.legs[0].change_id, legs: r.legs.map((l) => l.leg), winner: r.winner, intent: "" })),
      versions: versions.map((v) => ({ version: String(v.version), channel: channel(v.version), model: v.model, released_at: v.released_at, wins: v.races ? v.wins : null, races: v.races, active: 0 })),
      config: Object.fromEntries(versions.map((v) => [v.version, { harness: v.harness, model: v.model, effort: v.effort, tools: v.tools, egress: v.egress ?? [], limits: v.limits,
        prompt: "" }])),
    };
  });
}

// The editor's release: save the draft, then queue its release as agent/<name>/v<N>. Fixture mode releases locally.
export async function releaseDraft(name, { harness, model, effort, tools, egress, limits, prompt }, channel) {
  if (fixtures()) return null;
  const path = `/api/agents/${encodeURIComponent(name)}`;
  await postJson(`${path}/draft`, { harness, model, effort, tools, egress, limits, prompt }, "PUT");
  return postJson(`${path}/release`, { channel });
}
export const agentDiff = (name, from, to) => (fixtures() ? null : fetchJson(`/api/agents/${encodeURIComponent(name)}/diff?from=${from}&to=${to}`));

// lazy: the API serves no tokens, lease or judge per change yet, so live cards show none; switch to the board shape once an endpoint serves it.
const CARD = { agent: "owner", ver: null, tok: [0, 0, 0], lease: { kind: "none", n: null }, risk_judge: null };

export async function boardFor(repo, target) {
  if (fixtures()) return checked("/api/board", board, validateBoardChange).filter((c) => c.repo_id === repo.id && (!target || c.target_branch === target));
  const path = `/api/repos/${encodeURIComponent(repo.name)}/changes${target ? `?target=${encodeURIComponent(target)}` : ""}`;
  return checked(path, await fetchJson(path), validateChange).map((c) => ({ ...CARD, ...c,
    // The picked agent writes a described change; a change from a branch is its driver's.
    ...(c.agent_version ? { agent: c.agent_version.split("@")[0], ver: c.agent_version.split("@")[1] } : c.driver && { agent: c.driver }) }));
}

// Change detail: GET /api/changes/:id with its view, its threads and the repo's changes for "n of m open". Live only.
export async function changeDetail(repo, ref) {
  const r = encodeURIComponent(repo);
  // A key (PULSE-6) opens its change: the worker resolves it within the repo, then every read goes by the change's id.
  const keyed = /^[A-Z0-9]+-\d+$/.test(ref) && !fixtures() ? await fetchJson(`/api/changes/${encodeURIComponent(ref)}?repo=${r}`) : null;
  const id = keyed?.id ?? ref;
  const path = `/api/changes/${encodeURIComponent(id)}`;
  if (fixtures()) {
    const all = await list("/api/changes");
    const change = all.find((c) => c.id === id || c.key === id);
    if (!change) throw Object.assign(new Error(`${path}: HTTP 404`), { status: 404 });
    return { change: { ...change, events: [], blockers: [], auto_queue: true }, threads: [], changes: all, commits: [], checks: [], files: Promise.resolve([]), queue: [] };
  }
  const changesPath = `/api/repos/${r}/changes`;
  // Every request but the queue's (it needs the target) starts at once; the diff stays a promise so the page draws without it.
  const lists = Promise.all([fetchJson(`${path}/threads`), fetchJson(changesPath), fetchJson(`${path}/commits`), fetchJson(`${path}/checks`)]);
  // Each file's lines are a whole-file diff from line 1, so one hunk header makes them a patch; a file too large to diff (lines null) shows no rows.
  const files = fetchJson(`${path}/files`).then((f) => checked(`${path}/files`, f, validateDiffFile).map((f) => ({ ...f, patch: f.lines ? `@@ -1 +1 @@\n${f.lines.join("\n")}` : "" })));
  lists.catch(() => {});
  files.catch(() => {}); // the page shows its failure; this only stops an unhandled rejection before it renders
  const change = keyed ?? await fetchJson(path);
  const { ok, errors } = validateChangeDetail(change);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  const queuePath = `/api/repos/${r}/queue?target=${encodeURIComponent(change.target_branch)}`;
  const [[threads, changes, commits, checks], queue] = await Promise.all([lists, change.state === "in_queue" ? fetchJson(queuePath) : []]);
  return { change, threads: checked(`${path}/threads`, threads, validateReviewThread), changes: checked(changesPath, changes, validateChange),
    commits: checked(`${path}/commits`, commits, validateChangeCommit), checks: checked(`${path}/checks`, checks, validateChangeCheck),
    files, queue: checked(queuePath, queue, validateQueueEntry) };
}

// PATCH /api/changes/:id/auto_queue. Fixture mode writes nothing.
export const setAutoQueue = (id, on) => postJson(`/api/changes/${encodeURIComponent(id)}/auto_queue`, { auto_queue: on }, "PATCH");

// Listeners waiting to reconnect.
const down = new Set();
const markDown = (key, isDown) => {
  if (isDown) down.add(key);
  else down.delete(key);
};
export const reconnecting = () => down.size > 0;

// Calls onEvent for every change event in the repo; returns a function that stops listening. No-op on fixtures.
// A dropped socket or failed ticket retries with a fresh ticket after 1s, 2s, 4s ... up to 30s, then calls onEvent()
// once reconnected so the page refetches what it missed. With live off (204), onEvent() runs every 15 s while visible.
// hello, when given, is sent on every open (a flow job's run.log subscription).
// Listeners on one repo share one ticket and socket; one with a hello (its own subscription) gets its own.
// Every event, reconnect or live-off poll drops the cached GETs first, so the refetch it triggers is fresh.
// lazy: drops every cached GET, not just the repo's; key the cache by repo if refetches after events cost too much.
const shared = new Map();
export function listen(name, onEvent, hello) {
  if (fixtures()) return () => {};
  if (hello) return connect(name, (...e) => { invalidate(); onEvent(...e); }, hello);
  let s = shared.get(name);
  if (!s) {
    const subs = new Set();
    s = { subs, stop: connect(name, (...e) => { invalidate(); for (const f of subs) f(...e); }) };
    shared.set(name, s);
  }
  const sub = (...e) => onEvent(...e);
  s.subs.add(sub);
  return () => {
    s.subs.delete(sub);
    // A remount (or StrictMode's second effect) subscribes again in the same task: keep the socket for it.
    queueMicrotask(() => {
      if (s.subs.size || shared.get(name) !== s) return;
      shared.delete(name);
      s.stop();
    });
  };
}

function connect(name, onEvent, hello) {
  const key = {};
  let ws;
  let timer;
  let poll;
  let delay = 0;
  let stopped = false;
  const retry = (err) => {
    if (err) console.error(err);
    if (stopped) return;
    delay = Math.min(delay * 2 || 1000, 30000);
    markDown(key, true);
    timer = setTimeout(open, delay);
  };
  // 204: no ticket key is bound, so live updates are off and no socket opens.
  const open = () => fetch("/api/live-ticket", { method: "POST", body: JSON.stringify({ repo: name }) }).then((res) => {
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`/api/live-ticket: HTTP ${res.status}`);
    return res.json();
  }).then((body) => {
    // No location outside a browser (tests): the socket URL can't be built, so stay quiet instead of retrying.
    if (stopped || typeof location === "undefined") return;
    if (!body) {
      poll = setInterval(() => { if (document.visibilityState === "visible") onEvent(); }, 15000);
      return;
    }
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const query = body.ticket ? `?ticket=${body.ticket}` : "";
    ws = new WebSocket(`${scheme}://${location.host}/api/repos/${encodeURIComponent(name)}/live${query}`);
    ws.onmessage = onEvent;
    ws.onopen = () => {
      if (hello) ws.send(JSON.stringify(hello));
      if (!delay) return;
      delay = 0;
      markDown(key, false);
      onEvent();
    };
    ws.onclose = () => retry();
  }).catch(retry);
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poll);
    if (down.has(key)) markDown(key, false);
    ws?.close();
  };
}

// Needs you: GET /api/needs serves the open items (fixtures: needs.json).
export const needsList = () => list("/api/needs");

// One of an item's actions, or Dismiss, resolves it (extra: the action's own fields), then tells the browser's other tabs. Fixture mode posts nothing.
export const NEEDS_CHANNEL = "cinder.needs";
export async function resolveNeed(id, action, extra) {
  if (fixtures()) return null;
  const need = await postJson(`/api/needs/${encodeURIComponent(id)}/resolve`, { action, ...extra });
  const channel = new BroadcastChannel(NEEDS_CHANNEL);
  channel.postMessage(id);
  channel.close();
  return need;
}

// POST /api/changes/:id/threads/:t/apply when thread is set, else a new thread on a diff line. Fixture mode posts nothing.
export async function threadAct(id, { thread, path, side, line, body }) {
  if (fixtures()) return null;
  const base = `/api/changes/${encodeURIComponent(id)}/threads`;
  return thread ? postJson(`${base}/${encodeURIComponent(thread)}/apply`, {}) : postJson(base, { path, side, line: Number(line), body });
}

// POST /api/repos/:name/changes. Fixture mode creates nothing.
export async function createChange(repo, body) {
  if (fixtures()) return null;
  return postJson(`/api/repos/${encodeURIComponent(repo)}/changes`, body);
}

// POST /api/repos/:name/changes/edit {target or change_id, path, base_sha, content, intent}: a person's edit becomes a change,
// or commits into the workspace of the change the person drives.
export const editFile = (repo, body) => postJson(`/api/repos/${encodeURIComponent(repo)}/changes/edit`, body);
// POST /api/repos/:name/commits {branch, base_sha, message, changes: [{path, content | delete}]}: one commit straight onto branch.
export const commitFiles = (repo, body) => postJson(`/api/repos/${encodeURIComponent(repo)}/commits`, body);
// The Code page's staged files as one change: a new change on target that the person takes over (so no agent writes
// to it) or, with agent, leaves to the agent it is scheduled for; or the workspace of change_id they drive.
// Then one commit of all files on the change's fork. choice is the lease prompt's answer (stack or parallel), sent with the new change.
export async function proposeFiles(repo, { target, change_id: id, intent, base_sha, changes, agent, choice }) {
  const change = id ? await fetchJson(`/api/changes/${encodeURIComponent(id)}`)
    : await createChange(repo, { intent, target_branch: target, choice }).then((c) => (agent ? c : takeOver(c.id)));
  // A new change whose commit fails is closed so it isn't left leased and empty; the commit error is reported, not a failed close.
  await commitFiles(change.fork, { branch: change.target_branch, base_sha, message: intent, changes })
    .catch(async (e) => { if (!id) await changeAct(change.id, "close").catch(() => {}); throw e; });
  return change;
}
// Flows at the head of ref (flows.jsx): list is GET /flows (FlowList), head is ref's head sha. Fixtures serve none.
export async function flowsFor(repo, ref) {
  if (fixtures()) return { head: null, list: [] };
  const base = `/api/repos/${encodeURIComponent(repo.name)}`, at = `?ref=${encodeURIComponent(ref)}`;
  const list = await fetchJson(`${base}/flows${at}`), { ok, errors } = validateFlowList(list);
  if (!ok) throw new Error(`${base}/flows: ${errors.join("; ")}`);
  // No flow to read head from: the root tree's sha is it (a ref with no commit is a 404, so no head).
  const head = list[0]?.head ?? (await fetchJson(`${base}/tree${at}&path=`).catch((e) => (e.status === 404 ? null : Promise.reject(e))))?.sha ?? null;
  return { head, list };
}
// GET /api/repos/:name/environments → Environment[]; none when the repo has no deploy manifest (404). Fixtures serve none.
export async function environmentsFor(repo) {
  if (fixtures()) return [];
  const path = `/api/repos/${encodeURIComponent(repo)}/environments`;
  return checked(path, await fetchJson(path).catch((e) => (e.status === 404 ? [] : Promise.reject(e))), validateEnvironment);
}
export async function environmentTree(repo, env) {
  const path = `/api/repos/${encodeURIComponent(repo)}/environments/${encodeURIComponent(env)}/tree`;
  const body = await fetchJson(path);
  const { ok, errors } = validateEnvironmentTree(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}
const runChecked = (run) => {
  const { ok, errors } = validateFlowRun(run);
  if (!ok) throw new Error(`flow run: ${errors.join("; ")}`);
  return run;
};
export const startFlowRun = async (repo, flow, ref) => runChecked(await postJson(`/api/repos/${encodeURIComponent(repo)}/flows/${encodeURIComponent(flow)}/runs`, { ref }));
// GET /api/repos/:name/flow-runs → FlowRun[], newest first. Fixtures serve none.
export const flowRuns = async (repo) => (fixtures() ? [] : (await fetchJson(`/api/repos/${encodeURIComponent(repo)}/flow-runs`)).map(runChecked));
// GET /api/repos/:name/code-search?ref&q → [{path, line, text}]. Fixtures serve none.
export async function searchCode(repo, ref, q) {
  if (fixtures()) return [];
  const path = `/api/repos/${encodeURIComponent(repo)}/code-search?ref=${encodeURIComponent(ref)}&q=${encodeURIComponent(q)}`;
  return checked(path, await fetchJson(path), validateCodeHit);
}

// The Code page's Commits view: a page of ref's commits (CodeLog), or with a sha that commit's diff (CommitDiff).
// lazy: fixture mode has no history; add log and diff fixtures when the demo needs them.
// Log pages are kept while the Code page stays open, so a file switch reuses the Commits card's.
export const commitsFor = (repo, ref, page, sha) => (sha ? readCommits(repo, ref, page, sha) : keep(logs, `${repo}\n${ref}\n${page}`, () => readCommits(repo, ref, page)));
async function readCommits(repo, ref, page, sha) {
  if (fixtures()) return { commits: [], more: false };
  const at = `ref=${encodeURIComponent(ref)}`;
  const path = `/api/repos/${encodeURIComponent(repo)}/${sha ? `commits/${encodeURIComponent(sha)}?${at}` : `log?${at}&page=${encodeURIComponent(page)}`}`;
  const body = await fetchJson(path);
  const { ok, errors } = (sha ? validateCommitDiff : validateCodeLog)(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// POST /api/changes/:id/review {verdict: approve|request_changes|comment, body}; an @agent body also goes to the agent
// through POST /api/changes/:id/messages. Fixture mode posts nothing.
export async function reviewChange(id, verdict, body) {
  if (fixtures()) return;
  const path = `/api/changes/${encodeURIComponent(id)}`;
  await postJson(`${path}/review`, { verdict, body });
  if (/@agent\b/.test(body)) await postJson(`${path}/messages`, { text: body });
}

// POST /api/changes/:id/reviewers {person} | {agent_version}. Fixture mode posts nothing.
export async function requestReviewer(id, kind, name) {
  if (fixtures()) return;
  await postJson(`/api/changes/${encodeURIComponent(id)}/reviewers`, { [kind]: name });
}

// POST /api/changes/:id/{close|ready|takeover|release|approve} from the Change detail header. Fixture mode posts nothing.
export const changeAct = (id, act, body = {}) => postJson(`/api/changes/${encodeURIComponent(id)}/${act}`, body);

// POST /api/changes/:id/takeover: the person drives the change and its agent pauses.
export const takeOver = (id) => postJson(`/api/changes/${encodeURIComponent(id)}/takeover`);

// A fixtures build has no server: every write answers null.
export async function postJson(path, body, method = "POST") {
  if (fixtures()) return null;
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // Even a failed write may have changed something.
  invalidate();
  if (!res.ok) {
    const { message, code } = (await res.json().catch(() => null))?.error ?? {};
    throw Object.assign(new Error(`${method} ${path} → ${res.status} ${message ?? res.statusText}`), { status: res.status, code });
  }
  // Some routes answer 202 with no body (messages).
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Managed worker pools: create (path ""), /:id/scale, /:id/assign (PUT), /:id/drain, /:id/undrain.
export const poolAct = (path, body, method) => postJson(`/api/workers${path}`, body, method);

// The live intent box: fixtures serve intent-hints.json and the page guesses; live, the worker's preview predicts.
export const hintsFor = async (repo) => (fixtures() ? (await list("/api/intent-hints")).filter((h) => h.repo_id === repo.id) : null);

// POST /api/repos/:name/changes/preview: predicted symbols, collisions and risk for a draft intent. Fixture mode returns null.
export async function previewChange(repo, intent, target) {
  if (fixtures()) return null;
  const path = `/api/repos/${encodeURIComponent(repo)}/changes/preview`;
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent, target }) });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${(await res.json().catch(() => null))?.error?.message ?? res.statusText}`);
  const body = await res.json();
  const { ok, errors } = validateChangePreview(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// The worker serves judges per repo, so live the page merges every repo's series; airlock reads on if any repo has it.
export async function getJudges(weeks) {
  if (fixtures()) return judges;
  const repos = await list("/api/repos");
  const bodies = await Promise.all(repos.map(async (r) => {
    const path = `/api/repos/${encodeURIComponent(r.name)}/judges${weeks ? `?weeks=${weeks}` : ""}`;
    const body = await fetchJson(path);
    const { ok, errors } = validateJudges(body);
    if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
    // A series is (kind, backend, model_version) within one repo; the API sends no id or name for it yet.
    return { ...body, judges: body.judges.map((j) => ({ id: `${r.name}:${j.kind}:${j.backend}@${j.model_version}`, name: `${j.backend} · ${r.name}`, repo: r.name,
      min_outcomes: j.config?.min_outcomes ?? body.trust?.min_outcomes ?? null, ...j })) };
  }));
  return { airlock: bodies.some((b) => b.airlock), judges: bodies.flatMap((b) => b.judges), repos: repos.map((r) => r.name) };
}

// A root README, with or without an extension (README, README.md, readme.txt).
export const README = /^readme(\.[^/]*)?$/i;
// The Code page: fixtures serve code-page.json; live, the tree at ref, the open file (the README at the root), its
// leases and the repo's open changes. A ref with no commits shows the empty state.
// The open file's history is its commits from /log; head is the ref's commit, the base of a commit from the page.
// Leases are the lease map's (every file's, for the tree); the open file's symbols, the lines a lease bands, are ref's index.
// Tree walks by repo and ref, kept while the Code page stays open: moving between its files reuses the levels loaded.
// Blobs are kept by ref, the commit sha they were read at and path (a workspace store can report its base's sha); a failed read is dropped so the next one retries.
// Changes, the lease map and symbols are kept the same way; done holds the answer once it lands.
const trees = new Map(), blobs = new Map(), logs = new Map(), wide = new Map();
export const forgetTrees = () => { trees.clear(); blobs.clear(); logs.clear(); wide.clear(); };
// A live event: changes, leases and symbols refetch; a kept tree (and the commit logs) reload only once its ref's head moved.
export async function refreshCode(repo) {
  wide.clear();
  await Promise.all([...trees].filter(([key]) => key.startsWith(`${repo}\n`)).map(async ([key, kept]) => {
    const ref = key.slice(repo.length + 1);
    const [was, now] = await Promise.all([kept.catch(() => null), getObject(`/api/repos/${encodeURIComponent(repo)}/tree${codeAt(ref, "")}&recursive=1`, validateCodeTree).catch(() => null)]);
    // A failed read drops the tree too, so the reload reports it.
    if (trees.get(key) === kept && (!now || now.sha !== was?.head)) { trees.delete(key); logs.clear(); }
  }));
}
const keepDone = (key, load) => {
  const p = keep(wide, key, load);
  p.then((v) => { p.done = v; }, () => {}); // a failure surfaces where the page awaits it
  return p;
};
const keep = (map, key, load) => {
  if (!map.has(key)) map.set(key, load().catch((e) => { map.delete(key); throw e; }));
  return map.get(key);
};
const codeAt = (ref, p) => `?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(p)}`;
function treeOf(repo, ref) {
  return keep(trees, `${repo}\n${ref}`, async () => {
    const tree = await getObject(`/api/repos/${encodeURIComponent(repo)}/tree${codeAt(ref, "")}&recursive=1`, validateCodeTree);
    return { paths: tree.entries.filter((e) => e.type === "blob").map((e) => e.path), remote: tree.remote ?? null, head: tree.sha };
  });
}
// Each repo's last branch and tag list: the branch menu draws it at once, and the Code page splits slash refs with it.
export const branchLists = new Map();
// A listed ref has no longer ref under it (git can't hold branches main and main/x), so a path under it needs no fresh list.
export async function refNames(repo, ref) {
  let list = branchLists.get(repo);
  if (!list?.some((b) => b.name === ref)) branchLists.set(repo, list = await branchesFor(repo));
  return list.map((b) => b.name);
}

// Whether ref has a tree: one that fails other than 404 counts, for the page to report.
export const hasRef = async (repo, ref) => fixtures() || treeOf(repo, ref).then(() => true, (e) => e.status !== 404);

export async function codeFor(repo, ref, path) {
  if (fixtures()) return get("/api/code-page");
  const base = `/api/repos/${encodeURIComponent(repo)}`;
  const at = (p) => codeAt(ref, p);
  let paths, remote = null, head = null;
  // A file named by the URL is asked for alongside a tree not loaded yet; a failure surfaces where the page awaits it.
  const early = path && !trees.has(`${repo}\n${ref}`) ? getObject(`${base}/file${at(path)}`, validateCodeFile) : null;
  early?.catch(() => {});
  try {
    ({ paths, remote, head } = await treeOf(repo, ref));
  } catch (e) {
    if (e.status !== 404) throw e;
    paths = [];
    // An unknown ref opens the repo's default branch; missing names the ref asked for.
    const fallback = e.code === "ref_not_found" && (await fetchJson(base)).default_branch;
    if (fallback && fallback !== ref) return { ...await codeFor(repo, fallback, path), missing: ref, ref: fallback };
  }
  const open = path || paths.find((p) => README.test(p));
  const isFile = !!path && paths.includes(path);
  // The content never waits on history or blame: they arrive as late, {history, blame} or {error}.
  const late = isFile ? Promise.all([getObject(`${base}/log${at(path)}`, validateCodeLog), getObject(`${base}/authorship${at(path)}`, validateAuthorship)])
    .then(([log, authorship]) => ({ history: historyOf(log), blame: blameOf(authorship.lines) }), (e) => ({ error: e.message })) : null;
  // The content never waits on repo-wide data either: until it lands the page has none and wide brings the whole page.
  const parts = [keepDone(`${repo}\nchanges`, () => fetchJson(`${base}/changes`)), paths.length ? keepDone(`${repo}\nlease-map`, () => getLeaseMap(repo)) : { leases: [] },
    isFile ? keepDone(`${repo}\n${ref}\nsymbols`, () => fetchJson(`${base}/symbols?target=${encodeURIComponent(ref)}`)) : null];
  const file = paths.includes(open) ? await keep(blobs, `${repo}\n${ref}\n${head}\n${open}`, () => (open === path && early) || getObject(`${base}/file${at(open)}`, validateCodeFile)) : null;
  const build = ([all, { leases, edges = [] }, symbols]) => {
    const changes = checked(`${base}/changes`, all, validateChange).filter((c) => !DONE_STATES.includes(c.state))
      // The holder is who drives: the person who took over, else the agent (named by its card once its develop stage ran).
      .map((c) => ({ id: c.id, title: c.title, intent: c.intent, state: c.state, driver: c.driver ?? null,
        ...(c.driver ? { agent: c.driver, ver: null } : c.ver ? { agent: c.agent, ver: c.ver }
          : c.agent_version ? { agent: c.agent_version.split("@")[0], ver: c.agent_version.split("@")[1] || "pending" } : { agent: "agent", ver: "pending" }) }));
    const syms = (symbols?.symbols ?? []).filter((s) => s.path === path).map((s) => ({ name: s.name, from: s.start, to: s.end }));
    const body = {
      risk_judge: { name: "none", count: 0 }, changes, history: [], remote, head,
      leases: leases.filter((l) => changes.some((c) => c.id === l.holder)).map((l) => ({ ...l, symbol: l.symbol.split("#")[1] ?? l.symbol, collision: strongest(edges, l.holder) })),
      files: paths.map((p) => (p === open && file ? { path: p, text: file.content ?? "", sha: file.content === null ? null : file.sha, ws: {}, syms, blame: [], ...(isFile && { history: [] }) }
        : { path: p, text: "", ws: {}, syms: [], blame: [] })),
    };
    const { ok, errors } = validateCodePage(body);
    if (!ok) throw new Error(`${base}/code: ${errors.join("; ")}`);
    return late ? { ...body, late } : body;
  };
  if (parts.every((p) => !(p instanceof Promise) || p.done)) return build(parts.map((p) => (p instanceof Promise ? p.done : p)));
  return { ...build([[], { leases: [] }, null]), wide: Promise.all(parts).then(build) };
}
const historyOf = (log) => log.commits.map((c) => ({ sha: c.sha.slice(0, 7), intent: c.message.split("\n")[0] || c.sha, agent: c.author || "unknown", ver: null, date: c.date ?? null }));
// One blame range per run of lines from the same commit; null until the blame job reports.
function blameOf(lines) {
  const blame = lines && [];
  lines?.forEach((l, i) => {
    const last = blame.at(-1);
    if (last?.commit === l.commit) last.to = i + 1;
    else blame.push({ from: i + 1, to: i + 1, commit: l.commit, change: l.change ?? l.commit, ...(l.person ? { agent: l.person, ver: null } : { agent: l.agent.split("@")[0], ver: l.agent.split("@")[1] ?? null }) });
  });
  return blame;
}

// Wiki pages (worker/src/wiki.js). lazy: no fixture mode; add tree and page fixtures when the page needs a demo.
const wikiPath = (repo, rest) => `/api/repos/${encodeURIComponent(repo)}/wiki${rest}`;
const whole = (path, body, validate) => {
  const { ok, errors } = validate(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
};
export const wikiTree = async (repo) => {
  const path = wikiPath(repo, "/tree");
  return whole(path, await fetchJson(path), validateWikiTree);
};
export const wikiPage = async (repo, id) => {
  const path = wikiPath(repo, `/pages/${encodeURIComponent(id)}`);
  return whole(path, await fetchJson(path), validateWikiPage);
};
export const wikiHistory = async (repo, id) => {
  const path = wikiPath(repo, `/pages/${encodeURIComponent(id)}/history`);
  return checked(path, await fetchJson(path), validateWikiVersion);
};
export const wikiSearch = async (repo, q) => {
  const path = wikiPath(repo, `/search?q=${encodeURIComponent(q)}`);
  return checked(path, await fetchJson(path), validateWikiSearchHit);
};
// {from, to, lines}: lines prefixed " ", "-" or "+". lazy: no contract validator yet; lines only render as text.
export const wikiDiff = (repo, id, from, to) => fetchJson(wikiPath(repo, `/pages/${encodeURIComponent(id)}/diff?from=${from}&to=${to}`));
export const wikiComments = async (repo, id) => {
  const path = wikiPath(repo, `/pages/${encodeURIComponent(id)}/comments`);
  return checked(path, await fetchJson(path), validateWikiComment);
};
// Every wiki write (save, create, move, delete, restore, comments) under /api/repos/:repo/wiki; a stale save throws with status 409.
export const wikiWrite = (repo, rest, body, method = "POST") => postJson(wikiPath(repo, rest), body, method);

// The signed-in person; the fixture is the owner signed in through Access.
export async function getMe() {
  const me = await load("/api/me", { email: "owner@example.com", owner: true });
  const { ok, errors } = validateMe(me);
  if (!ok) throw new Error(`/api/me: ${errors.join("; ")}`);
  return me;
}
// My model access (/me/models). The agent wizard reads provider status from it too, fresh on every call.
export async function modelAccess() {
  const body = await fetchJson("/api/me/models");
  const { ok, errors } = validateModelAccess(body);
  if (!ok) throw new Error(`/api/me/models: ${errors.join("; ")}`);
  return body;
}
// Automation › Agents (automation-agents.jsx): the registry with the fleet's figures from AI Gateway, and every race.
export async function agentsPage() {
  const [agents, fleet, races] = await Promise.all([fetchJson("/api/agents"), fetchJson("/api/fleet"), fetchJson("/api/races")]);
  const { ok, errors } = validateFleet(fleet);
  if (!ok) throw new Error(`/api/fleet: ${errors.join("; ")}`);
  return { agents: checked("/api/agents", agents, validateAgent), fleet, races: checked("/api/races", races, validateRaceSummary) };
}
// One agent's prompt and draft model, and its races newest first with their first leg's change (none for inherited history).
export async function agentDetail(name) {
  const [agent, races] = await Promise.all([fetchJson(`/api/agents/${encodeURIComponent(name)}`), fetchJson(`/api/races?agent=${encodeURIComponent(name)}`)]);
  const changes = await Promise.all(checked("/api/races", races, validateRaceSummary).slice(0, 5).map((r) => !r.id.startsWith("inherited:") && fetchJson(`/api/changes/${encodeURIComponent(r.legs[0].change_id)}`)));
  return { agent, races: races.map((r, i) => ({ ...r, change: changes[i] || null })) };
}
export const modelCatalog = async () => checked("/api/models/catalog", await fetchJson("/api/models/catalog"), validateCatalogModel);
const repoApi = (repo, rest) => `/api/repos/${encodeURIComponent(repo)}${rest}`;
export const createRepo = (body) => postJson("/api/repos", body);
export const putAccount = (body) => postJson("/api/account", body, "PUT");

// Releases and changes (worker/src/releases.js, changes.js): GET /api/repos/:repo{/tags,/releases,/changes}. Fixtures serve none.
const REPO_LISTS = { "/tags": validateTag, "/releases": validateRelease, "/changes": validateChange };
export async function repoList(repo, rest) {
  if (fixtures()) return [];
  const path = repoApi(repo, rest);
  return checked(path, await fetchJson(path), REPO_LISTS[rest]);
}
export const repoPost = (repo, rest, body, method) => postJson(repoApi(repo, rest), body, method);
