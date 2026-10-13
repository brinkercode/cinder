import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateAgent, validateCatalogEntry, validateJob } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const api = async (method, path, body, token = env.OWNER_TOKEN) =>
  exports.default.fetch(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
let fake;

// What the runner's release does: tag agent/<name>/v<version> with the lock, delivered as Artifacts' push event.
async function released(name, version, d) {
  (fake.repos.get("cinder-agents").at ??= {})[`agent/${name}/v${version}`] = { [`agents/${name}/prompt.md`]: d.prompt };
  const lock = { name, version, harness: d.harness, model: d.model, effort: d.effort, prompt_hash: `sha256:${name}${version}`, tools: d.tools, limits: d.limits, egress: d.egress };
  await env.DB.prepare("INSERT OR IGNORE INTO ref_writes (repo, ref, sha) VALUES ('cinder-agents', ?, ?)").bind(`refs/tags/agent/${name}/v${version}`, "b".repeat(40)).run();
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "cinder-agents" },
    payload: { ref: `refs/tags/agent/${name}/v${version}`, after: "b".repeat(40), commits: [{ message: JSON.stringify(lock) }] } } }] }, env);
}
const DRAFT = { harness: "claude-code", model: "claude-opus-5-5", effort: "default", tools: ["read"], egress: ["pkg.go.dev"], limits: { max_cost_usd: 2, max_minutes: 30 } };

beforeAll(async () => {
  env.ARTIFACTS = fake = fakeArtifacts();
  await fake.create("cinder-agents");
  await released("reviewer", 1, { ...DRAFT, prompt: "You are cinder's reviewer.\n" });
});
afterAll(() => { delete env.ARTIFACTS; });

