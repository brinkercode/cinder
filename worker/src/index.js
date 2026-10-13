/* global WebSocketPair -- Workers runtime global, not in the eslint globals sets */
import { DurableObject } from "cloudflare:workers";
import { createArtifacts } from "./artifacts.js";
import { branchHeads } from "./branches.js";
import { CHANGE_PRIORITIES } from "./api/contract.js";
import { QUEUE_HEADS, queueMergeJob } from "./queue.js";
import { isAllowedTarget, refreshPolicy } from "./policy.js";
import { listRefs } from "./git/index.js";
import { onPushes } from "./pushes.js";
import { route } from "./router.js";
import { routes } from "./routes.js";
import { deliver } from "./webhooks.js";
import { runTick } from "./tick.js";
import { autoscale } from "./workers.js";

export { ChangeDO } from "./changes.js";
export { DispatchDO } from "./work.js";
export { PipelineWorkflow } from "./pipeline.js";
export { ResetWorkflow, SeedWorkflow } from "./admin.js";
export { WorkerBasic, WorkerLite, WorkerStandard, WorkerStandard4 } from "./workers.js";
export { ContainerProxy } from "@cloudflare/containers";

// One per repo; owns branch policy, queues and leases as later tickets add them.
// Queues an index job for sha unless one is already queued or running.
function queueIndex(db, repoId, target, sha) {
  return db.prepare(
    "INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) SELECT ?1, ?2, 'index', 'queued', ?3, ?4 " +
    "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE repo_id = ?2 AND kind = 'index' AND status IN ('queued', 'claimed') AND json_extract(payload, '$.sha') = ?5)",
  ).bind(crypto.randomUUID(), repoId, new Date().toISOString(), JSON.stringify({ target, sha }), sha).run();
}

export class RepoDO extends DurableObject {
  // Empties this instance for POST /api/admin/reset (admin.js).
  async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
  // Branch policy from .cinder.yml on the default branch over the global default, re-read when either changes.
  async policy(repo, defaultBranch) {
    const artifacts = createArtifacts(this.env.ARTIFACTS);
    // Head = newest log entry, compared whole because only equality matters.
    const [latest] = await artifacts.log(repo, defaultBranch);
    const head = JSON.stringify(latest ?? null);
    const global = (await this.env.DB.prepare("SELECT policy FROM global_policy").first("policy")) ?? "{}";
    const cached = await this.ctx.storage.get("policy");
    if (cached?.head === head && cached.defaultBranch === defaultBranch && cached.global === global) return cached.policy;
    // base_sha: the head read before the file, sent back by a policy save so a move since then answers 409.
    const policy = { ...(await refreshPolicy(this.env, repo, defaultBranch)), base_sha: latest?.sha ?? null };
    await this.ctx.storage.put("policy", { head, defaultBranch, global, policy });
    return policy;
  }

  // The Code API's ref → commit cache for the store this instance is named after (code.js resolve). Every push gives
  // a new epoch, so a head read from the log before a push is never stored after it.
  async heads() {
    return (await this.ctx.storage.get("code:heads")) ?? { epoch: null, refs: new Map() };
  }
  async setHead(epoch, ref, sha) {
    const { epoch: now, refs } = await this.heads();
    if (now === epoch) await this.ctx.storage.put("code:heads", { epoch, refs: new Map(refs).set(ref, sha) });
  }
  async dropHeads() {
    await this.ctx.storage.put("code:heads", { epoch: crypto.randomUUID(), refs: new Map() });
  }
  // A per-issue claim lock (work-claim.js): true for the one caller that takes it; a lock left by a dead request lapses after a minute.
  async lockClaim(issueId) {
    const key = `claim:${issueId}`;
    if ((await this.ctx.storage.get(key)) > Date.now()) return false;
    await this.ctx.storage.put(key, Date.now() + 60_000);
    return true;
  }
  async unlockClaim(issueId) {
    await this.ctx.storage.delete(`claim:${issueId}`);
  }
  // Code answers addressed by a commit sha, which never change.
  // lazy: never evicted; prune by age once a store's storage nears its limit.
  async cached(key) {
    return this.ctx.storage.get(`code:${key}`);
  }
  async cache(key, value) {
    await this.ctx.storage.put(`code:${key}`, value);
  }
  // The branch list less open_changes: refs, their git fields (branchHeads) and policy roles, recomputed only when the
  // code heads' epoch (dropped by every push event and ref write), the default branch or the global policy changes, so
  // a read on unchanged refs makes no Artifacts call. null: no such repo.
  // lazy: one storage value (2 MiB cap, ~5k refs); split per ref past that.
  async branches(repo, defaultBranch) {
    // The epoch is read before computing: a push meanwhile drops it, so a list stored under the old one is never served.
    const { epoch } = await this.heads();
    const global = (await this.env.DB.prepare("SELECT policy FROM global_policy").first("policy")) ?? "{}";
    const state = JSON.stringify([epoch, defaultBranch, global]);
    const cached = await this.ctx.storage.get("branches");
    if (cached?.state === state) return cached.list;
    const cap = await createArtifacts(this.env.ARTIFACTS).get(repo);
    if (!cap) return null;
    const [policy, heads] = await Promise.all([this.policy(repo, defaultBranch), listRefs(cap).then((refs) => branchHeads(this.env, repo, defaultBranch, refs))]);
    const list = heads.map((b) => ({ ...b, role: policy.integration.includes(b.name) ? "integration" : isAllowedTarget(policy, b.name) ? "release" : "other" }));
    await this.ctx.storage.put("branches", { state, list });
    return list;
  }

