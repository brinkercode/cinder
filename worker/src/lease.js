import { judge } from "./judgments.js";

const MAX_CANDIDATES = 200;
const leaseQuestion = (c) => `Will this intent modify ${c}?`;
const LEASE_GUIDE = "The state holds the intent (a person's one-line request to change this repository) and candidates: symbols as path#name, " +
  "or file paths. Answer yes when doing the intent as written would edit this symbol's body or signature, or this file, including a caller " +
  "that must change because a signature it calls changes. Answer no for a symbol the change only reads, imports or tests unchanged, and for " +
  "one that merely shares a word with the intent. A function the intent names directly is yes.";
// Applied to the raw p while the lease judge is untrusted, and to the calibrated p once it is.
const LEASE_THRESHOLD = 0.3;

// Lowercase words of 3+ characters; camelCase, snake_case and paths are split into their words.
const terms = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

// Symbols ("path#name") and paths at sha whose names share a term with the intent, plus every path owned by an
// owner of a matched path. Symbols first, capped at 200.
// lazy: loads every symbol and owner row of the repo; push the term match into SQL (FTS) past ~50k symbols.
export async function leaseCandidates(db, repo, sha, intent) {
  const want = new Set(terms(intent));
  const shares = (name) => terms(name).some((t) => want.has(t));
  const { results: symbols } = await db.prepare(
    "SELECT DISTINCT path, name FROM symbols WHERE repo_id = ? AND sha = ? ORDER BY path, name",
  ).bind(repo, sha).all();
  const { results: owned } = await db.prepare("SELECT path, owner FROM owners WHERE repo = ? ORDER BY weight DESC, path").bind(repo).all();
  const paths = new Set([...symbols, ...owned].map((r) => r.path).filter(shares));
  const owners = new Set(owned.filter((r) => paths.has(r.path)).map((r) => r.owner));
  const candidates = new Set([
    ...symbols.filter((s) => shares(s.name)).map((s) => `${s.path}#${s.name}`),
    ...paths,
    ...owned.filter((r) => owners.has(r.owner)).map((r) => r.path),
  ]);
  return [...candidates].slice(0, MAX_CANDIDATES);
}

// One System 1 call (kind lease), a noul per candidate. A candidate without an answer (no backend, backend failed)
// stays in the lease: over-leasing costs parallelism, under-leasing costs a late conflict.
// change (optional) links the judgments to the change so enforceLease can score them.
export async function predictLease(env, repo, sha, intent, change) {
  return (await predictSymbols(env, repo, sha, intent, change)).map((s) => s.symbol);
}

// The lease as [{ symbol, p }]: p is P(the intent modifies symbol), null when no judge answered.
export async function predictSymbols(env, repo, sha, intent, change) {
  const candidates = await leaseCandidates(env.DB, repo, sha, intent);
  if (!candidates.length) return [];
  const questions = Object.fromEntries(candidates.map((c, i) => [`c${i}`, { kind: "noul", prompt: leaseQuestion(c), guide: LEASE_GUIDE }]));
  const answers = await judge(env, repo, "lease", { intent, candidates }, questions, change);
  return candidates.map((symbol, i) => ({ symbol, ...answers[`c${i}`] })).filter(({ answer, p }) =>
    // p is for the likelier answer; compare "no" against 1 - threshold so p = 0.3 is not lifted over it by rounding.
    p === null || (answer === "yes" ? p > LEASE_THRESHOLD : p < 1 - LEASE_THRESHOLD),
  ).map(({ symbol, answer, p }) => ({ symbol, p: p === null || answer === "yes" ? p : 1 - p }));
}

// A passing verify of change ({ id, repo_id, target_branch }) that touched these symbols ("path#name"): every lease
// judgment on the change gets its outcome (yes when the candidate, or a symbol in that path, was touched).
export async function scoreLease(env, change, touched) {
  const asked = touched.flatMap((t) => [leaseQuestion(t), leaseQuestion(t.split("#")[0])]);
  await env.DB.prepare(
    "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, actual, answer = actual, ?3 FROM " +
    "(SELECT id, answer, IIF(question IN (SELECT value FROM json_each(?2)), 'yes', 'no') AS actual FROM judgments " +
    "WHERE change_id = ?1 AND kind = 'lease' AND id NOT IN (SELECT judgment_id FROM outcomes))",
  ).bind(change.id, JSON.stringify(asked), new Date().toISOString()).run();
}

// "12-13,4-3" → [[12, 13], [4, 3]]; null when a write carries no ranges.
const spans = (lines) => lines ? lines.split(",").map((r) => r.split("-").map(Number)) : null;
// Two edits of one base conflict when their replaced line ranges overlap or touch, as in git's three-way merge.
const meet = (a, b) => a.some(([s, e]) => b.some(([t, f]) => s <= f + 1 && t <= e + 1));

// A push or final diff of change that wrote these symbols ([{ symbol, kind, lines? }]): written symbols outside the lease
// that no one holds are leased. Returns a conflict ({ theirs, files, hunks, collisions: [{ symbol, kind, holder }] }) when
// another change holds one and their edits really conflict: a write whose lines miss everything the holder wrote in that
// file merges cleanly, so it goes ahead without the lease and the two merge in queue order. A write or a holder with no
// ranges yet (the holder hasn't verified) collides.
// lazy: compares the two diffs' base line numbers, which drift once the target moves; the converge probe catches that.
export async function enforceLease(env, change, writes) {
  const { name } = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first();
  const { overlaps, held } = await env.REPO_DO.get(env.REPO_DO.idFromName(name)).extend(change.target_branch, change.id, writes.map((w) => w.symbol));
  if (!overlaps) return null;
  const real = [];
  for (const h of held) {
    const ours = spans(writes.find((w) => w.symbol === h.symbol).lines);
    const path = h.symbol.split("#")[0];
    const { results } = await env.DB.prepare("SELECT l.lines FROM change_writes w LEFT JOIN change_write_lines l ON l.change_id = w.change_id AND l.symbol = w.symbol " +
      "WHERE w.change_id = ?1 AND (w.symbol = ?2 OR substr(w.symbol, 1, length(?2) + 1) = ?2 || '#')").bind(h.holder, path).all();
    const theirs = results.length && results.every((r) => r.lines) ? results.flatMap((r) => spans(r.lines)) : null;
    if (!ours || !theirs || meet(ours, theirs)) real.push(h);
  }
  return real.length ? {
    theirs: [...new Set(real.map((h) => h.holder))], files: [...new Set(real.map((h) => h.symbol.split("#")[0]))], hunks: [],
    collisions: real.map(({ symbol, holder }) => ({ symbol, kind: writes.find((w) => w.symbol === symbol).kind, holder })),
  } : null;
}