describe("agent marketplace", () => {
  it("install a template and it appears in Agents at v1", async () => {
    const install = (name, template) => api("POST", `/api/agents/${name}/install`, { template, account_id: "instance", version: 1, channel: "canary" });
    const res = await install("critic", "reviewer");
    expect(res.status).toBe(202);
    expect(validateJob(await res.json())).toEqual({ ok: true, errors: [] });
    expect((await install("critic", "reviewer")).status).toBe(409);
    expect((await install("other", "nobody")).status).toBe(404);

    // The runner claims the release, which copies the template's config and prompt, and tags critic v1.
    const { token } = await (await api("POST", "/api/runners", { name: "releaser", kinds: ["release"] })).json();
    const claim = await (await api("POST", "/api/work/claim", { kinds: ["release"], slots_free: 1 }, token)).json();
    expect(claim.payload).toMatchObject({ name: "critic", draft: { ...DRAFT, prompt: "You are cinder's reviewer.\n" } });
    await released("critic", 1, claim.payload.draft);
    await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done" }, token);

    const critic = (await (await api("GET", "/api/agents")).json()).find((a) => a.name === "critic");
    expect(validateAgent(critic)).toEqual({ ok: true, errors: [] });
    expect(critic.versions.map((v) => v.version)).toEqual([1]);
    expect(critic.channels).toEqual([{ channel: "canary", version: 1 }]);
  });

  it("installing an agent version records its release", async () => {
    // Like the bundled developer, the template has no tools.
    await released("builder", 1, { ...DRAFT, tools: [], prompt: "Build.\n" });
    await api("POST", "/api/agents/builder/publish", { version: 1, description: "Builds.", visibility: "instance" });
    expect((await api("POST", "/api/agents/builder-copy/install", { template: "builder", account_id: "instance", version: 1, channel: "stable" })).status).toBe(202);
    const { token } = await (await api("POST", "/api/runners", { name: "builder-releaser", kinds: ["release"] })).json();
    const claim = await (await api("POST", "/api/work/claim", { kinds: ["release"], slots_free: 1 }, token)).json();
    // The runner's lock for an empty tools list carries tools: null.
    await released("builder-copy", 1, { ...claim.payload.draft, tools: null });
    await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done" }, token);
    const copy = (await (await api("GET", "/api/agents")).json()).find((a) => a.name === "builder-copy");
    expect(copy?.versions.map((v) => [v.version, v.tools])).toEqual([[1, []]]);
    expect(copy.channels).toContainEqual({ channel: "stable", version: 1 });
  });

  it("publish an agent and it appears in the catalog", async () => {
    await released("scribe", 1, { ...DRAFT, prompt: "Write docs.\n" });
    const names = async () => (await (await api("GET", "/api/marketplace")).json()).map((e) => e.name);
    expect(await names()).not.toContain("scribe");

    const publish = (name, description) => api("POST", `/api/agents/${name}/publish`, { version: 1, description, visibility: "instance" });
    expect((await publish("scribe", "")).status).toBe(400);
    expect((await publish("nobody", "x")).status).toBe(404);
    const res = await publish("scribe", "Writes docs.");
    expect(res.status).toBe(200);

    const catalog = await (await api("GET", "/api/marketplace")).json();
    for (const e of catalog) expect(validateCatalogEntry(e), e.name).toEqual({ ok: true, errors: [] });
    expect(catalog.find((e) => e.name === "scribe")).toMatchObject({ name: "scribe", source: "published", description: "Writes docs.",
      tools: ["read"], egress: ["pkg.go.dev"], versions: [1], wins: 0, races: 0 });
    expect(catalog.find((e) => e.name === "reviewer")).toMatchObject({ source: "bundled", description: "You are cinder's reviewer. Review one change's diff against its intent; report blockers, each with a repro command." });
  });

  it("installs pin a version, use the installer's model credentials and budget, and start at 0 outcomes", async () => {
    const limits = { max_cost_usd: 2, max_minutes: 30, max_tokens: 5000, max_tokens_month: 90000 };
    await released("scout", 1, { ...DRAFT, limits, prompt: "Scout v1.\n" });
    await released("scout", 2, { ...DRAFT, limits, prompt: "Scout v2.\n" });
    await env.DB.prepare("INSERT INTO race_legs (change_id, race_id, agent, started_at, won) VALUES ('c-scout', 'r1', 'scout@v1', ?, 1)").bind(new Date().toISOString()).run();
    await api("POST", "/api/agents/scout/publish", { version: 2, description: "Scouts.", visibility: "instance" });
    const team = await (await api("POST", "/api/accounts", { name: "Team", slug: "team" })).json();

    // A maintainer who is only a Git Contributor on the account can't install into it.
    serveCerts();
    await env.DB.prepare("INSERT INTO person_roles (email, role) VALUES ('lee@x.test', 'maintainer')").run();
    await api("POST", `/api/accounts/${team.id}/members`, { person: "lee@x.test", git_role: "contributor" });
    const lee = await as("lee@x.test");
    const asLee = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: lee, body: body && JSON.stringify(body) }), { ...ACCESS, ARTIFACTS: fake });
    expect((await (await asLee("GET", "/api/accounts")).json()).find((a) => a.id === team.id)).toEqual({ id: team.id, name: "Team", slug: "team", can_install: false });
    expect((await asLee("POST", "/api/agents/scout-lee/install", { template: "scout", account_id: team.id, version: 1, channel: "stable" })).status).toBe(403);
    vi.restoreAllMocks();

    expect((await api("POST", "/api/agents/scout-team/install", { template: "scout", account_id: team.id, version: 3, channel: "stable" })).status).toBe(404);
    expect((await api("POST", "/api/agents/scout-team/install", { template: "scout", account_id: team.id, version: 1, channel: "stable" })).status).toBe(202);
    const { token } = await (await api("POST", "/api/runners", { name: "installer", kinds: ["release"] })).json();
    const claim = await (await api("POST", "/api/work/claim", { kinds: ["release"], slots_free: 1 }, token)).json();
    // Pinned to v1's prompt, not the newest; no token limits of the publisher, so the installer's budget governs; and no
    // credentials, so runs use the requester's model access.
    expect(claim.payload).toMatchObject({ name: "scout-team", channel: "stable" });
    expect(claim.payload.draft).toEqual({ ...DRAFT, limits: { max_cost_usd: 2, max_minutes: 30 }, prompt: "Scout v1.\n" });
    await released("scout-team", 1, claim.payload.draft);
    await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done" }, token);

    const installed = (await (await api("GET", "/api/agents")).json()).find((a) => a.name === "scout-team");
    expect(installed.versions.map((v) => [v.version, v.wins, v.races])).toEqual([[1, 0, 0]]);
    expect(await env.DB.prepare("SELECT template, version, account_id, channel, installed_by FROM agent_installs WHERE name = 'scout-team'").first())
      .toEqual({ template: "scout", version: 1, account_id: team.id, channel: "stable", installed_by: "owner" });
    expect((await (await api("GET", "/api/marketplace")).json()).find((e) => e.name === "scout")).toMatchObject({ installs: 1, wins: 1, races: 1 });
  });

  it("refuses to edit a marketplace agent's prompt", async () => {
    await released("locked", 1, { ...DRAFT, prompt: "Locked.\n" });
    await env.DB.prepare("INSERT INTO agent_installs VALUES ('locked', 'reviewer', 1, 'instance', 'stable', 'owner', '2026-01-01')").run();
    const draft = { ...DRAFT, web: "markdown", prompt: "Locked.\n" };
    expect((await (await api("GET", "/api/agents/locked")).json()).marketplace).toBe(true);
    const res = await api("PUT", "/api/agents/locked/draft", { ...draft, prompt: "Changed.\n" });
    expect([res.status, (await res.json()).error.code]).toEqual([409, "prompt_locked"]);
    expect((await api("PUT", "/api/agents/locked/draft", { ...draft, limits: { max_cost_usd: 9, max_minutes: 30 } })).status).toBe(200);
    expect((await (await api("GET", "/api/agents/reviewer")).json()).marketplace).toBe(false);
  });

  it("publishing never exposes secrets or keys", async () => {
    await released("keeper", 1, { ...DRAFT, limits: { max_cost_usd: 2, max_minutes: 30, max_tokens: 777 }, prompt: "Keep.\n" });
    const res = await api("POST", "/api/agents/keeper/publish", { version: 1, description: "Keeps.", visibility: "organization" });
    expect(await res.json()).toEqual({ name: "keeper", version: 1, description: "Keeps.", visibility: "organization" });

    const entry = (await (await api("GET", "/api/marketplace")).json()).find((e) => e.name === "keeper");
    // Only listing fields: no prompt, limits, prompt hash, keys or changes.
    expect(entry).toEqual({ name: "keeper", source: "published", description: "Keeps.", publisher: "instance", harness: "claude-code", model: "claude-opus-5-5",
      tools: ["read"], egress: ["pkg.go.dev"], versions: [1], wins: 0, races: 0, installs: 0, tokens_per_merge: null, visibility: "organization", mine: true });
    expect(validateCatalogEntry({ ...entry, limits: { max_tokens: 777 } }).errors).toEqual(["limits: not a catalog field"]);
    expect(validateCatalogEntry({ ...entry, prompt: "Keep." }).ok).toBe(false);
  });
});
