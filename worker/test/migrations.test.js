import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { JOB_KINDS } from "../src/api/contract.js";
import { applyMigrations } from "./helpers/migrations.js";

// Expected tables come from the migrations themselves, so a task adding a migration never edits this test.
// A table a later migration drops is not expected (lazy: a table re-created after its drop would be missed).
const QUERIES = env.TEST_MIGRATIONS.flatMap((m) => m.queries);
const named = (re) => QUERIES.flatMap((q) => [...q.matchAll(re)].map((r) => r[1]));
const DROPPED = named(/DROP TABLE (?:IF EXISTS )?["`]?(\w+)/gi);
const TABLES = [...new Set(named(/CREATE TABLE (?:IF NOT EXISTS )?["`]?(\w+)/gi))].filter((t) => !DROPPED.includes(t)).sort();

// Filtered in JS: D1 caps bound parameters at 100 per statement, and the schema has about that many tables.
async function tableNames() {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  return results.map((r) => r.name).filter((n) => TABLES.includes(n));
}

describe("D1 migrations", () => {
  it("after applyMigrations every table exists", async () => {
    await applyMigrations(env);
    expect(await tableNames()).toEqual(TABLES);
  });

  it("migrations are idempotent when applied twice", async () => {
    await applyMigrations(env);
    await env.DB.prepare(
      "INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("r1", "cinder", "main", "trunk", "{}", "2026-10-04T00:00:00Z").run();
    await applyMigrations(env);
    // Re-run the raw SQL too, so the schema itself is safe to replay, not only the d1_migrations bookkeeping.
    for (const m of env.TEST_MIGRATIONS) for (const q of m.queries) await env.DB.prepare(q).run();
    expect(await tableNames()).toEqual(TABLES);
    const row = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind("r1").first();
    expect(row).toEqual({ name: "cinder" });
  });

  it("test_runs stores results per sha", async () => {
    await applyMigrations(env);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("r1", "cinder", "main", "trunk", "{}", "2026-10-04T00:00:00Z").run();
    const insert = "INSERT INTO test_runs (repo, sha, test, status, duration) VALUES (?, ?, ?, ?, ?)";
    await env.DB.batch([
      env.DB.prepare(insert).bind("r1", "aaa", "TestX", "fail", 0.5),
      env.DB.prepare(insert).bind("r1", "bbb", "TestX", "pass", 0.25),
    ]);
    const { results } = await env.DB.prepare("SELECT sha, status, duration FROM test_runs WHERE repo = ? AND test = ? ORDER BY sha")
      .bind("r1", "TestX").all();
    expect(results).toEqual([{ sha: "aaa", status: "fail", duration: 0.5 }, { sha: "bbb", status: "pass", duration: 0.25 }]);
    await expect(env.DB.prepare(insert).bind("r1", "aaa", "TestX", "pass", 0).run()).rejects.toThrow();
  });

  it("with an empty pools table after migrations, the managed pools exist", async () => {
    const { results } = await env.DB.prepare("SELECT name, size, min_count, max_count, repo_id, kinds FROM worker_pools ORDER BY name").all();
    expect(results.map((p) => ({ ...p, kinds: JSON.parse(p.kinds) }))).toEqual([
      { name: "build", size: "basic", min_count: 0, max_count: 4, repo_id: null, kinds: JOB_KINDS },
      { name: "toolchains", size: "standard-2", min_count: 0, max_count: 4, repo_id: null, kinds: JOB_KINDS },
    ]);
  });

  it("an edited pool is not reset by the provisioning", async () => {
    await env.DB.prepare("UPDATE worker_pools SET max_count = 9, kinds = '[\"index\"]' WHERE name = 'build'").run();
    for (const m of env.TEST_MIGRATIONS) for (const q of m.queries) await env.DB.prepare(q).run();
    expect(await env.DB.prepare("SELECT max_count, kinds FROM worker_pools WHERE name = 'build'").first()).toEqual({ max_count: 9, kinds: '["index"]' });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM worker_pools").first()).n).toBe(2);
  });

  it("the accounts migration backfills the instance account and assigns every existing repo to it", async () => {
    await applyMigrations(env);
    // The state before the migration: repos and roles, no accounts.
    await env.DB.batch([
      ...["account_members", "repo_accounts", "accounts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
      env.DB.prepare("UPDATE account SET name = 'acme' WHERE id = 1"),
      env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('bf1', 'bf-one', 'main', 'trunk', '{}', '2026-10-01'), ('bf2', 'bf-two', 'main', 'trunk', '{}', '2026-10-01')"),
      env.DB.prepare("INSERT INTO person_roles VALUES ('o@x.com', 'owner'), ('a@x.com', 'admin'), ('m@x.com', 'maintainer'), ('c@x.com', 'contributor'), ('d@x.com', 'developer'), ('v@x.com', 'viewer'), ('k@x.com', 'custom')"),
    ]);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_accounts.sql"));
    // Twice: the backfill is replay-safe.
    for (let i = 0; i < 2; i++) for (const q of migration.queries) await env.DB.prepare(q).run();
    expect(await env.DB.prepare("SELECT id, name, cf_account_id FROM accounts").all()).toMatchObject({ results: [{ id: "instance", name: "acme", cf_account_id: null }] });
    const { results: repos } = await env.DB.prepare("SELECT r.id, a.account_id FROM repos r LEFT JOIN repo_accounts a ON a.repo_id = r.id").all();
    expect(repos.length).toBeGreaterThanOrEqual(2);
    expect(repos.every((r) => r.account_id === "instance")).toBe(true);
    const { results: members } = await env.DB.prepare("SELECT person, git_role, source FROM account_members WHERE account_id = 'instance' ORDER BY person").all();
    expect(members).toEqual([["a@x.com", "admin"], ["c@x.com", "contributor"], ["d@x.com", "contributor"], ["m@x.com", "maintainer"], ["o@x.com", "admin"], ["v@x.com", "reader"]]
      .map(([person, role]) => ({ person, git_role: role, source: "direct" })));
  });
  it("the flow_jobs migration backfills every existing flow job as a run with one job per step", async () => {
    await applyMigrations(env);
    const steps = JSON.stringify([{ name: "lint", stage: "build" }, { name: "test", stage: "build" }, { name: "ship", stage: "deploy" }]);
    const job = (id, flow, status, at, payload = {}) => env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) VALUES (?, 'fj', 'flow', ?, ?, ?)")
      .bind(id, status, at, JSON.stringify({ flow, sha: "s1", ref: "main", trigger: "push", steps: JSON.parse(steps), ...payload }));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('fj', 'fj-repo', 'main', 'trunk', '{}', '2026-10-01')"),
      job("fj-2", "ci", "done", "2026-10-02T00:00:00Z"), job("fj-1", "ci", "failed", "2026-10-01T00:00:00Z"), job("fj-3", "nightly", "queued", "2026-10-03T00:00:00Z"),
      job("fj-new-0", "ci", "queued", "2026-10-04T00:00:00Z", { run_id: "fj-new", key: "build/lint" }),
      env.DB.prepare("INSERT INTO flow_steps (job_id, name, status, logs) VALUES ('fj-1', 'lint', 'passed', ''), ('fj-1', 'test', 'failed', '')"),
    ]);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_flow_jobs.sql"));
    // Twice: the backfill is replay-safe.
    for (let i = 0; i < 2; i++) for (const q of migration.queries) await env.DB.prepare(q).run();
    const { results: runs } = await env.DB.prepare("SELECT id, flow, number, status FROM flow_runs WHERE repo_id = 'fj' ORDER BY id").all();
    expect(runs).toEqual([{ id: "fj-1", flow: "ci", number: 1, status: "failed" }, { id: "fj-2", flow: "ci", number: 2, status: "passed" }, { id: "fj-3", flow: "nightly", number: 1, status: "queued" }]);
    const { results: jobs } = await env.DB.prepare("SELECT run_id, key, status, job_id FROM flow_jobs WHERE run_id LIKE 'fj-%' ORDER BY run_id, key").all();
    expect(jobs.map((j) => [j.run_id, j.key, j.status, j.job_id])).toEqual([
      ["fj-1", "build/lint", "passed", "fj-1"], ["fj-1", "build/test", "failed", "fj-1"], ["fj-1", "deploy/ship", "failed", "fj-1"],
      ["fj-2", "build/lint", "passed", "fj-2"], ["fj-2", "build/test", "passed", "fj-2"], ["fj-2", "deploy/ship", "passed", "fj-2"],
      ["fj-3", "build/lint", "queued", "fj-3"], ["fj-3", "build/test", "queued", "fj-3"], ["fj-3", "deploy/ship", "queued", "fj-3"],
    ]);
    const { results: stepRuns } = await env.DB.prepare("SELECT run_id, job_key, idx, name, status FROM flow_step_runs WHERE run_id LIKE 'fj-%' ORDER BY name").all();
    expect(stepRuns).toEqual([{ run_id: "fj-1", job_key: "build/lint", idx: 0, name: "lint", status: "passed" }, { run_id: "fj-1", job_key: "build/test", idx: 0, name: "test", status: "failed" }]);
  });

  it("Worker test: after migrations the dropped community tables don't exist", async () => {
    await applyMigrations(env);
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('stars', 'topic_pins', 'repo_topics', 'topic_follows', 'topic_descriptions')").all();
    expect(results).toEqual([]);
  });
});
