import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_KINDS, validateAgent, validateAgentDiff, validateAgentVersionDetail, validateJob, validateStageRecord } from "../src/api/contract.js";
import agentVersions from "../src/api/fixtures/agent-versions.json";
import worker from "../src/index.js";
import { lineDiff } from "../src/agents.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path) => exports.default.fetch(`http://cinder.test${path}`, { headers: OWNER });

async function seed() {
  for (const v of agentVersions) {
    await env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(v.id, v.name, v.version, v.harness, v.model, v.effort, v.prompt_hash, JSON.stringify(v.tools), JSON.stringify(v.limits)).run();
  }
  await env.DB.prepare("INSERT OR IGNORE INTO channels (agent_name, channel, version) VALUES ('dev', 'stable', 1), ('dev', 'canary', 2)").run();
}

beforeAll(() => { env.ARTIFACTS = fakeArtifacts(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("agents api", () => {
  it("registry lists versions and stable channel", async () => {
    await seed();
    const list = await (await call("/api/agents")).json();
    for (const agent of list) expect(validateAgent(agent), agent.name).toEqual({ ok: true, errors: [] });
    expect(list.map((a) => a.name)).toEqual(["dev", "resolver"]);

    const res = await call("/api/agents/dev");
    expect(res.status).toBe(200);
    const dev = await res.json();
    expect(validateAgent(dev)).toEqual({ ok: true, errors: [] });
    expect(dev.versions).toEqual(agentVersions.filter((v) => v.name === "dev").map((v) => ({ ...v, released_at: null, egress: null, wins: 0, races: 0, runs: 0, merged: 0, decided: 0 })));
    expect(dev.channels).toEqual([{ channel: "canary", version: 2 }, { channel: "stable", version: 1 }]);
  });

  it("unknown agent → 404", async () => {
    const res = await call("/api/agents/nobody");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toEqual({ code: "not_found", message: "no agent nobody" });
  });

  it("unknown version for a channel → 404", async () => {
    await seed();
    const move = (version) => exports.default.fetch("http://cinder.test/api/agents/dev/channels/stable",
      { method: "PUT", headers: OWNER, body: JSON.stringify({ version }) });
    const res = await move(9);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toEqual({ code: "not_found", message: "no version 9 of agent dev" });
    expect((await move(2)).status).toBe(200);
    expect((await (await call("/api/agents/dev")).json()).channels).toEqual([{ channel: "canary", version: 2 }, { channel: "stable", version: 2 }]);
  });

  // Puts a draft of dev that changes v1 (tools bash+edit, max_cost_usd 8, web raw) by `change`, then diffs v1 → draft.
  async function draftDiff(change) {
    await seed();
    const fake = fakeArtifacts();
    (await fake.create("cinder-agents")).files["agents/dev/prompt.md"] = "You are dev.\nWrite tests.";
    const fetch = (path, init) => exports.default.fetch(`http://cinder.test${path}`, { headers: OWNER, ...init });
    const v1 = agentVersions.find((v) => v.id === "agent/dev/v1");
    const draft = { harness: v1.harness, model: v1.model, effort: v1.effort, tools: v1.tools, limits: v1.limits, web: "raw", prompt: "You are dev.\nWrite small tests.", ...change };
    const put = await fetch("/api/agents/dev/draft", { method: "PUT", body: JSON.stringify(draft) });
    expect(put.status).toBe(200);
    const res = await worker.fetch(new Request("http://cinder.test/api/agents/dev/diff?from=1&to=draft", { headers: OWNER }), { ...env, ARTIFACTS: fake });
    expect(res.status).toBe(200);
    const diff = await res.json();
    expect(validateAgentDiff(diff)).toEqual({ ok: true, errors: [] });
    expect(diff.prompt).toEqual([" You are dev.", "-Write tests.", "+Write small tests."]);
    return diff.fields;
  }

  it("added tool flagged as widening", async () => {
    expect(await draftDiff({ tools: ["bash", "edit", "git"] }))
      .toEqual([{ field: "tools", from: ["bash", "edit"], to: ["bash", "edit", "git"], widens: true }]);
  });

  it("a new agent version gets the default list", async () => {
    expect(await draftDiff({})).toEqual([]);
    expect(JSON.parse(await env.DB.prepare("SELECT draft FROM agent_drafts WHERE name = 'dev'").first("draft")).egress).toEqual(["registry.npmjs.org", "proxy.golang.org", "sum.golang.org", "pkg.go.dev", "developer.mozilla.org", "developers.cloudflare.com"]);
  });

  it("adding a host outside the default is flagged as widening", async () => {
    const egress = ["registry.npmjs.org", "proxy.golang.org", "sum.golang.org", "pkg.go.dev", "developer.mozilla.org", "developers.cloudflare.com"];
    expect(await draftDiff({ egress: [...egress, "api.github.com"] }))
      .toEqual([{ field: "egress", from: egress, to: [...egress, "api.github.com"], widens: true }]);
    expect(await draftDiff({ egress: ["pkg.go.dev"] })).toEqual([{ field: "egress", from: egress, to: ["pkg.go.dev"], widens: false }]);
  });

  it("the web setting is part of the version diff", async () => {
    expect(await draftDiff({ web: "markdown" })).toEqual([{ field: "web", from: "raw", to: "markdown", widens: false }]);
    const put = await exports.default.fetch("http://cinder.test/api/agents/dev/draft", { method: "PUT", headers: OWNER, body: JSON.stringify({
      harness: "claude-code", model: "claude-opus-5-5", effort: "high", tools: [], limits: { max_cost_usd: 4, max_minutes: 30 }, prompt: "p", web: "html" }) });
    expect(put.status).toBe(400);
  });

  it("lowered max_usd not flagged", async () => {
    expect(await draftDiff({ limits: { max_cost_usd: 4, max_minutes: 120 } }))
      .toEqual([{ field: "limits.max_cost_usd", from: 8, to: 4, widens: false }]);
  });

  it("creating an agent version with harness claude-code and model GLM 4.6 returns 422", async () => {
    const draft = { harness: "claude-code", model: "GLM 4.6", effort: "high", tools: ["bash"], limits: { max_cost_usd: 4, max_minutes: 30 }, prompt: "p" };
    const res = await worker.fetch(new Request("http://cinder.test/api/agents/seam/draft", { method: "PUT", headers: OWNER, body: JSON.stringify(draft) }), env);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("model_not_for_harness");
  });

  it("a draft with an unsupported harness is refused", async () => {
    const draft = { harness: "pi", model: "anthropic/claude-sonnet-5", effort: "high", tools: [], limits: { max_cost_usd: 4, max_minutes: 30 }, prompt: "p" };
    const res = await worker.fetch(new Request("http://cinder.test/api/agents/seam/draft", { method: "PUT", headers: OWNER, body: JSON.stringify(draft) }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/^harness:/);
  });

  it("saving a draft queues no job and the draft releases", async () => {
    const fake = fakeArtifacts();
    await fake.create("cinder-agents");
    const fetch = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
    const draft = { harness: "claude-code", model: "claude-opus-5-5", effort: "high", tools: ["bash"], limits: { max_cost_usd: 4, max_minutes: 30 }, prompt: "p" };
    const jobs = () => env.DB.prepare("SELECT kind, payload FROM jobs WHERE json_extract(payload, '$.name') = 'saver'").all().then((r) => r.results);
    expect((await fetch("/api/agents/saver/draft", { method: "PUT", body: JSON.stringify(draft) })).status).toBe(200);
    expect(await jobs()).toEqual([]);
    expect(JOB_KINDS).not.toContain("draft");
    expect((await fetch("/api/agents/saver/release", { method: "POST" })).status).toBe(202);
    const queued = await jobs();
    expect(queued.map((j) => j.kind)).toEqual(["release"]);
    expect(JSON.parse(queued[0].payload).draft).toEqual(expect.objectContaining(draft));
    await env.DB.prepare("DELETE FROM jobs WHERE json_extract(payload, '$.name') = 'saver'").run();
  });

  it("releasing an agent that declares secrets answers 422", async () => {
    const draft = { harness: "claude-code", model: "claude-opus-5-5", effort: "high", tools: ["bash"], limits: { max_cost_usd: 4, max_minutes: 30 }, prompt: "p", secrets: ["API_KEY"] };
    await env.DB.prepare("INSERT INTO agent_drafts (name, draft, saved_at) VALUES ('leaky', ?, '2026-10-08T00:00:00Z')").bind(JSON.stringify(draft)).run();
    const res = await worker.fetch(new Request("http://cinder.test/api/agents/leaky/release", { method: "POST", headers: OWNER }), env);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("agents_get_no_secrets");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'release' AND json_extract(payload, '$.name') = 'leaky'").first()).n).toBe(0);
  });

  it("a release request with a draft queues one release job; without a draft it answers 409", async () => {
    const fake = fakeArtifacts();
    await fake.create("cinder-agents");
    const fetch = (path, init, headers = OWNER) => worker.fetch(new Request(`http://cinder.test${path}`, { headers, ...init }), { ...env, ARTIFACTS: fake });
    const none = await fetch("/api/agents/fresh/release", { method: "POST" });
    expect(none.status).toBe(409);
    expect((await none.json()).error.code).toBe("no_draft");
    const draft = { harness: "claude-code", model: "claude-opus-5-5", effort: "high", tools: ["bash"], limits: { max_cost_usd: 4, max_minutes: 30 }, prompt: "p" };
    expect((await fetch("/api/agents/fresh/draft", { method: "PUT", body: JSON.stringify(draft) })).status).toBe(200);
    const res = await fetch("/api/agents/fresh/release", { method: "POST" });
    expect(res.status).toBe(202);
    expect(validateJob(await res.json())).toEqual({ ok: true, errors: [] });
    const { results } = await env.DB.prepare("SELECT repo_id, payload FROM jobs WHERE kind = 'release'").all();
    expect(results).toHaveLength(1);
    expect(results[0].repo_id).toBe("cinder-agents");
    expect(JSON.parse(results[0].payload)).toEqual({ name: "fresh", draft: expect.objectContaining({ ...draft, egress: expect.any(Array) }) });
    // The runner that claims it gets write on the agents repo and its remote.
    const { token } = await (await fetch("/api/runners", { method: "POST", body: JSON.stringify({ name: "releaser", kinds: ["release"] }) })).json();
    const claim = await (await fetch("/api/work/claim", { method: "POST", body: JSON.stringify({ kinds: ["release"], slots_free: 1 }) }, { Authorization: `Bearer ${token}` })).json();
    expect(claim.payload.remote).toBe("https://artifacts.fake/cinder/cinder-agents.git");
    expect(fake.calls.filter((c) => c.method === "createToken").map((c) => c.args.slice(0, 2))).toEqual([["cinder-agents", "write"]]);
  });

  it("a release claim while cinder-agents is being created answers 204 and requeues the job", async () => {
    const fake = fakeArtifacts();
    fake.creating = Infinity;
    await fake.create("cinder-agents");
    const fetch = (path, init, headers = OWNER) => worker.fetch(new Request(`http://cinder.test${path}`, { headers, ...init }), { ...env, ARTIFACTS: fake });
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) VALUES (?, 'cinder-agents', 'release', 'queued', ?, '{}')")
      .bind(id, new Date().toISOString()).run();
    const { token } = await (await fetch("/api/runners", { method: "POST", body: JSON.stringify({ name: "releaser", kinds: ["release"] }) })).json();
    const res = await fetch("/api/work/claim", { method: "POST", body: JSON.stringify({ kinds: ["release"], slots_free: 1 }) }, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(204);
    expect(await env.DB.prepare("SELECT status, runner_id FROM jobs WHERE id = ?").bind(id).first()).toEqual({ status: "queued", runner_id: null });
  });

  it("GET /api/agents returns released_at, egress and win rate for a version with recorded races", async () => {
    await seed();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO agent_releases (name, version, egress, released_at) VALUES ('dev', 2, '[\"pkg.go.dev\"]', '2026-10-04T12:00:00.000Z')"),
      env.DB.prepare("INSERT INTO race_legs (change_id, race_id, agent, started_at, won) VALUES ('c1', 'r1', 'dev@v2', 'x', 1), ('c2', 'r2', 'dev@v2', 'x', 0), " +
        "('c3', 'r3', 'dev@v2', 'x', 1), ('c4', 'r4', 'dev@v2', 'x', NULL)"),
    ]);
    const list = await (await call("/api/agents")).json();
    for (const agent of list) expect(validateAgent(agent), agent.name).toEqual({ ok: true, errors: [] });
    const v2 = list.find((a) => a.name === "dev").versions.find((v) => v.version === 2);
    expect(v2).toMatchObject({ released_at: "2026-10-04T12:00:00.000Z", egress: ["pkg.go.dev"], wins: 2, races: 3 });
  });

  it("an old version's prompt and lock are read from its release tag", async () => {
    await seed();
    const fake = fakeArtifacts();
    await fake.create("cinder-agents");
    const repo = fake.repos.get("cinder-agents");
    repo.files["agents/dev/prompt.md"] = "You are dev v2.";
    repo.at = { "agent/dev/v1": { "agents/dev/prompt.md": "You are dev v1." } };
    const get = (version) => worker.fetch(new Request(`http://cinder.test/api/agents/dev/versions/${version}`, { headers: OWNER }), { ...env, ARTIFACTS: fake });
    const res = await get(1);
    expect(res.status).toBe(200);
    const v1 = await res.json();
    expect(validateAgentVersionDetail(v1)).toEqual({ ok: true, errors: [] });
    expect(v1).toMatchObject({ name: "dev", version: 1, model: "claude-opus-5-5", effort: "medium", tools: ["bash", "edit"], web: "raw", prompt: "You are dev v1." });
    expect((await get(9)).status).toBe(404);
    expect((await get("x")).status).toBe(404);
  });

  it("the history names who released each version", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) VALUES ('rj1', 'cinder-agents', 'release', 'done', '2026-10-04T11:00:00.000Z', '{\"name\":\"hist\"}')"),
      env.DB.prepare("INSERT INTO job_requesters (job_id, person) VALUES ('rj1', 'maya@example.com')"),
      env.DB.prepare("INSERT INTO agent_releases (name, version, egress, released_at) VALUES ('hist', 1, '[]', '2026-10-03T12:00:00.000Z'), ('hist', 2, '[]', '2026-10-04T12:00:00.000Z')"),
    ]);
    const released = (await (await call("/api/agents/hist/history")).json()).filter((e) => e.kind === "released");
    expect(released.map((e) => [e.version, e.by])).toEqual([[2, "maya@example.com"], [1, null]]);
  });

  it("@draft runs marked dirty", () => {
    const run = { change_id: "c1", stage: "develop", agent_version: "dev@draft", harness: "claude-code", model: "m", cost_usd: 0, duration_ms: 0, session: "s1", verdict: null, started_at: "2026-10-04T00:00:00Z" };
    expect(validateStageRecord({ ...run, dirty: false }).errors).toEqual(["dirty: must be true for an @draft agent_version"]);
    expect(validateStageRecord({ ...run, dirty: true }).ok).toBe(true);
    expect(validateStageRecord({ ...run, agent_version: "agent/dev/v1", dirty: false }).ok).toBe(true);
  });
});

it("lineDiff of \"a\\n\" against \"\" is exactly one added line", () => {
  expect(lineDiff("", "a\n")).toEqual(["+a"]);
});
