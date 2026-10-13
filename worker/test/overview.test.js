import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { validateOverview } from "../src/api/contract.js";
import worker from "../src/index.js";
import { can } from "../src/people.js";
import { onPushes } from "../src/pushes.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const GO = "https://git.example.com/acme/go-svc.git";

function setup() {
  const fake = fakeArtifacts({ imports: { [GO]: { "main.go": "", "cmd/x/x.go": "", "web/app.js": "", "README.md": "" } } });
  const call = (path, body, method = body ? "POST" : "GET") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
  return { fake, call };
}
const json = async (res) => (await res).json();
const usage = (repo, tokens, at = new Date().toISOString()) => env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, tokens, cost_usd) " +
  "SELECT ?, id, ?, ?, 0 FROM repos WHERE name = ?").bind(crypto.randomUUID(), at, tokens, repo).run();

describe("Worker tests for overview, archive and budget alerts", () => {
  it("GET /api/overview serves the account, the budget and spend, and per repo description, language, last push, agents and spend", async () => {
    const { fake, call } = setup();
    expect((await call("/api/repos", { name: "ov-go", description: "Go service", import: { url: GO } })).status).toBe(201);
    await call("/api/repos"); // the list finishes the import, which detects the language
    expect((await call("/api/repos", { name: "ov-empty" })).status).toBe(201);
    await usage("ov-go", 1200);
    await usage("ov-go", 999, "2000-01-01T00:00:00.000Z"); // last period's
    const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = 'ov-go'").first();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, runner_id, lease_expires_at, created_at, payload) VALUES (?, ?, 'develop', 'claimed', 'r', ?, ?, '{}')")
      .bind(crypto.randomUUID(), id, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()).run();
    const at = new Date().toISOString();
    // cinder wrote main (a direct push to it is rolled back instead).
    await env.DB.prepare("INSERT INTO ref_writes (repo, ref, sha) VALUES ('ov-go', 'refs/heads/main', 'b')").run();
    await onPushes({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "ov-go" }, payload: { ref: "refs/heads/main", before: "a", after: "b" } } }] }, { ...env, ARTIFACTS: fake });

    const o = await json(call("/api/overview"));
    expect(validateOverview(o)).toEqual({ ok: true, errors: [] });
    expect(o.account).toEqual({ id: env.CF_ACCOUNT_ID ?? null, name: "cinder", git_host: "cinder.test" });
    expect(o.budget).toMatchObject({ tokens: null, spent: 1200, alerts: [] });
    expect(o.repos.find((r) => r.repo_id === id)).toMatchObject({ description: "Go service", language: "Go", agents: 1, spent: 1200 });
    expect(o.repos.find((r) => r.repo_id === id).pushed_at >= at).toBe(true);
    expect(o.repos.find((r) => r.repo_id !== id)).toMatchObject({ description: "", language: null, agents: 0, spent: 0 });

    expect((await call("/api/repos/ov-go/settings", { description: "Edge in Go", language: "Rust" }, "PUT")).status).toBe(204);
    expect((await call("/api/account", { git_host: "Git.Example.com", name: "Acme" }, "PUT")).status).toBe(204);
    expect((await call("/api/account", { git_host: "git.example.com/evil" }, "PUT")).status).toBe(400);
    const edited = await json(call("/api/overview"));
    expect(edited.account).toMatchObject({ name: "Acme", git_host: "git.example.com" });
    expect(edited.repos.find((r) => r.repo_id === id)).toMatchObject({ description: "Edge in Go", language: "Rust" });
  });

  it("an archived repo hides from GET /api/repos and refuses pushes, audited, and unarchiving restores it", async () => {
    const { call } = setup();
    expect((await call("/api/repos", { name: "ov-arch" })).status).toBe(201);
    expect((await call("/api/repos/ov-arch/archive", {})).status).toBe(204);
    expect((await json(call("/api/repos"))).map((r) => r.name)).not.toContain("ov-arch");
    expect((await json(call("/api/overview"))).archived).toEqual([{ name: "ov-arch", archived_at: expect.any(String) }]);
    expect((await call("/api/repos/ov-arch/git-credentials", {})).status).toBe(409);
    const commit = { branch: "main", base_sha: null, message: "x", changes: [{ path: "a", content: "a" }] };
    expect((await call("/api/repos/ov-arch/commits", commit)).status).toBe(409);
    expect((await call("/api/repos/ov-arch/archive", undefined, "DELETE")).status).toBe(204);
    expect((await json(call("/api/repos"))).map((r) => r.name)).toContain("ov-arch");
    const { results } = await env.DB.prepare("SELECT action, actor FROM repo_archive_audit a JOIN repos r ON r.id = a.repo_id WHERE r.name = 'ov-arch' ORDER BY a.id").all();
    expect(results).toEqual([{ action: "archive", actor: "owner" }, { action: "unarchive", actor: "owner" }]);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO person_roles VALUES ('m@example.com', 'maintainer'), ('c@example.com', 'contributor')"),
    ]);
    expect(await can(env, "m@example.com", "POST", "/api/repos/ov-arch/archive")).toBe(true);
    expect(await can(env, "c@example.com", "POST", "/api/repos/ov-arch/archive")).toBe(false);
  });

  it("PUT /api/account sets the budget and its alerts", async () => {
    const { call } = setup();
    await env.DB.prepare("DELETE FROM usage_logs").run(); // the other tests' spend shares this file's D1
    expect((await call("/api/repos", { name: "ov-budget" })).status).toBe(201);
    expect((await call("/api/account", { budget_tokens: 1000, alerts: [80, 50, 80] }, "PUT")).status).toBe(204);
    expect((await call("/api/account", { alerts: [73] }, "PUT")).status).toBe(400);
    await usage("ov-budget", 500);
    expect((await json(call("/api/overview"))).budget).toMatchObject({ tokens: 1000, spent: 500, alerts: [50, 80] });
  });

  it("budget ring spend equals the spend that pauses agents", async () => {
    const { call } = setup();
    await env.DB.batch([env.DB.prepare("DELETE FROM usage_logs"), env.DB.prepare("DELETE FROM model_usage"), env.DB.prepare("DELETE FROM budget_policy")]);
    expect((await call("/api/repos", { name: "ov-ring-a" })).status).toBe(201);
    expect((await call("/api/repos", { name: "ov-ring-b" })).status).toBe(201);
    expect((await call("/api/account", { budget_tokens: 1000 }, "PUT")).status).toBe(204);
    await usage("ov-ring-a", 600);
    await usage("ov-ring-b", 400);
    await usage("ov-ring-a", 999, "2000-01-01T00:00:00.000Z"); // last period's
    const o = await json(call("/api/overview"));
    const account = await json(call("/api/account"));
    expect(o.budget.spent).toBe(1000);
    expect(account).toMatchObject({ spent: o.budget.spent, paused: true });
    expect(o.repos.reduce((n, r) => n + r.spent, 0)).toBe(o.budget.spent);
  });
});
