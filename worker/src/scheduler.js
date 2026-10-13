import { createArtifacts } from "./artifacts.js";
import { startSeam } from "./seam.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const repoOf = (env, id) => env.DB.prepare("SELECT name, default_branch FROM repos WHERE id = ?").bind(id).first();
const leaseEvent = (kind, id) => ({ kind, actor: { type: "system", id: "cinder" }, action: "change.lease", target: id, result: "ok", reason: kind });
const forkHead = async (env, c) => (await createArtifacts(env.ARTIFACTS).log(c.fork, c.target_branch))[0]?.sha ?? null;
const queueDevelop = (env, change, payload) => env.DB.prepare(
  "INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, ?)",
).bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ ...payload, ...(change.agent_version && { agent: change.agent_version }) })).run();

// planned → leased, with a develop job whose payload carries the lease. A change overlapping a running change goes
// on to waiting behind it: stacked on its fork head (policy overlap: stack, the default) or until it merges or closes
// (overlap: wait). Its develop job is queued anyway; claimWork skips it while the change waits.
// Returns the change, or null when it wasn't planned, so scheduling twice queues one develop job.
export async function schedule(env, id, symbols) {
  const stub = changeDO(env, id);
  const change = await stub.transition("leased", leaseEvent("leased", id), {}, "planned");
  if (!change) return null;
  const repo = await repoOf(env, change.repo_id);
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(repo.name));
  const { overlaps } = await repoDO.grant(change.target_branch, id, symbols, [], change.priority);
  if (!overlaps) {
    await queueDevelop(env, change, { lease: symbols, wait_for: null, base: null });
    return change;
  }
  const seam = await seamProposal(env, change, repoDO, overlaps, symbols);
  if (seam) {
    await queueDevelop(env, change, { lease: symbols, wait_for: overlaps[0], base: null });
    await startSeam(env, { id: change.repo_id, name: repo.name }, change.target_branch, seam);
    return stub.get();
  }
  const stack = (await repoDO.policy(repo.name, repo.default_branch)).overlap !== "wait";
  const waiting = await stub.transition("waiting", leaseEvent(stack ? "stacked" : "waiting", id), { stacked_on: stack ? overlaps[0] : null });
  await queueDevelop(env, change, { lease: symbols, wait_for: overlaps[0], base: null });
  return waiting;
}

// A seam for the interface symbols (types, Go-exported funcs, exported JS functions and classes) change's lease shares, unshared, with holders that are
// leased but not started; null when there are none, or when a holder is already a seam (the change stacks on it).
// lazy: matches a symbol's kind at any indexed sha; scope to the target's head once schedule is given the sha.
async function seamProposal(env, change, repoDO, overlaps, symbols) {
  const holders = (await Promise.all(overlaps.map((h) => changeDO(env, h).get()))).filter(Boolean);
  if (holders.some((h) => h.kind === "seam")) return null;
  const leases = await repoDO.leases(change.target_branch);
  const shared = (h) => leases[h.id].symbols.filter((s) => symbols.includes(s) && !leases[h.id].shared?.includes(s));
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT path || '#' || name AS symbol FROM symbols s WHERE repo_id = ? AND path || '#' || name IN (SELECT value FROM json_each(?)) " +
    "AND (kind IN ('type', 'struct', 'interface') OR (kind = 'func' AND unicode(name) BETWEEN 65 AND 90) " +
    "OR (kind IN ('function', 'class') AND EXISTS (SELECT 1 FROM symbol_exports e WHERE e.repo_id = s.repo_id AND e.sha = s.sha " +
    "AND e.path = s.path AND e.name = s.name AND e.kind = s.kind)))",
  ).bind(change.repo_id, JSON.stringify(holders.filter((h) => h.state === "leased").flatMap(shared))).all();
  const interfaces = results.map((r) => r.symbol);
  const dependents = holders.filter((h) => h.state === "leased" && shared(h).some((s) => interfaces.includes(s)));
  return dependents.length ? { changes: [...dependents.map((h) => h.id), change.id], symbols: interfaces, p: 1 } : null;
}

