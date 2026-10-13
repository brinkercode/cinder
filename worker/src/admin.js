// POST /api/admin/reset: a Workflow returns a nonprod deployment (CINDER_ENV=nonprod) to an empty state so it can be reseeded.
// Owner, Access and Worker secrets, AI Gateway and the Secrets Store itself, and the D1 schema are left alone.
import { WorkflowEntrypoint } from "cloudflare:workers";
import sources from "../../seed/bundle.json";
import { demo } from "../../seed/demo.mjs";
import { client, commitRelease, resetAll, seed } from "../../seed/seed.mjs";
import { isOwnerEmail, personOf } from "./access.js";
import { AGENTS_REPO } from "./agents.js";
import { createArtifacts } from "./artifacts.js";
import { cloudflare } from "./deploy.js";
import { APP_SECRET, rebind } from "./keystore.js";
import { removeKey } from "./model-access.js";
import worker from "./index.js";
import { error } from "./router.js";
import { WIKI_REPO } from "./wiki.js";

const owner = (request, env) => {
  const me = personOf(request);
  return me === "owner" || isOwnerEmail(env, me);
};

// POST /api/admin/reset → 202 {id}: starts the ResetWorkflow; GET /api/admin/reset/:id reports its progress.
export async function resetData(request, env) {
  if (!owner(request, env)) return error(403, "forbidden", "only an owner may reset the deployment");
  if (env.CINDER_ENV !== "nonprod") return error(403, "production", "reset runs only where CINDER_ENV is nonprod");
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO resets (id) VALUES (?)").bind(id).run();
  await env.RESET.create({ id });
  return Response.json({ id }, { status: 202 });
}

// → {id, status: running|done|failed, step, counts, error}. counts grows as each store empties: {d1: {table: rows},
// repo_do, change_do, dispatch_do, artifacts, logs, secrets, jobs_cancelled}.
export async function getReset(request, env, { id }) {
  if (!owner(request, env)) return error(403, "forbidden", "only an owner may read a reset");
  const row = await env.DB.prepare("SELECT id, status, step, counts, error FROM resets WHERE id = ?").bind(id).first();
  if (!row) return error(404, "not_found", `no reset ${id}`);
  return Response.json({ ...row, counts: JSON.parse(row.counts) });
}

// POST /api/admin/seed → 202 {id}: the SeedWorkflow resets, then runs every seed section (seed.mjs --full); POST
// /api/admin/demo → 202 {id}: it files the demo scenario (seed/demo.mjs). Its progress is a resets row, which the reset
// keeps, so GET /api/admin/seed/:id is getReset.
const startSeed = (scenario) => async (request, env) => {
  if (!owner(request, env)) return error(403, "forbidden", "only an owner may seed the deployment");
  if (env.CINDER_ENV !== "nonprod") return error(403, "production", "the seed runs only where CINDER_ENV is nonprod");
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO resets (id) VALUES (?)").bind(id).run();
  await env.SEED.create({ id, params: { demo: scenario } });
  return Response.json({ id }, { status: 202 });
};
export const seedData = startSeed(false);
export const startDemo = startSeed(true);

// The seed's own code from seed/, its requests answered by this Worker as the owner; the sources are bundled at build
// (seed/bundle.mjs), so no repo checkout is needed. Every section is idempotent, so a retried step redoes nothing.
export class SeedWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const save = (status, at, err = null) => env.DB.prepare("UPDATE resets SET status = ?, step = ?, error = ? WHERE id = ?").bind(status, at, err, event.instanceId).run();
    const api = client({ url: "https://cinder.internal", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), env, this.ctx) });
    const commit = async ({ repo, ...body }) => (await api("POST", `/api/repos/${repo}/seed`, body)).shas;
    const steps = event.payload?.demo ? [["demo", () => demo(api, commit, sources.pulse)]]
      : [["reset", () => resetAll(api)], ["seed", () => seed(api, commitRelease(api), "all", commit, sources.seed)]];
    let at = steps[0][0];
    try {
      for (const [name, fn] of steps) {
        at = name;
        await save("running", at);
        await step.do(at, async () => { await fn(); });
      }
      await save("done", at);
    } catch (e) {
      await save("failed", at, String(e?.message ?? e));
      throw e;
    }
  }
}

const BATCH = 50;
const chunks = (list) => Array.from({ length: Math.ceil(list.length / BATCH) }, (_, i) => list.slice(i * BATCH, (i + 1) * BATCH));

