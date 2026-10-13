import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { validateChange } from "../src/api/contract.js";
import { can } from "../src/people.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

// A change taken through a real verify report on head sha1, with the risk judge answering `answers`.
// `files` are the repo's files on the target, `head` what the fork changes at sha1.
// `pushed`: sha1 is recorded only in change_heads, as a push does, and reading a file without a ref rejects as the binding does.
async function verified(name, answers, { trusted = false, files = {}, head = {}, pushed = false } = {}) {
  const fake = fakeArtifacts();
  const AI = fakeClefAI(async () => ({ risk: answers }));
  const call = (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake, AI },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "drop the users table" })).json();
  // A released reviewer, so an agent route can queue its review job.
  await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES ('agent/reviewer/v1', 'reviewer', 1, 'claude-code', 'm', 'default', 'h', '[]', '{}')"),
    env.DB.prepare("INSERT OR IGNORE INTO channels (agent_name, channel, version) VALUES ('reviewer', 'stable', 1)")]);
  if (trusted) {
    // One scored outcome on the default risk judge, with the repo trusting a judge from one outcome.
    const judgment = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, 1)").bind(change.repo_id),
      env.DB.prepare("INSERT INTO judgments (id, repo_id, change_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, NULL, 'risk', 'clef', 'clef@2', 'h', 'q', 'low', 0.1, ?)")
        .bind(judgment, change.repo_id, new Date().toISOString()),
      env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) VALUES (?, 'low', 1, ?)").bind(judgment, new Date().toISOString()),
    ]);
  }
  Object.assign(fake.repos.get(name).files, files);
  Object.assign(fake.repos.get(change.fork).files, files, head);
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  fake.repos.get(name).commits.unshift({ sha: "base1" });
  fake.repos.get(change.fork).commits.unshift({ sha: "sha1" });
  if (pushed) {
    const get = fake.get;
    fake.get = async (n) => {
      const r = await get(n);
      return { ...r, readFile: (o) => o.ref ? r.readFile(o) : Promise.reject(new Error("Invalid ref: ref required")) };
    };
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, 'sha1')").bind(change.id).run();
  } else await stub.moveHead("sha1");
  for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, {
    kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok",
  });
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["verify"] })).json()).token;
  const verify = async () => {
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(job, change.repo_id, change.id, new Date().toISOString()).run();
    expect((await (await call("/api/work/claim", { kinds: ["verify"] }, runner)).json()).job.id).toBe(job);
    return (await call(`/api/work/jobs/${job}/report`, { status: "done" }, runner)).json();
  };
  const report = await verify();
  const queued = async () => (await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(change.id).first()) !== null;
  return { id: change.id, call, stub, report, verify, queued };
}

describe("risk routing", () => {
  it("a verified low-risk change goes straight to in_queue", async () => {
    const { stub, report, queued } = await verified("route-low", { low: 0.9, medium: 0.05, high: 0.05 }, { trusted: true });
    expect(report.change.state).toBe("in_queue");
    expect(await queued()).toBe(true);
    expect((await stub.get()).events.find((e) => e.kind === "routed")).toMatchObject({ result: "auto", reason: expect.stringContaining("trusted true") });
  });

  it("a verified high-risk change enters the queue only after an approval on its head SHA", async () => {
    const { id, call, stub, report, queued } = await verified("route-high", { low: 0.1, medium: 0.1, high: 0.8 }, { trusted: true });
    expect(report.change.state).toBe("verifying");
    expect(report.change.events.at(-1)).toMatchObject({ kind: "routed", result: "human", reason: expect.stringMatching(/^risk high \(p .*, trusted true\)$/) });
    expect(await queued()).toBe(false);
    const approved = await (await call(`/api/changes/${id}/review`, { verdict: "approve" })).json();
    expect(approved.state).toBe("in_queue");
    expect((await stub.get()).approvals).toEqual([{ actor: { type: "human", id: "owner" }, head_sha: "sha1", at: expect.any(String) }]);
    expect(await queued()).toBe(true);
  });

  it("a verified medium-risk change waits for an agent review job, then queues", async () => {
    const { id, call, report, queued } = await verified("route-medium", { low: 0.1, medium: 0.8, high: 0.1 }, { trusted: true });
    expect(report.change.state).toBe("verifying");
    expect(await queued()).toBe(false);
    const reviewer = (await (await call("/api/runners", { name: "rev", kinds: ["review"] })).json()).token;
    const claim = await (await call("/api/work/claim", { kinds: ["review"] }, reviewer)).json();
    expect(claim.job.change_id).toBe(id);
    expect((await (await call(`/api/work/jobs/${claim.job.id}/report`, { status: "done" }, reviewer)).json()).change.state).toBe("in_queue");
    expect(await queued()).toBe(true);
  });

  it("an approval on an older SHA doesn't release the change", async () => {
    const { id, call, stub, verify, queued } = await verified("route-stale", { low: 0.1, medium: 0.1, high: 0.8 }, { trusted: true });
    expect((await (await call(`/api/changes/${id}/review`, { verdict: "approve" })).json()).state).toBe("in_queue");
    // The head moves and the change re-verifies (as after a converge); the sha1 approval must not carry over.
    await env.DB.prepare("DELETE FROM queue_entries WHERE change_id = ?").bind(id).run();
    await runInDurableObject(stub, async (i) => i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "verifying" }));
    await stub.moveHead("sha2");
    const report = await verify();
    expect(report.change.state).toBe("verifying");
    expect(report.change.approvals.map((a) => a.head_sha)).toEqual(["sha1"]);
    expect(await queued()).toBe(false);
  });
});

