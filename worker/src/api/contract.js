// API contract v1: the only seam between worker/ and web/. Lifecycle per docs/DESIGN.md §6.
import { validateChangeRepair } from "./shapes/change-repair.js";
import { validateDeployPlan } from "./shapes/deploy-plan.js";

// Hosts every new agent version, and a pool with an empty allowlist, may reach besides its model provider and Artifacts
// read only: a runner container's egress refuses anything but GET and HEAD to them.
export const DEFAULT_EGRESS = ["registry.npmjs.org", "proxy.golang.org", "sum.golang.org", "pkg.go.dev", "developer.mozilla.org", "developers.cloudflare.com"];

export const CHANGE_STATES = [
  "draft", "planned", "leased", "waiting", "developing", "converging", "verifying",
  "needs_fix", "in_queue", "conflict", "resolving", "merged", "failed", "closed",
];
// Every open count leaves these out; a failed change stays open (Blocked) until it is closed.
export const DONE_STATES = ["merged", "closed"];

// "closed" is reachable from every state except the terminal ones (merged, closed).
// A started change goes back to "planned" when the change it is stacked on closes.
// A person's change skips develop: planned or leased goes straight to verifying on its head, as does a push to it in needs_fix.
export const CHANGE_TRANSITIONS = {
  draft: ["planned", "closed"],
  planned: ["leased", "verifying", "closed"],
  leased: ["developing", "verifying", "waiting", "planned", "closed"],
  waiting: ["leased", "developing", "closed"],
  developing: ["verifying", "converging", "conflict", "failed", "planned", "closed"],
  converging: ["developing", "verifying", "needs_fix", "in_queue", "conflict", "planned", "closed"],
  verifying: ["in_queue", "needs_fix", "conflict", "converging", "failed", "planned", "closed"],
  needs_fix: ["developing", "converging", "verifying", "failed", "planned", "closed"],
  in_queue: ["merged", "converging", "needs_fix", "conflict", "planned", "closed"],
  conflict: ["resolving", "planned", "closed"],
  resolving: ["verifying", "conflict", "failed", "planned", "closed"],
  merged: [],
  failed: ["verifying", "closed"],
  closed: [],
};

export function canTransition(from, to) {
  return Object.hasOwn(CHANGE_TRANSITIONS, from) && CHANGE_TRANSITIONS[from].includes(to);
}

export const JOB_KINDS = [
  "index", "develop", "verify", "converge", "merge", "resolve", "review",
  "seam", "split", "guard", "release", "history", "commit", "blame", "scan", "ingest-sarif", "refs", "compare", "flow",
];

export const JUDGMENT_KINDS = [
  "lease", "collision", "seam", "risk", "flake", "guard", "split", "resembles_vuln",
];

// The question each kind of judge answers, in plain words; one per JUDGMENT_KINDS entry.
export const KIND_QUESTIONS = {
  lease: "Will these two changes need the same symbol?",
  collision: "Will these two changes collide before both merge?",
  seam: "Is the overlap a shared interface both changes need?",
  risk: "Will this be reverted or break its target within 7 days?",
  flake: "Is this test failure a flake?",
  guard: "Will verification pass on the first try?",
  split: "Should this change be split?",
  resembles_vuln: "Does this change resemble a known vulnerability?",
};

export const JUDGMENT_SOURCES = ["live", "inherited"];

export const ACTOR_TYPES = ["human", "agent", "verifier", "system"];
// Every change event's action is `<resource>.<verb>` from this registry.
export const EVENT_ACTIONS = ["change.create", "change.lease", "change.close", "change.converge", "change.push", "job.claim", "job.report", "stage.decide", "pipeline.check", "preview.upload", "reviewer.remove", "change.edit"];

// In rank order: a later one is claimed first (DispatchDO) and outranks on a lease wait. The same P0–P3 scale as issues; unset is P2.
export const CHANGE_PRIORITIES = ["P3", "P2", "P1", "P0"];
export const BRANCH_STRATEGIES = ["trunk", "gitflow", "release", "custom"];
export const HARNESSES = ["claude-code", "codex", "opencode"];