  // Live board sockets (hibernation API): the DO can sleep while sockets stay open.
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // A socket that sends {type: "subscribe", run, key} gets that flow job's run.log lines; the attachment outlives hibernation.
  webSocketMessage(ws, message) {
    let m;
    try { m = JSON.parse(message); } catch { return; } // not JSON: nothing a socket can ask for
    if (m?.type === "subscribe" && typeof m.run === "string" && typeof m.key === "string") ws.serializeAttachment({ run: m.run, key: m.key });
  }

  // Change events, and { kind: "lease", target } whenever target's lease table changes. run.log goes only to the
  // sockets subscribed to its run and job.
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      const sub = message.kind === "run.log" && ws.deserializeAttachment();
      if (message.kind !== "run.log" || (sub?.run === message.id && sub.key === message.key)) ws.send(data);
    }
  }

  // work.activity for a change goes out at most once a second: one arriving inside the window is held here, replacing
  // any held before it, and sent when the window ends.
  // lazy: a timer sends the held one, so an object evicted within that second sends it with the change's next activity.
  async activity(message) {
    const key = `activity:${message.change_id}`;
    const { at = 0, held } = (await this.ctx.storage.get(key)) ?? {};
    await this.ctx.storage.put(key, { at, held: message });
    const wait = at + ACTIVITY_MS - Date.now();
    if (wait <= 0) return this.#sendActivity(key);
    if (!held) setTimeout(() => this.#sendActivity(key).catch((err) => console.error(`work.activity: ${err.message}`)), wait);
  }

  async #sendActivity(key) {
    const { held } = (await this.ctx.storage.get(key)) ?? {};
    if (!held) return;
    await this.ctx.storage.put(key, { at: Date.now() });
    this.broadcast(held);
  }

  // An event touched target: its queue head is re-evaluated by one alarm ~250ms out, however many events arrive.
  async touch(repoId, target) {
    const pending = new Set(await this.ctx.storage.get("pending"));
    await this.ctx.storage.put({ repo_id: repoId, pending: [...pending.add(target)] });
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > Date.now() + DEBOUNCE_MS) await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
  }

  // Evaluates the pending targets, plus every queued target once the 60s safety sweep is due. The sweep re-arms
  // while the repo has a queue; the next touch restarts it.
  async alarm() {
    const { repo_id: repoId, pending = [], sweep_at: sweepAt = 0 } = Object.fromEntries(await this.ctx.storage.get(["repo_id", "pending", "sweep_at"]));
    const targets = new Set(pending);
    try {
      if (Date.now() >= sweepAt) {
        const { results } = await this.env.DB.prepare(`SELECT DISTINCT target_branch FROM queue_entries WHERE change_id IN (${QUEUE_HEADS}) AND repo_id = ?`)
          .bind(repoId).all();
        for (const r of results) targets.add(r.target_branch);
        await this.ctx.storage.put("sweep_at", Date.now() + SWEEP_MS);
      }
      for (const target of targets) {
        // Unmarked before its evaluation, so a touch while it runs stays pending for the next wake; marked again if it throws.
        await this.ctx.storage.put("pending", ((await this.ctx.storage.get("pending")) ?? []).filter((t) => t !== target));
        await queueMergeJob(this.env, repoId, target).catch(async (err) => {
          await this.ctx.storage.put("pending", [...new Set([...((await this.ctx.storage.get("pending")) ?? []), target])]);
          throw err;
        });
      }
    } finally {
      // A reset's wipe() can land mid-run and leave no sweep to re-arm.
      const sweep = await this.ctx.storage.get("sweep_at");
      if ((await this.ctx.storage.get("pending"))?.length) await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      else if (targets.size && sweep) await this.ctx.storage.setAlarm(sweep);
    }
  }

  // Symbols at target's head: cached here per target until the head moves, else read from D1 once indexed,
  // else an index job for that head is queued (once) and symbols is null. null when target has no commits.
  // The head comes from the stored code heads, so a restarted object answers without an Artifacts call.
  async symbols(repo, target) {
    const heads = await this.heads();
    let sha = heads.refs.get(target);
    if (!sha) {
      sha = (await createArtifacts(this.env.ARTIFACTS).log(repo.name, target))[0]?.sha;
      if (!sha) return null;
      await this.setHead(heads.epoch, target, sha);
    }
    const key = `symbols:${target}`;
    const cached = await this.ctx.storage.get(key);
    if (cached?.sha === sha) return cached;
    const db = this.env.DB;
    if (await db.prepare("SELECT 1 FROM symbol_indexes WHERE repo_id = ? AND sha = ?").bind(repo.id, sha).first()) {
      const { results } = await db.prepare(
        "SELECT path, name, kind, start_line AS start, end_line AS end, EXISTS (SELECT 1 FROM symbol_exports e WHERE e.repo_id = s.repo_id " +
        "AND e.sha = s.sha AND e.path = s.path AND e.name = s.name AND e.kind = s.kind) AS exported FROM symbols s WHERE repo_id = ? AND sha = ? ORDER BY path, start_line",
      ).bind(repo.id, sha).all();
      for (const s of results) s.exported = s.exported === 1;
      // lazy: one storage value per target (2 MiB cap, ~20k symbols); split by path past that.
      await this.ctx.storage.put(key, { sha, symbols: results });
      return { sha, symbols: results };
    }
    await queueIndex(db, repo.id, target, sha);
    return { sha, symbols: null };
  }

  // Holds change until sha is indexed, queuing its index job (true); false when sha is already indexed.
  // The wait is stored with no I/O after the check, so an index landing meanwhile (putSymbols) still finds it.
  async awaitIndex(repoId, target, sha, change) {
    if (await this.env.DB.prepare("SELECT 1 FROM symbol_indexes WHERE repo_id = ? AND sha = ?").bind(repoId, sha).first()) return false;
    const key = `index_waits:${sha}`;
    await this.ctx.storage.put(key, [...((await this.ctx.storage.get(key)) ?? []), change]);
    await queueIndex(this.env.DB, repoId, target, sha);
    return true;
  }

  // The changes waiting for sha's index; they are no longer held.
  async takeIndexWaits(sha) {
    const key = `index_waits:${sha}`;
    const waits = (await this.ctx.storage.get(key)) ?? [];
    await this.ctx.storage.delete(key);
    return waits;
  }

  // Lease table per target: { [change]: { symbols, granted, priority? } }, in arrival order. A request overlapping another
  // change's granted lease, or a waiter ahead of it on a symbol, stays in the table ungranted (the change waits); a
  // re-grant replaces the change's own entry and keeps its place and priority. One DO per repo and no I/O but storage
  // between read and write, so two concurrent grants can't both win.
  // shared symbols (a merged or pushed seam's) are leased alongside any other holder of them.
  async grant(target, change, symbols, shared = [], priority = "P2") {
    const key = `leases:${target}`;
    const leases = (await this.ctx.storage.get(key)) ?? {};
    const rank = leases[change]?.priority ?? CHANGE_PRIORITIES.indexOf(priority);
    const entry = { symbols, granted: false, ...(rank !== 1 && { priority: rank }), ...(shared.length && { shared }) };
    const order = waitOrder({ ...leases, [change]: entry });
    // A holder's re-grant isn't queued behind waiters.
    const ahead = (c) => !leases[change]?.granted && order.indexOf(c) < order.indexOf(change);
    const overlaps = Object.keys(leases).filter((c) => c !== change && (leases[c].granted || ahead(c)) && overlap(entry, leases[c]));
    await this.ctx.storage.put(key, { ...leases, [change]: { ...entry, granted: !overlaps.length } });
    await this.#stamp(target, change);
    this.broadcast({ kind: "lease", target });
    return overlaps.length ? { granted: false, overlaps } : { granted: true };
  }

  // When change was first granted on target, kept across re-grants: the older grant wins an edit-time collision.
  async #stamp(target, change) {
    const grants = (await this.ctx.storage.get(`grants:${target}`)) ?? {};
    if (!grants[change]) await this.ctx.storage.put(`grants:${target}`, { ...grants, [change]: new Date().toISOString() });
    return grants[change] ?? new Date().toISOString();
  }

  // Edit-time arbitration (edit-check.js): change writes symbols. A free one is leased to change; a held one stays with a
  // locked (verified) holder, or one that outranks change (ranks: id to priority rank, default 1) or ties with an older
  // grant; else change takes it. Returns [{ symbol, holder?, outcome: own | took | held }]. Atomic like extend.
  async arbitrate(target, change, symbols, ranks = {}, locked = []) {
    const key = `leases:${target}`;
    const leases = (await this.ctx.storage.get(key)) ?? {};
    const grants = (await this.ctx.storage.get(`grants:${target}`)) ?? {};
    const covers = (lease, s) => lease.includes(s) || lease.includes(s.split("#")[0]);
    const rank = (c) => ranks[c] ?? 1;
    const at = await this.#stamp(target, change);
    const own = { symbols: [], granted: true, ...leases[change] };
    const out = [];
    let moved = false;
    for (const symbol of new Set(symbols)) {
      if (covers(own.symbols, symbol)) { out.push({ symbol, outcome: "own" }); continue; }
      const holder = Object.keys(leases).find((c) => c !== change && leases[c].granted && covers(leases[c].symbols, symbol));
      const wins = !holder || (!locked.includes(holder) && (rank(change) > rank(holder) || (rank(change) === rank(holder) && at < (grants[holder] ?? ""))));
      if (!wins) { out.push({ symbol, holder, outcome: "held" }); continue; }
      // lazy: a holder leasing the whole path loses the path; split path leases into symbols if that over-takes.
      if (holder) leases[holder] = { ...leases[holder], symbols: leases[holder].symbols.filter((s) => s !== symbol && s !== symbol.split("#")[0]) };
      own.symbols = [...own.symbols, symbol];
      moved = true;
      out.push(holder ? { symbol, holder, outcome: "took" } : { symbol, outcome: "own" });
    }
    if (moved) {
      await this.ctx.storage.put(key, { ...leases, [change]: own });
      this.broadcast({ kind: "lease", target });
    }
    return out;
  }

  // Leases the symbols ("path#name") outside change's lease that no other change's granted lease holds (or its path);
  // held lists [{ symbol, holder }] for the rest. One DO per repo, so the check and the extension are atomic.
  async extend(target, change, symbols) {
    const key = `leases:${target}`;
    const leases = (await this.ctx.storage.get(key)) ?? {};
    const covers = (lease, s) => lease.includes(s) || lease.includes(s.split("#")[0]);
    const own = leases[change] ?? { symbols: [], granted: true };
    const others = Object.keys(leases).filter((c) => c !== change && leases[c].granted);
    const held = [];
    const free = [];
    for (const symbol of symbols.filter((s) => !covers(own.symbols, s))) {
      const holder = others.find((c) => covers(leases[c].symbols, symbol));
      if (holder) held.push({ symbol, holder });
      else if (!free.includes(symbol)) free.push(symbol);
    }
    if (free.length) {
      await this.ctx.storage.put(key, { ...leases, [change]: { ...own, symbols: [...own.symbols, ...free] } });
      this.broadcast({ kind: "lease", target });
    }
    return held.length ? { granted: false, overlaps: [...new Set(held.map((h) => h.holder))], held } : { granted: true };
  }

  // Drops change's entry; each freed symbol goes to its first waiter (waitOrder) once nothing else holds that waiter's
  // symbols or is ahead of it on one. Returns the changes granted.
  async release(target, change) {
    const key = `leases:${target}`;
    const leases = (await this.ctx.storage.get(key)) ?? {};
    delete leases[change];
    const order = waitOrder(leases);
    const granted = [];
    for (const [i, c] of order.entries()) {
      if (leases[c].granted || order.some((o, j) => o !== c && (leases[o].granted || j < i) && overlap(leases[c], leases[o]))) continue;
      leases[c] = { ...leases[c], granted: true };
      granted.push(c);
    }
    await this.ctx.storage.put(key, leases);
    const grants = (await this.ctx.storage.get(`grants:${target}`)) ?? {};
    delete grants[change];
    await this.ctx.storage.put(`grants:${target}`, grants);
    this.broadcast({ kind: "lease", target });
    return granted;
  }

  async leases(target) {
    return (await this.ctx.storage.get(`leases:${target}`)) ?? {};
  }

  // One seam proposal per pair of changes on target; judging the pair again replaces it.
  async proposeSeam(target, proposal) {
    const key = `seams:${target}`;
    await this.ctx.storage.put(key, { ...(await this.ctx.storage.get(key)), [proposal.changes.join(" ")]: proposal });
  }

  // Collision graph on target: an edge [a, b] when the two changes' lease requests overlap, or when a collision
  // judgment (judged: [{ a, b, p }]) has p above COLLISION_THRESHOLD.
  async collisions(target, judged = []) {
    const leases = (await this.ctx.storage.get(`leases:${target}`)) ?? {};
    const ids = Object.keys(leases);
    const edges = [];
    for (const [i, a] of ids.entries()) {
      for (const b of ids.slice(i + 1)) if (leases[a].symbols.some((s) => leases[b].symbols.includes(s))) edges.push([a, b]);
    }
    const linked = (a, b) => edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    for (const { a, b, p } of judged) if (p > COLLISION_THRESHOLD && !linked(a, b)) edges.push([a, b]);
    return edges;
  }
}