describe("deploy plan", () => {
  const LOW = { low: 0.9, medium: 0.05, high: 0.05 };
  const manifest = (resources) => `deploy:
  environments:
    - { name: staging, branch: develop }
    - { name: production, branch: main }
  worker: wrangler.json
  resources:
${resources.map((r) => `    - ${r}`).join("\n")}
`;
  const base = {
    ".cinder.yml": manifest(["{ type: d1, name: pulse-db, migrations: migrations }"]),
    "wrangler.json": JSON.stringify({ name: "pulse", main: "index.js", compatibility_date: "2026-01-01" }),
    "migrations/0001_init.sql": "CREATE TABLE users (id TEXT);",
  };

  it("adding a KV resource shows `create kv pulse-cache` for every environment", async () => {
    const { id, call, report } = await verified("plan-kv", LOW, { trusted: true, files: base, head: {
      ".cinder.yml": manifest(["{ type: d1, name: pulse-db, migrations: migrations }", "{ type: kv, name: pulse-cache }"]),
    } });
    expect(report.change.state).toBe("in_queue");
    const change = await (await call(`/api/changes/${id}`, undefined, env.OWNER_TOKEN, "GET")).json();
    expect(change.deploy_plan).toEqual({ destructive: null, environments: [
      { name: "staging", steps: ["create kv pulse-cache", "bind PULSE_CACHE"] },
      { name: "production", steps: ["create kv pulse-cache", "bind PULSE_CACHE"] },
    ] });
    expect(validateChange(change)).toEqual({ ok: true, errors: [] });
  });

  it("a migration with DROP TABLE routes the change to human review", async () => {
    const { report, queued } = await verified("plan-drop", LOW, { trusted: true, files: base, head: {
      "migrations/0002_drop.sql": "DROP TABLE users;",
    } });
    expect(report.change.state).toBe("verifying");
    expect(report.change.review).toMatchObject({ route: "human", reason: "deploy plan migrations/0002_drop.sql drops" });
    expect(report.change.deploy_plan.environments.map((e) => e.steps)).toEqual([["apply migrations/0002_drop.sql"], ["apply migrations/0002_drop.sql"]]);
    expect(await queued()).toBe(false);
  });

  it("a change that touches no deploy file has no plan", async () => {
    const { id, call, report } = await verified("plan-none", LOW, { trusted: true, files: base, head: { "src/app.js": "export {};" } });
    expect(report.change.state).toBe("in_queue");
    expect((await (await call(`/api/changes/${id}`, undefined, env.OWNER_TOKEN, "GET")).json()).deploy_plan).toBeNull();
  });

  it("planning a change whose head is only in change_heads reads that sha and returns a readable plan", async () => {
    const { report } = await verified("plan-pushed", LOW, { trusted: true, pushed: true, files: base, head: {
      ".cinder.yml": manifest(["{ type: d1, name: pulse-db, migrations: migrations }", "{ type: kv, name: pulse-cache }"]),
    } });
    expect(report.change.deploy_plan).toEqual({ destructive: null, environments: [
      { name: "staging", steps: ["create kv pulse-cache", "bind PULSE_CACHE"] },
      { name: "production", steps: ["create kv pulse-cache", "bind PULSE_CACHE"] },
    ] });
  });

  it("a change with no deploy files is not routed to human review by the deploy plan", async () => {
    const { report } = await verified("plan-pushed-none", LOW, { trusted: true, pushed: true, files: base, head: { "src/app.js": "export {};" } });
    expect(report.change.deploy_plan).toBeNull();
    expect(report.change.review.route).not.toBe("human");
    expect(report.change.state).toBe("in_queue");
  });
});