// Starts the changes waiting on `base`: a stacked one once base has pushed (base is verifying), on base's fork head;
// any still waiting once base is merged, closed or failed, if its lease is now free (else it waits on the next holder).
// lazy: json_extract scans the repo's develop jobs; index wait_for past ~10k jobs.
export async function unblock(env, base) {
  const pushed = base.state === "verifying";
  if (!pushed && !["merged", "closed", "failed"].includes(base.state)) return;
  if (base.state !== "failed") await restack(env, base);
  const { results } = await env.DB.prepare(
    "SELECT j.id, j.change_id, j.payload FROM jobs j JOIN changes c ON c.id = j.change_id AND c.state = 'waiting' " +
    "WHERE j.kind = 'develop' AND j.status = 'queued' AND json_extract(j.payload, '$.wait_for') = ?",
  ).bind(base.id).all();
  for (const job of results) {
    const stub = changeDO(env, job.change_id);
    const change = await stub.get();
    const payload = JSON.parse(job.payload);
    const repo = await repoOf(env, change.repo_id);
    const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(repo.name));
    if (pushed) {
      if (change.stacked_on !== base.id) continue;
      // `onto`, not `base`: the runner reads `base` as a string (a review's verified target sha), and an object there
      // fails the claim's payload parse, so a stacked change could never start.
      payload.onto = { fork: base.fork, sha: await forkHead(env, base) };
      // A seam's dependent starts on its head and leases its symbols, the seam's shared with the other dependents.
      // lazy: starts even when the rest of its lease is now held (its entry waits); re-check once that is seen.
      if (payload.shared) await repoDO.grant(change.target_branch, change.id, payload.lease, payload.shared);
    } else {
      const { overlaps } = await repoDO.grant(change.target_branch, change.id, payload.lease, payload.shared);
      payload.wait_for = overlaps?.[0] ?? null;
    }
    await env.DB.prepare("UPDATE jobs SET payload = ? WHERE id = ?").bind(JSON.stringify(payload), job.id).run();
    if (pushed) await stub.transition("leased", leaseEvent("base_pushed", change.id));
    // A stack whose base closed unpushed starts on the target instead.
    else if (!payload.wait_for) await stub.transition("leased", leaseEvent("lease_free", change.id), { stacked_on: null });
  }
}

// Moves the started changes stacked on `base` with it. When base pushes again or merges, a dependent in needs_fix or
// in_queue converges onto base's new head (its fork head, or the target once merged, which ends the stack); others
// are not moved. When base closes, every started dependent is cancelled and scheduled again on the target.
// lazy: json_extract scans the repo's develop jobs; index wait_for past ~10k jobs.
async function restack(env, base) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT j.change_id FROM jobs j JOIN changes c ON c.id = j.change_id " +
    "AND c.state NOT IN ('draft', 'planned', 'waiting', 'merged', 'failed', 'closed') " +
    "WHERE j.kind = 'develop' AND json_extract(j.payload, '$.wait_for') = ?",
  ).bind(base.id).all();
  for (const { change_id: id } of results) {
    const stub = changeDO(env, id);
    const change = await stub.get();
    if (change.stacked_on !== base.id) continue;
    if (base.state === "closed") {
      if (!(await stub.transition("planned", leaseEvent("base_closed", id), { stacked_on: null }))) continue;
      await env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE change_id = ? AND status IN ('queued', 'claimed')")
        .bind(id).run();
      await releaseLease(env, change);
      // Leased afresh with its develop job's lease: it starts again on the target, or waits behind whoever holds the lease now.
      const lease = await env.DB.prepare("SELECT json_extract(payload, '$.lease') AS lease FROM jobs WHERE change_id = ? AND kind = 'develop' ORDER BY created_at DESC LIMIT 1")
        .bind(id).first("lease");
      await schedule(env, id, JSON.parse(lease ?? "[]"));
      continue;
    }
    if (change.state !== "needs_fix" && change.state !== "in_queue") continue;
    const merged = base.state === "merged";
    const onto = merged ? null : { fork: base.fork, sha: await forkHead(env, base) };
    if (!(await stub.transition("converging", {
      kind: "base_moved", actor: { type: "system", id: "cinder" }, action: "change.converge", target: id, result: "ok", reason: "base_moved",
    }, merged ? { stacked_on: null } : {}))) continue;
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'converge', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, id, new Date().toISOString(),
        JSON.stringify({ target: change.target_branch, return_to: change.state, theirs: [{ id: base.id, intent: base.intent }], onto })).run();
  }
}