// A rule is (value, path) => errors[].
const rule = (desc, ok) => (v, path) => (ok(v) ? [] : [`${path}: expected ${desc}`]);
const str = rule("non-empty string", (v) => typeof v === "string" && v.length > 0);
const bool = rule("boolean", (v) => typeof v === "boolean");
const time = rule("ISO timestamp", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
const int = (min) => rule(`integer >= ${min}`, (v) => Number.isInteger(v) && v >= min);
const nonNeg = rule("number >= 0", (v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
const prob = rule("number in [0, 1]", (v) => typeof v === "number" && v >= 0 && v <= 1);
const oneOf = (list) => rule(`one of ${list.join(", ")}`, (v) => list.includes(v));
const optional = (r) => Object.assign((v, path) => r(v, path), { optional: true });
const nullable = (r) => (v, path) => (v === null ? [] : r(v, path));
const listOf = (r, min = 0) => (v, path) =>
  Array.isArray(v) && v.length >= min
    ? v.flatMap((x, i) => r(x, `${path}[${i}]`))
    : [`${path}: expected array with at least ${min} item(s)`];
const object = (fields) => (v, path) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [`${path || "value"}: expected object`];
  return Object.entries(fields).flatMap(([k, r]) => {
    const p = path ? `${path}.${k}` : k;
    return Object.hasOwn(v, k) ? r(v[k], p) : r.optional ? [] : [`${p}: required`];
  });
};

const validator = (r, ...extra) => (value) => {
  let errors = r(value, "");
  if (errors.length === 0) errors = extra.flatMap((check) => check(value));
  return { ok: errors.length === 0, errors };
};

const branchPolicy = object({
  integration: listOf(str, 1),
  release: listOf(str),
  check: str,
});

const outcome = object({ judgment_id: str, actual: str, correct: bool, observed_at: time });

export const validateBranchPolicy = validator(branchPolicy);

export const validateRepo = validator(object({
  id: str,
  name: str,
  default_branch: str,
  strategy: oneOf(BRANCH_STRATEGIES),
  branch_policy: branchPolicy,
  created_at: time,
  description: optional(rule("string", (v) => typeof v === "string")),
  language: optional(nullable(str)),
  status: optional(oneOf(["importing", "failed", "ready"])),
  // True while the repo has no commits: its pages show empty states instead of data.
  empty: optional(bool),
}));

export const validateChange = validator(object({
  id: str,
  repo_id: str,
  // The change's per-repo number and key (PULSE-12); null for a change recorded without one.
  number: optional(nullable(int(1))),
  key: optional(nullable(str)),
  kind: oneOf(["change", "promote", "seam"]),
  title: str,
  intent: str,
  target_branch: str,
  // A change opened from a pushed branch (New change from a branch); absent when an agent writes it.
  head_branch: optional(str),
  // A change from a branch: the person who drives it, and whether agents may push to it.
  driver: optional(nullable(str)),
  agent_pushes: optional(bool),
  // The agent picked on New change ("name@version"); it develops the change and the list shows it.
  agent_version: optional(str),
  priority: optional(oneOf(CHANGE_PRIORITIES)),
  labels: optional(listOf(str)),
  state: oneOf(CHANGE_STATES),
  fork: str,
  stacked_on: nullable(str),
  risk: nullable(prob),
  head_sha: optional(nullable(str)),
  // The list's diff stats for head_sha; null until a compare of that head has reported.
  adds: optional(nullable(int(0))),
  dels: optional(nullable(int(0))),
  // The change's latest commit job until it is done: queued waits for a runner, claimed is running.
  commit_job: optional(nullable(object({ status: oneOf(["queued", "claimed", "failed"]), path: str }))),
  // The web renders it as a link, so only https is allowed.
  deploy_plan: optional(nullable((v, path) => validateDeployPlan(v).errors.map((e) => `${path}.${e}`))),
  // A merge that landed without a signature (the Worker had no signing key yet).
  unsigned: optional(bool),
  // A failed change's last failed step, from the event that moved it to failed.
  // check: the tests failing at the head, comma-separated; absent when none reported.
  failure: optional(object({ stage: str, reason: nullable(str), check: optional(str) })),
  // An open change's guard blocker (a quarantine or an unapproved dependency), worded as its Needs you item.
  blocked: optional(str),
  // Who closed a closed change and when, with the optional reason they gave.
  closed_by: optional(str),
  closed_at: optional(time),
  close_reason: optional(str),
  repair: optional((v, path) => validateChangeRepair(v).errors.map((e) => `${path}.${e}`)),
  created_at: time,
  updated_at: time,
}));

export const validateChangeEvent = validator(object({
  id: str,
  change_id: str,
  kind: str,
  from_state: nullable(oneOf(CHANGE_STATES)),
  to_state: nullable(oneOf(CHANGE_STATES)),
  at: time,
  actor: object({ type: oneOf(ACTOR_TYPES), id: str, agent_version: optional(str), runner: optional(str), name: optional(str) }),
  action: oneOf(EVENT_ACTIONS),
  target: str,
  result: str,
  reason: optional(str),
}), (v) =>
  v.from_state && v.to_state && !canTransition(v.from_state, v.to_state)
    ? [`to_state: ${v.from_state} -> ${v.to_state} is not an allowed transition`]
    : [],
(v) => (v.actor.type === "agent" && !Object.hasOwn(v.actor, "agent_version") ? ["actor.agent_version: required for agent events"] : []));

export const validateJob = validator(object({
  id: str,
  repo_id: str,
  kind: oneOf(JOB_KINDS),
  change_id: nullable(str),
  status: oneOf(["queued", "claimed", "done", "failed"]),
  runner_id: nullable(str),
  lease_expires_at: nullable(time),
  created_at: time,
}));

// GET /api/workers returns a list of these. slots is the slots_free last reported on a claim; pool is null when self-hosted.
export const validateRunner = validator(object({
  id: str,
  name: str,
  kinds: listOf(oneOf(JOB_KINDS), 1),
  slots: nullable(int(0)),
  last_heartbeat_at: nullable(time),
  online: bool,
  created_at: time,
  pool: nullable(str),
  claims: listOf(object({ job: str, kind: oneOf(JOB_KINDS), change_id: nullable(str), lease_expires_at: nullable(time) })),
}));

export const validateQueueEntry = validator(object({
  repo_id: str,
  target_branch: str,
  change_id: str,
  position: int(0),
  speculative_base: nullable(str),
  enqueued_at: time,
  blocker: nullable(str),
}));


export const validateJudgment = validator(object({
  id: str,
  repo_id: str,
  change_id: nullable(str),
  kind: oneOf(JUDGMENT_KINDS),
  backend: str,
  model_version: str,
  state_hash: str,
  question: str,
  answer: str,
  probability: prob,
  made_at: time,
  source: oneOf(JUDGMENT_SOURCES),
  outcome: nullable(outcome),
}), (v) =>
  v.outcome && v.outcome.judgment_id !== v.id ? ["outcome.judgment_id: must match id"] : []);

const bin = object({ lo: prob, hi: prob, count: int(1), mean_p: prob, observed: prob });
// One ISO week (week is its Monday, YYYY-MM-DD, UTC) of outcomes observed; brier is null when there were none.
const week = object({ week: str, count: int(0), brier: nullable(prob) });

export const validateJudge = validator(object({
  kind: oneOf(JUDGMENT_KINDS),
  backend: str,
  model_version: str,
  // A configured judge with no outcomes yet has count 0, brier null and no bins. count, brier and bins cover the ?weeks= window;
  // total (the outcomes trust counts) and trusted are all time.
  count: int(0),
  total: optional(int(0)),
  trusted: bool,
  brier: nullable(prob),
  bins: listOf(bin),
  // Calls that fell back to the default verdict in the last 7 days, with the newest reason.
  health: oneOf(["healthy", "degraded", "failing"]),
  reason: nullable(str),
  fallbacks: int(0),
  // The newest verdicts, newest first; change_id is null for inherited history, correct is null until the outcome is known.
  recent: listOf(object({ repo: str, change_id: nullable(str), p: prob, correct: nullable(bool), made_at: optional(time) })),
  // Earlier series of this kind (a model the judge ran before a swap), each with its own calibration.
  // since/until are the series' first and last made_at; trend is the Brier per week over the last ?weeks= weeks, oldest first.
  history: optional(listOf(object({ backend: str, model_version: str, count: int(0), trusted: bool, brier: nullable(prob),
    bins: optional(listOf(bin)), since: optional(time), until: optional(time), trend: optional(listOf(week)) }))),
  // The current series' first made_at, null before its first judgment.
  since: optional(nullable(time)),
  trend: optional(listOf(week)),
  // Shown on /judges; GET /api/repos/:name/judges doesn't send id, name or type yet.
  id: optional(str),
  name: optional(str),
  type: optional(oneOf(["System 1", "Statistical", "Person", "Agent reviewer"])),
  question: optional(str),
  // Outcomes on judgments imported from history.
  inherited: optional(int(0)),
}));

export const validateStageRecord = validator(object({
  change_id: str,
  stage: oneOf(JOB_KINDS),
  agent_version: str,
  harness: oneOf(HARNESSES),
  model: str,
  cost_usd: nonNeg,
  duration_ms: int(0),
  session: str,
  verdict: nullable(oneOf(["pass", "fail"])),
  dirty: bool,
  started_at: time,
  // Either [in, out, cache] (the board card's breakdown) or a plain total; insights counts the total and the cache reads (cache_reads, or the triple's third).
  tokens: optional(rule("[in, out, cache] integers >= 0, or an integer >= 0", (v) => Number.isInteger(v) ? v >= 0 : Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0))),
  cache_reads: optional(int(0)),
  // Read by later stages' if: as stages.<stage>.outputs.<k>.
  outputs: optional(object({})),
}), (v) => (v.agent_version.endsWith("@draft") && !v.dirty ? ["dirty: must be true for an @draft agent_version"] : []));

export const validateAgentVersion = validator(object({
  id: str,
  name: str,
  version: int(1),
  harness: oneOf(HARNESSES),
  model: str,
  effort: str,
  prompt_hash: str,
  tools: listOf(str),
  limits: object({ max_cost_usd: nonNeg, max_minutes: int(1) }),
  // Served by GET /api/agents from the release tag's lock and recorded races; null until a release is recorded.
  released_at: optional(nullable(time)),
  egress: optional(nullable(listOf(str))),
  // markdown: the agent reads web pages as Markdown (asked for, else converted from HTML); raw: as served.
  web: optional(oneOf(["markdown", "raw"])),
  wins: optional(int(0)),
  races: optional(int(0)),
  // The changes the version wrote, those merged, and those merged, failed or closed.
  runs: optional(int(0)),
  merged: optional(int(0)),
  decided: optional(int(0)),
}));

// A converge that could not rebase cleanly, or a write to a symbol another change leases. ours is the change; theirs
// are the changes it collided with.
export const validateConflictObject = validator(object({
  id: str,
  repo_id: str,
  ours: str,
  theirs: listOf(str),
  files: listOf(str, 1),
  hunks: listOf(object({ file: str })),
  // A lease collision: each written symbol another change (holder) holds, and whether the write changed its signature or body.
  collisions: optional(listOf(object({ symbol: str, kind: oneOf(["signature", "body"]), holder: str }))),
  status: oneOf(["open", "resolved"]),
  detected_at: time,
  resolved_at: nullable(time),
}));

// New shapes live in their own file under api/shapes/ and are re-exported from shapes.js (one line each, union-merged).
export * from "./shapes.js";