describe("branch rules", () => {
  const rule = (settings) => ({ ".cinder.yml": `rules:\n  main:\n${Object.entries(settings).map(([k, v]) => `    ${k}: ${v}`).join("\n")}\n` });
  const LOW = { low: 0.9, medium: 0.05, high: 0.05 };

  it("a queued change takes its queue, judges and risk settings from its target branch's rule", async () => {
    // risk 50 lets a trusted medium answer auto-merge; the default 10 sends it to agent review.
    const risky = await verified("rule-risk", { low: 0.1, medium: 0.8, high: 0.1 }, { trusted: true, files: rule({ risk: 50 }) });
    expect(risky.report.change.state).toBe("in_queue");
    expect(await risky.queued()).toBe(true);
    // Two trusted judges needed: the risk judge alone doesn't auto-merge a low-risk change.
    const judged = await verified("rule-judges", LOW, { trusted: true, files: rule({ judges: 2 }) });
    expect(judged.report.change.state).toBe("verifying");
    expect(judged.report.change.events.at(-1)).toMatchObject({ kind: "routed", result: "agent", reason: expect.stringContaining("2 trusted judges needed") });
    // Merge queue off: an auto-routed change waits for a person to queue it.
    const held = await verified("rule-queue", LOW, { trusted: true, files: rule({ queue: false }) });
    expect(held.report.change.events.at(-1)).toMatchObject({ kind: "routed", result: "auto" });
    expect(held.report.change.state).toBe("verifying");
    expect(await held.queued()).toBe(false);
  });
});

describe("account access", () => {
  // Accounts acc-a and acc-b, each with one repo, and people with a Git role on acc-a only.
  async function accounts() {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO accounts (id, name, slug, created_at) VALUES ('acc-a', 'A', 'acc-a', '2026-10-01'), ('acc-b', 'B', 'acc-b', '2026-10-01')"),
      env.DB.prepare("INSERT OR IGNORE INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('ra', 'acc-repo-a', 'main', 'trunk', '{}', '2026-10-01'), ('rb', 'acc-repo-b', 'main', 'trunk', '{}', '2026-10-01')"),
      env.DB.prepare("INSERT OR IGNORE INTO repo_accounts VALUES ('ra', 'acc-a'), ('rb', 'acc-b')"),
      env.DB.prepare("INSERT OR IGNORE INTO account_members VALUES ('acc-a', 'admin@a.com', 'admin', 'direct'), ('acc-a', 'contrib@a.com', 'contributor', 'direct'), ('acc-a', 'maint@a.com', 'maintainer', 'direct'), ('acc-a', 'reader@a.com', 'reader', 'org')"),
    ]);
  }

  it("can() denies repo creation in an account where the caller is a contributor", async () => {
    await accounts();
    expect(await can(env, "contrib@a.com", "POST", "/api/repos", "acc-a")).toBe(false);
    expect(await can(env, "maint@a.com", "POST", "/api/repos", "acc-a")).toBe(false);
    expect(await can(env, "admin@a.com", "POST", "/api/repos", "acc-a")).toBe(true);
    expect(await can(env, "admin@a.com", "POST", "/api/repos", "acc-b")).toBe(false);
    // Contributors still write to the account's repos.
    expect(await can(env, "contrib@a.com", "POST", "/api/repos/acc-repo-a/commits-x", "acc-a")).toBe(true);
  });

  it("an account maintainer may write to that account's repos and not to another account's", async () => {
    await accounts();
    expect(await can(env, "maint@a.com", "POST", "/api/repos/acc-repo-a/branches")).toBe(true);
    expect(await can(env, "maint@a.com", "PUT", "/api/repos/acc-repo-a/policy")).toBe(true);
    expect(await can(env, "maint@a.com", "POST", "/api/repos/acc-repo-b/branches")).toBe(false);
    expect(await can(env, "maint@a.com", "GET", "/api/repos/acc-repo-b")).toBe(false);
    expect(await can(env, "reader@a.com", "GET", "/api/repos/acc-repo-a")).toBe(true);
    expect(await can(env, "reader@a.com", "PUT", "/api/repos/acc-repo-a/policy")).toBe(false);
  });
});
