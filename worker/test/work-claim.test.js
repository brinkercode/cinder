import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateAgentSuggestion, validateWorkItem } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const fake = fakeArtifacts();
const call = (path, { method = "POST", body, headers } = {}) => worker.fetch(
  new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}`, ...headers }, body: body && JSON.stringify(body) }),
  { ...env, ARTIFACTS: fake },
);
const claim = (repo, n, body) => call(`/api/repos/${repo}/issues/${n}/claim`, { body });
const linked = async (repo, n) => (await env.DB.prepare("SELECT l.change_id AS id FROM issue_links l JOIN issues i ON i.id = l.issue_id " +
  "JOIN repos r ON r.id = i.repo_id WHERE r.name = ? AND i.number = ?").bind(repo, n).all()).results.map((r) => r.id);
const itemOf = async (repo, n) => (await (await call(`/api/repos/${repo}/work`, { method: "GET" })).json()).items.find((i) => i.n === n);

// A repo whose target head is not indexed yet, so a new change stays planned (progress), with issue #1.
async function setup(name) {
  expect((await call("/api/repos", { body: { name } })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  fake.repos.get(name).commits.push({ sha: "a".repeat(40), message: "init" });
  expect((await call(`/api/repos/${name}/issues`, { body: { title: "Cart overflows" } })).status).toBe(201);
}

describe("work claim", () => {
  it("a runner can't claim past its stored slots by sending a larger slots_free", async () => {
    await setup("wc-slots");
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = 'wc-slots'").first("id");
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'ingest-sarif', NULL, 'queued', ?, '{}')")
        .bind(crypto.randomUUID(), repo, new Date().toISOString()).run();
    }
    const { token } = await (await call("/api/runners", { body: { name: "wc-slots", kinds: ["ingest-sarif"], slots: 2 } })).json();
    const take = () => call("/api/work/claim", { body: { kinds: ["ingest-sarif"], slots_free: 99 }, headers: { Authorization: `Bearer ${token}` } });
    expect([(await take()).status, (await take()).status, (await take()).status]).toEqual([200, 200, 204]);
  });

  it("claim mode agent creates a change linked to #n with the chosen agent and the item moves to progress", async () => {
    await setup("wc-agent");
    expect((await itemOf("wc-agent", 1)).lane).toBe("intent");
    const res = await claim("wc-agent", 1, { mode: "agent", agents: ["developer@v3"] });
    expect(res.status).toBe(201);
    const item = await res.json();
    expect(validateWorkItem(item)).toEqual({ ok: true, errors: [] });
    expect(item).toMatchObject({ kind: "change", n: 1, lane: "progress", author: "developer@v3", title: "#1 Cart overflows" });
    expect(await linked("wc-agent", 1)).toEqual([item.change_id]);
    expect(await itemOf("wc-agent", 1)).toEqual(item);
    expect((await claim("wc-agent", 1, { mode: "agent" })).status).toBe(409);
  });

  it("concurrent claims of one issue create one change", async () => {
    await setup("wc-concurrent");
    const res = await Promise.all([claim("wc-concurrent", 1, { mode: "agent" }), claim("wc-concurrent", 1, { mode: "agent" })]);
    expect(res.map((r) => r.status).toSorted()).toEqual([201, 409]);
    expect((await res.find((r) => r.status === 409).json()).error.code).toBe("already_claimed");
    expect(await linked("wc-concurrent", 1)).toHaveLength(1);
    expect((await claim("wc-concurrent", 1, { mode: "agent" })).status).toBe(409);
  });

  it("claim mode race creates a two-leg race linked to #n", async () => {
    await setup("wc-race");
    const res = await claim("wc-race", 1, { mode: "race", agents: ["developer@v1", "developer@v2"] });
    expect(res.status).toBe(201);
    expect(validateWorkItem(await res.json()).ok).toBe(true);
    const ids = await linked("wc-race", 1);
    expect(ids).toHaveLength(2);
    const { results } = await env.DB.prepare(`SELECT race_id, agent FROM race_legs WHERE change_id IN (?, ?) ORDER BY agent`).bind(...ids).all();
    expect(results.map((l) => l.agent)).toEqual(["developer@v1", "developer@v2"]);
    expect(results[0].race_id).toBe(results[1].race_id);
  });

  it("claim mode human returns the new-change redirect and writes nothing", async () => {
    await setup("wc-human");
    const res = await claim("wc-human", 1, { mode: "human" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/wc-human/changes/new?issue=1" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM changes c JOIN repos r ON r.id = c.repo_id WHERE r.name = 'wc-human'").first("n")).toBe(0);
    expect((await itemOf("wc-human", 1)).lane).toBe("intent");
  });

  it("unclaim closes the linked change while it has no commit and the issue is an intent again", async () => {
    await setup("wc-unclaim");
    const { change_id: id } = await (await claim("wc-unclaim", 1, { mode: "agent" })).json();
    expect((await call("/api/repos/wc-unclaim/issues/1/claim", { method: "DELETE" })).status).toBe(204);
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).state).toBe("closed");
    expect(await itemOf("wc-unclaim", 1)).toMatchObject({ kind: "intent", lane: "intent", change_id: null });
  });

  it("unclaim after the first commit answers 409 verifier_owned", async () => {
    await setup("wc-owned");
    const { change_id: id } = await (await claim("wc-owned", 1, { mode: "agent" })).json();
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, ?)").bind(id, "b".repeat(40)).run();
    const res = await call("/api/repos/wc-owned/issues/1/claim", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("verifier_owned");
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).state).toBe("planned");
  });

  it("a claim publishes work.updated with the moved item on the repo socket", async () => {
    await setup("wc-live");
    const { ticket } = await (await call("/api/live-ticket", { body: { repo: "wc-live" } })).json();
    const ws = (await call(`/api/repos/wc-live/live?ticket=${ticket}`, { method: "GET", headers: { Origin: "http://cinder.test", Upgrade: "websocket" } })).webSocket;
    ws.accept();
    const updated = new Promise((resolve) => ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.kind === "work.updated") resolve(m);
    }));
    const item = await (await claim("wc-live", 1, { mode: "agent" })).json();
    expect(await updated).toMatchObject({ kind: "work.updated", repo: "wc-live", item });
    ws.close();
  });

  it("agents/suggest reports an agent below the repo's trust threshold as untrusted with its outcome count", async () => {
    await setup("wc-suggest");
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = 'wc-suggest'").first("id");
    const version = (name, v) => env.DB.prepare("INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES (?, ?, ?, 'claude-code', 'm', 'high', 'h', '[]', '{}')").bind(`agent/${name}/v${v}`, name, v);
    const outcome = (i, agent, outcome, repoId = repo) => [
      env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'merged', ?)").bind(`wcs-${i}`, repoId, new Date().toISOString()),
      env.DB.prepare("INSERT INTO agent_outcomes (id, agent_version, outcome, change_id, at) VALUES (?, ?, ?, ?, ?)").bind(`wcs-${i}:${agent}`, agent, outcome, `wcs-${i}`, new Date().toISOString()),
    ];
    await env.DB.batch([
      env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('id-elsewhere', 'wcs-elsewhere', 'main', 'trunk', '{}', ?)").bind(new Date().toISOString()),
      version("wcs", 1), version("wcs", 2), version("wcs", 3),
      env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, 3)").bind(repo),
      ...outcome(1, "wcs@v1", "merged"), ...outcome(2, "wcs@v1", "failed"),
      ...outcome(3, "wcs@v2", "merged"), ...outcome(4, "wcs@v2", "merged"), ...outcome(5, "wcs@v2", "closed"),
      // Another repo's outcome doesn't count here.
      ...outcome(6, "wcs@v1", "merged", "id-elsewhere")]);
    const res = await call("/api/repos/wc-suggest/agents/suggest?issue=1", { method: "GET" });
    expect(res.status).toBe(200);
    const list = (await res.json()).filter((s) => s.agent.startsWith("wcs@"));
    for (const s of list) expect(validateAgentSuggestion(s)).toEqual({ ok: true, errors: [] });
    expect(list).toEqual([
      { agent: "wcs@v2", p_merge: 2 / 3, n: 3, trusted: true },
      { agent: "wcs@v1", p_merge: 0.5, n: 2, trusted: false },
      { agent: "wcs@v3", p_merge: null, n: 0, trusted: false },
    ]);
    expect((await call("/api/repos/wc-suggest/agents/suggest?issue=9", { method: "GET" })).status).toBe(404);
  });

  it("GET agents/suggest without issue answers 400", async () => {
    await setup("wc-suggest-noissue");
    const res = await call("/api/repos/wc-suggest-noissue/agents/suggest", { method: "GET" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });
});