// Waiters on a symbol: higher priority first, then arrival (the lease table's key order). An entry without a
// priority is normal.
const waitOrder = (leases) => Object.keys(leases).sort((a, b) => (leases[b].priority ?? 1) - (leases[a].priority ?? 1));
// A path's lease covers every symbol in it, as extend and arbitrate read it.
const within = (a, b) => a === b || a.split("#")[0] === b || b.split("#")[0] === a;
const overlap = (entry, other) => other.symbols.some((s) => entry.symbols.some((e) => within(e, s) && !entry.shared?.includes(e)));

const DEBOUNCE_MS = 250;
const SWEEP_MS = 60_000;
const ACTIVITY_MS = 1000;

// Same default as the lease judge until collision judgments are calibrated.
const COLLISION_THRESHOLD = 0.3;

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const dispatch = (env) => env.DISPATCH_DO.get(env.DISPATCH_DO.idFromName("global"));
// Each isolate arms the tick's alarm on its first request, so it runs after a deploy or reset without the cron.
let armed = false;

export default {
  // Any successful write may have queued a job, so pools scale after it. lazy: one D1 query per write, runner claims included;
  // move to a DispatchDO alarm armed by the job inserts if that shows in D1 reads.
  fetch: async (request, env, ctx) => {
    if (!armed && ctx?.waitUntil) {
      armed = true;
      ctx.waitUntil(dispatch(env).arm().catch(() => { armed = false; }));
    }
    const res = await route(request, env, routes, ctx);
    if (request.method !== "GET" && res.ok && ctx) ctx.waitUntil(autoscale(env));
    if (res.status === 101) return res; // a WebSocket upgrade can't be re-wrapped
    // Copied because responses from fetch() or a DO stub have immutable headers. web/public/_headers sets the same for assets.
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
  queue: async (batch, env) => {
    await (batch.queue === "cinder-webhooks" ? deliver(batch, env) : onPushes(batch, env));
    await autoscale(env);
  },
  scheduled: (controller, env, ctx) => {
    const time = controller.scheduledTime ?? Date.now();
    ctx.waitUntil(dispatch(env).takeSlot(time).then((mine) => mine && runTick(env, time)));
  },
};