// Each step stays well inside a request's limits, so the reset no longer grows past them with the data.
// Durable Objects, Artifacts and keys go before D1, whose rows name them, so a failed reset can simply be retried.
export class ResetWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const counts = {};
    const save = (status, at, err = null) => env.DB.prepare("UPDATE resets SET status = ?, step = ?, counts = ?, error = ? WHERE id = ?")
      .bind(status, at, JSON.stringify(counts), err, event.instanceId).run();
    let at = "plan";
    try {
      const plan = await step.do(at, async () => {
        const all = async (sql) => (await env.DB.prepare(sql).all()).results;
        const stored = await createArtifacts(env.ARTIFACTS).list();
        // A change's fork is named by its key, so a fork left behind would collide with the next change given the same number.
        const repos = [...new Set([...(await all("SELECT name FROM repos")).map((r) => r.name), ...(await all("SELECT fork FROM change_numbers")).map((c) => c.fork), ...stored])];
        const changes = (await all("SELECT id FROM changes")).map((c) => c.id);
        const jobs = await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'claimed')").first("n");
        // FTS5 shadow tables belong to their virtual table; emptying the virtual table empties them. resets keeps this run's progress.
        const tables = await all("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT IN ('d1_migrations', 'resets') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'");
        const virtual = tables.filter((t) => /^CREATE VIRTUAL/i.test(t.sql)).map((t) => t.name);
        const names = tables.map((t) => t.name).filter((n) => !virtual.some((v) => n.startsWith(`${v}_`)));
        const rows = await env.DB.batch(names.map((n) => env.DB.prepare(`SELECT count(*) AS n FROM "${n}"`)));
        return { repos, changes, jobs, artifacts: stored.length, d1: Object.fromEntries(names.map((n, i) => [n, rows[i].results[0].n])) };
      });
      Object.assign(counts, { d1: plan.d1, jobs_cancelled: plan.jobs });
      await save("running", at);

      const wipe = (ns, name) => ns.get(ns.idFromName(name)).wipe();
      // Repos go in steps before their changes, so no queue alarm reads a change already wiped.
      const objects = [...chunks(plan.repos.map((n) => [env.REPO_DO, n])), ...chunks([...plan.changes.map((c) => [env.CHANGE_DO, c]), [env.DISPATCH_DO, "global"]])];
      for (const [i, batch] of objects.entries()) {
        at = `objects ${i}`;
        await step.do(at, async () => { await Promise.all(batch.map(([ns, name]) => wipe(ns, name))); });
        await save("running", at);
      }
      Object.assign(counts, { repo_do: plan.repos.length, change_do: plan.changes.length, dispatch_do: 1 });

      // list() returns one page, so the repos cinder names itself go by name too, a missing one skipped. The org wiki comes
      // back empty, as deploy/reconcile.sh made it; the agents repo is remade by the next agents call.
      const artifacts = createArtifacts(env.ARTIFACTS);
      for (const [i, batch] of chunks([...new Set([...plan.repos, AGENTS_REPO, WIKI_REPO])]).entries()) {
        at = `artifacts ${i}`;
        await step.do(at, async () => {
          await Promise.all(batch.map((name) => artifacts.delete(name).catch((e) => { if (!/^Repository not found/.test(e?.message)) throw e; })));
        });
        await save("running", at);
      }
      at = "wiki";
      await step.do(at, async () => { await artifacts.create(WIKI_REPO); });
      counts.artifacts = plan.artifacts;

      // Each page is deleted before the next list, so every list starts at the first key left.
      counts.logs = 0;
      for (let i = 0, more = true; more; i++) {
        at = `logs ${i}`;
        const page = await step.do(at, async () => {
          const { objects: page, truncated } = await env.LOGS.list({ limit: BATCH });
          if (page.length) await env.LOGS.delete(page.map((o) => o.key));
          return { n: page.length, more: truncated };
        });
        counts.logs += page.n;
        more = page.more;
        await save("running", at);
      }

      // A model key's gateway provider config goes with its secret.
      at = "keys";
      const secrets = await step.do(at, async () => {
        const keys = (await env.DB.prepare("SELECT config_id, secret_id FROM model_providers WHERE config_id IS NOT NULL OR secret_id IS NOT NULL").all()).results;
        for (const key of keys) await removeKey(env, key);
        return keys.filter((k) => k.secret_id).length;
      });

      // Deferred foreign keys let the tables empty in any order; sqlite_sequence restarts AUTOINCREMENT ids so a reseed
      // writes the same ids; the account rows are the ones a migration inserts.
      at = "d1";
      await step.do(at, async () => {
        await env.DB.batch([env.DB.prepare("PRAGMA defer_foreign_keys = ON"), ...Object.keys(plan.d1).map((n) => env.DB.prepare(`DELETE FROM "${n}"`)),
          env.DB.prepare("DELETE FROM sqlite_sequence"), env.DB.prepare("INSERT OR IGNORE INTO account (id, name) VALUES (1, 'cinder')"),
          env.DB.prepare("INSERT OR IGNORE INTO accounts (id, name, slug, created_at) VALUES ('instance', 'cinder', 'instance', ?)").bind(new Date().toISOString())]);
      });
      await save("running", at);

      // The Worker drops its KS_ bindings (no keystore rows are left) before their secrets go.
      at = "secrets";
      counts.secrets = secrets + await step.do(at, async () => {
        await rebind(env);
        const stores = `/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores`;
        let n = 0;
        for (const { id: store } of (await cloudflare(env, stores)).result) {
          // lazy: one page of 100, the account's Secrets Store cap (keystore.js LIMIT); page through if the cap rises.
          for (const s of (await cloudflare(env, `${stores}/${store}/secrets?per_page=100`)).result.filter((s) => APP_SECRET.test(s.name))) {
            await cloudflare(env, `${stores}/${store}/secrets/${s.id}`, { method: "DELETE" });
            n++;
          }
        }
        return n;
      });
      await save("done", at);
    } catch (e) {
      await save("failed", at, String(e?.message ?? e));
      throw e;
    }
  }
}