// Frees change's lease and starts the waiting changes its symbols went to. lapse (an expiry, or a failure the change
// can come back from) keeps the symbols, so its next develop or verify job is claimable only once it re-acquires them.
export async function releaseLease(env, change, lapse = false) {
  const repo = await repoOf(env, change.repo_id);
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(repo.name));
  const symbols = (await repoDO.leases(change.target_branch))[change.id]?.symbols;
  await (lapse && symbols
    ? env.DB.prepare("INSERT OR REPLACE INTO lease_lapses (change_id, symbols) VALUES (?, ?)").bind(change.id, JSON.stringify(symbols))
    : env.DB.prepare("DELETE FROM lease_lapses WHERE change_id = ?").bind(change.id)).run();
  for (const id of await repoDO.release(change.target_branch, change.id)) {
    await env.DB.prepare("UPDATE jobs SET payload = json_set(payload, '$.wait_for', NULL) WHERE change_id = ? AND kind = 'develop' AND status = 'queued' " +
      "AND change_id IN (SELECT id FROM changes WHERE state = 'waiting')").bind(id).run();
    await changeDO(env, id).transition("leased", leaseEvent("lease_free", id), { stacked_on: null }, "waiting");
  }
}

// Releases the lease of each change idle past its repo's window (.cinder.yml lease.idle_minutes, default 30) with no
// live job: parked in needs_fix or conflict, or developing under a person's takeover. Idle counts from its last event.
// The change gets a lease_expired event and re-acquires the lease before it continues (reacquireLeases).
// lazy: one ChangeDO read per parked change each run; keep the last event's time in D1 past a few hundred.
export async function expireLeases(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    "SELECT c.id FROM changes c WHERE c.state IN ('needs_fix', 'conflict', 'developing') AND c.id NOT IN (SELECT change_id FROM lease_lapses) " +
    "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.change_id = c.id AND j.status = 'claimed' AND j.lease_expires_at > ?)",
  ).bind(new Date(now).toISOString()).all();
  for (const { id } of results) {
    const stub = changeDO(env, id);
    const change = await stub.get();
    if (!change || (change.state === "developing" && !change.driver)) continue;
    const repo = await repoOf(env, change.repo_id);
    const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(repo.name));
    const minutes = Number((await repoDO.policy(repo.name, repo.default_branch)).lease?.idle_minutes ?? 30);
    const idleSince = Date.parse(change.events.at(-1)?.at ?? change.updated_at);
    if (now - idleSince < minutes * 60_000 || !(await repoDO.leases(change.target_branch))[id]) continue;
    await releaseLease(env, change, true);
    await repoDO.broadcast(await stub.stageEvent({
      ...leaseEvent("lease_expired", id), reason: `idle over ${minutes} minutes in ${change.state}; the lease must be re-acquired before work continues`,
    }));
  }
}

// A lapsed change with a develop or verify job queued re-requests its lease, at the back of each symbol's waiters; once
// granted the job is claimable again.
// lazy: runs on every claim; move to the job inserts if lapsed changes pile up.
export async function reacquireLeases(env) {
  const { results } = await env.DB.prepare(
    "SELECT l.change_id, l.symbols, c.target_branch, r.name FROM lease_lapses l JOIN changes c ON c.id = l.change_id JOIN repos r ON r.id = c.repo_id " +
    "WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.change_id = l.change_id AND j.kind IN ('develop', 'verify') AND j.status = 'queued' " +
    "AND j.id NOT IN (SELECT job_id FROM job_cancels))",
  ).all();
  for (const r of results) {
    const priority = (await changeDO(env, r.change_id).get())?.priority;
    const { granted } = await env.REPO_DO.get(env.REPO_DO.idFromName(r.name)).grant(r.target_branch, r.change_id, JSON.parse(r.symbols), [], priority);
    if (granted) await env.DB.prepare("DELETE FROM lease_lapses WHERE change_id = ?").bind(r.change_id).run();
  }
}
