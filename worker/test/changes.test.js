import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CHANGE_STATES, CHANGE_TRANSITIONS, validateChange, validateChangeDetail, validateChangeEvent } from "../src/api/contract.js";
import { failureOf, newChange, verifyHead } from "../src/changes.js";
import { repairing } from "../src/api/lanes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

async function setup(name, fake = fakeArtifacts(), repo = { name }) {
  const call = (path, body, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", repo)).status).toBe(201);
  // The RepoDO reads .cinder.yml through its own env, which has no Artifacts binding in tests.
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  // workerd evicts an instance idle ~10 s (a loaded run), dropping that patch; a re-created one gets the shared env.
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  const stored = (id) => runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)), (i) => i.ctx.storage.get(["change", "acceptance"]));
  return { fake, call, stored };
}

// A fake Artifacts whose import of `name` has commits on its default branch from the `polls`-th log of it on.
function slowImport(name, polls) {
  const fake = fakeArtifacts();
  const get = fake.get;
  let seen = 0;
  fake.get = async (repo) => {
    const cap = await get(repo);
    if (repo !== name) return cap;
    return { ...cap, async log(opts) {
      if (++seen === polls) fake.repos.get(name).commits.push({ hash: "import-head", message: "imported" });
      return cap.log(opts);
    } };
  };
  return fake;
}

describe("changes on an imported repo", () => {
  it("a change created before the import completes gets 409 repo_importing and one created after gets a fork with the import's head", async () => {
    const fake = slowImport("imp-slow", 3);
    const { call } = await setup("imp-slow", fake, { name: "imp-slow", import: { url: "https://git.example.com/acme/slow.git" } });
    for (let i = 0; i < 2; i++) {
      const res = await call("/api/repos/imp-slow/changes", { intent: "too early" });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("repo_importing");
    }
    const res = await call("/api/repos/imp-slow/changes", { intent: "after import" });
    expect(res.status).toBe(201);
    const { fork } = await res.json();
    expect(fake.repos.get(fork).commits.map((c) => c.hash)).toEqual(["import-head"]);
  });

  it("a fork is never created from a repo with no commits on its default branch", async () => {
    const fake = slowImport("imp-empty", Infinity);
    const { call } = await setup("imp-empty", fake, { name: "imp-empty", import: { url: "https://git.example.com/acme/empty.git" } });
    for (let i = 0; i < 3; i++) expect((await call("/api/repos/imp-empty/changes", { intent: "x" })).status).toBe(409);
    expect(fake.calls.map((c) => c.method)).not.toContain("fork");
  });

  it("a failed import marks the repo failed with the reason", async () => {
    const fake = fakeArtifacts();
    const { call } = await setup("imp-fail", fake, { name: "imp-fail", import: { url: "https://git.example.com/acme/fail.git" } });
    const get = fake.get;
    fake.get = async (repo) => ({ ...(await get(repo)), log: async () => { throw new Error("IMPORT_FAILED: upstream unavailable"); } });
    for (let i = 0; i < 2; i++) {
      const res = await call("/api/repos/imp-fail/changes", { intent: "x" });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toEqual({ code: "import_failed", message: "import of imp-fail failed: IMPORT_FAILED: upstream unavailable" });
    }
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = 'imp-fail'").first();
    expect(await env.DB.prepare("SELECT state FROM repo_imports WHERE repo_id = ?").bind(repo.id).first()).toEqual({ state: "failed" });
    expect(fake.calls.map((c) => c.method)).not.toContain("fork");
  });
});

describe("changes api", () => {
  it("an exhausted change fails at repairs, not repairs_exhausted", () => {
    const change = { events: [{ kind: "repairs_exhausted", to_state: "failed", reason: "repairs exhausted (2 of 2): fail 3" }] };
    expect(failureOf(change, [])).toEqual({ stage: "repair limit", reason: "repairs exhausted (2 of 2): fail 3" });
  });

  it("unicode and trailing whitespace round-trip exactly", async () => {
    const { fake, call, stored } = await setup("chg-uni");
    const intent = "Renommer « café » → カフェ 🚀\n\tkeep tabs  \n\n  ";
    const res = await call("/api/repos/chg-uni/changes", { intent });
    expect(res.status).toBe(201);
    const change = await res.json();
    expect(validateChange(change)).toEqual({ ok: true, errors: [] });
    expect(change).toMatchObject({ intent, target_branch: "main", state: "leased", fork: "chg-uni--CHGUNI-1", number: 1, key: "CHGUNI-1" });
    expect((await stored(change.id)).get("change").intent).toBe(intent);
    expect(fake.calls).toContainEqual({ method: "fork", args: ["chg-uni", "chg-uni--CHGUNI-1"] });
    expect(await env.DB.prepare("SELECT target_branch, state FROM changes WHERE id = ?").bind(change.id).first())
      .toEqual({ target_branch: "main", state: "leased" });
  });

  it("numbers a repo's changes in order: WEBSTORE-1 then WEBSTORE-2, and the detail carries the key", async () => {
    const { fake, call } = await setup("web-store");
    const one = await (await call("/api/repos/web-store/changes", { intent: "first" })).json();
    const two = await (await call("/api/repos/web-store/changes", { intent: "second" })).json();
    expect([one.key, two.key]).toEqual(["WEBSTORE-1", "WEBSTORE-2"]);
    expect(two.fork).toBe("web-store--WEBSTORE-2");
    expect(fake.calls).toContainEqual({ method: "fork", args: ["web-store", "web-store--WEBSTORE-2"] });
    const detail = await (await call(`/api/changes/${two.id}`, undefined, "GET")).json();
    expect(detail).toMatchObject({ number: 2, key: "WEBSTORE-2" });
    const list = await (await call("/api/repos/web-store/changes", undefined, "GET")).json();
    expect(list.map((c) => c.key)).toEqual(["WEBSTORE-1", "WEBSTORE-2"]);
  });

  it("/pulse/changes/PULSE-6 opens change PULSE-6: GET /api/changes/:key?repo= returns the keyed change", async () => {
    const { call } = await setup("pulse");
    await call("/api/repos/pulse/changes", { intent: "first" });
    const two = await (await call("/api/repos/pulse/changes", { intent: "second" })).json();
    expect(await (await call("/api/changes/PULSE-2?repo=pulse", undefined, "GET")).json()).toMatchObject({ id: two.id, key: "PULSE-2" });
    expect((await call("/api/changes/PULSE-9?repo=pulse", undefined, "GET")).status).toBe(404);
  });

  it("a fork named by a change key resolves to its change when the agent commits", async () => {
    const { call } = await setup("fk-resolve");
    const change = await (await call("/api/repos/fk-resolve/changes", { intent: "keyed" })).json();
    expect(change.fork).toBe("fk-resolve--FKRESOLVE-1");
    expect(await env.DB.prepare("SELECT change_id FROM change_numbers WHERE fork = ?").bind(change.fork).first("change_id")).toBe(change.id);
  });

  it("the change detail response carries Server-Timing", async () => {
    const { call } = await setup("chg-dtiming");
    const change = await (await call("/api/repos/chg-dtiming/changes", { intent: "time it" })).json();
    const res = await call(`/api/changes/${change.id}`, undefined, "GET");
    expect(res.status).toBe(200);
    expect(validateChangeDetail(await res.json())).toEqual({ ok: true, errors: [] });
    expect(res.headers.get("Server-Timing")).toMatch(/^do;dur=\d+, db;dur=\d+$/);
  });

  it("opens a change from a pushed branch and lists it with its head branch", async () => {
    const { fake, call } = await setup("chg-head");
    Object.assign(fake.repos.get("chg-head"), { branches: ["main", "feature/pay"], commits: [{ hash: "h1", message: "pay" }] });
    expect((await call("/api/repos/chg-head/changes", { intent: "x", head_branch: "feature/gone" })).status).toBe(404);
    expect((await call("/api/repos/chg-head/changes", { intent: "x", head_branch: "main" })).status).toBe(400);
    expect((await call("/api/repos/chg-head/changes", { intent: "x", head_branch: "" })).status).toBe(400);
    const res = await call("/api/repos/chg-head/changes", { intent: "Accept PayPal", head_branch: "feature/pay" });
    expect(res.status).toBe(201);
    const listed = await (await call("/api/repos/chg-head/changes", undefined, "GET")).json();
    expect(listed.map((c) => [c.intent, c.target_branch, c.head_branch])).toEqual([["Accept PayPal", "main", "feature/pay"]]);
    expect(validateChange(listed[0])).toEqual({ ok: true, errors: [] });
  });

  it("rejects race combined with head_branch", async () => {
    const { fake, call } = await setup("chg-head-race");
    Object.assign(fake.repos.get("chg-head-race"), { branches: ["main", "feature/pay"], commits: [{ hash: "h1", message: "pay" }] });
    const res = await call("/api/repos/chg-head-race/changes", { intent: "Accept PayPal", head_branch: "feature/pay", race: { model: ["a", "b"] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/head_branch/);
    const listed = await (await call("/api/repos/chg-head-race/changes", undefined, "GET")).json();
    expect(listed).toEqual([]);
  });

  it("a human-authored change records driver = person and agent_pushes = false unless the box is checked", async () => {
    const { fake, call, stored } = await setup("chg-human");
    Object.assign(fake.repos.get("chg-human"), { branches: ["main", "feature/pay"], commits: [{ hash: "h1", message: "pay" }] });
    expect((await call("/api/repos/chg-human/changes", { intent: "x", head_branch: "feature/pay", agent_pushes: "yes" })).status).toBe(400);
    const off = await (await call("/api/repos/chg-human/changes", { intent: "Accept PayPal", head_branch: "feature/pay" })).json();
    expect(off).toMatchObject({ driver: "owner", agent_pushes: false });
    expect(validateChange(off)).toEqual({ ok: true, errors: [] });
    const on = await (await call("/api/repos/chg-human/changes", { intent: "Accept PayPal", head_branch: "feature/pay", agent_pushes: true })).json();
    expect((await stored(on.id)).get("change")).toMatchObject({ driver: "owner", agent_pushes: true });
    const described = await (await call("/api/repos/chg-human/changes", { intent: "Accept PayPal" })).json();
    expect(described.driver).toBeUndefined();
  });

  it("allowing agent pushes requeues a refused develop job", async () => {
    const { fake, call } = await setup("chg-allow-requeue");
    Object.assign(fake.repos.get("chg-allow-requeue"), { branches: ["main", "feature/pay"], commits: [{ hash: "h1", message: "pay" }] });
    const change = await (await call("/api/repos/chg-allow-requeue/changes", { intent: "Accept PayPal", head_branch: "feature/pay" })).json();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'failed', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date(Date.now() - 1000).toISOString(), JSON.stringify({ agent: "developer@v7", messages: ["hi"] })).run();
    // What commits.js records when it refuses the job's commit.
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).stageEvent({ kind: "agent_push_refused", agent: "developer@v7", commits: 1,
      actor: { type: "system", id: "cinder" }, action: "change.push", target: change.id, result: "refused" });
    const queued = () => env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'develop' AND status = 'queued'").bind(change.id).all();
    expect((await call(`/api/changes/${change.id}`, { agent_pushes: true }, "PATCH")).status).toBe(200);
    expect((await queued()).results.map((j) => JSON.parse(j.payload))).toEqual([{ agent: "developer@v7" }]);
    await call(`/api/changes/${change.id}`, { agent_pushes: false }, "PATCH");
    await call(`/api/changes/${change.id}`, { agent_pushes: true }, "PATCH");
    expect((await queued()).results).toHaveLength(1);
  });

  it("creating a change with head_branch gives it the branch's commits and files", async () => {
    const { fake, call } = await setup("chg-head-diff");
    Object.assign(fake.repos.get("chg-head-diff"), { branches: ["main", "feature/docs"], commits: [{ hash: "base1", message: "base" }] });
    const created = await (await call("/api/repos/chg-head-diff/changes", { intent: "Document local development", head_branch: "feature/docs" })).json();
    expect(created.state).toBe("verifying");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE change_id = ? AND kind = 'develop'").bind(created.id).first("n")).toBe(0);
    const fork = fake.repos.get(created.fork);
    Object.assign(fork, { refs: { "feature/docs": [{ hash: "d1", message: "docs: local development" }, { hash: "base1", message: "base" }] },
      files: { "DEV.md": "run make" }, at: { base1: {}, d1: { "DEV.md": "run make" } } });
    const commits = await (await call(`/api/changes/${created.id}/commits`, undefined, "GET")).json();
    expect(commits.map((c) => c.sha)).toEqual(["d1"]);
    const files = await (await call(`/api/changes/${created.id}/files`, undefined, "GET")).json();
    expect(files.map((f) => [f.path, f.status])).toEqual([["DEV.md", "added"]]);
  });

  const jobsOf = async (id) => (await env.DB.prepare("SELECT kind, payload FROM jobs WHERE change_id = ? ORDER BY created_at").bind(id).all()).results
    .map((j) => [j.kind, JSON.parse(j.payload).head_sha ?? JSON.parse(j.payload).after ?? null]).sort();

  it("a change created with head_branch is verifying with a queued verify job", async () => {
    const { fake, call } = await setup("chg-head-verify");
    Object.assign(fake.repos.get("chg-head-verify"), { branches: ["main", "feature/pay"], commits: [{ hash: "h1", message: "pay" }] });
    const created = await (await call("/api/repos/chg-head-verify/changes", { intent: "Accept PayPal", head_branch: "feature/pay" })).json();
    expect(created.state).toBe("verifying");
    expect(await jobsOf(created.id)).toEqual([["guard", "h1"], ["verify", "h1"]]);
    const detail = await (await call(`/api/changes/${created.id}`, undefined, "GET")).json();
    expect([detail.state, detail.head_sha]).toEqual(["verifying", "h1"]);
  });

  it("marking a person's draft ready queues verify, not develop", async () => {
    const { fake, call } = await setup("chg-draft-verify");
    Object.assign(fake.repos.get("chg-draft-verify"), { branches: ["main", "feature/pay"], commits: [{ hash: "h1", message: "pay" }] });
    const draft = await (await call("/api/repos/chg-draft-verify/changes", { intent: "Accept PayPal", head_branch: "feature/pay", draft: true })).json();
    expect([draft.state, await jobsOf(draft.id)]).toEqual(["draft", []]);
    const ready = await call(`/api/changes/${draft.id}/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json()).state).toBe("verifying");
    expect(await jobsOf(draft.id)).toEqual([["guard", "h1"], ["verify", "h1"]]);
  });

  it("an agent-written change still queues develop on create", async () => {
    const { call } = await setup("chg-agent-develop");
    const created = await (await call("/api/repos/chg-agent-develop/changes", { intent: "Strip headers" })).json();
    expect(created.state).toBe("leased");
    expect((await jobsOf(created.id)).map(([kind]) => kind)).toEqual(["develop"]);
  });

  it("creating a change with agent_version stores it and the change lists that agent", async () => {
    const { call, stored } = await setup("chg-agent");
    expect((await call("/api/repos/chg-agent/changes", { intent: "x", agent_version: "" })).status).toBe(400);
    const created = await (await call("/api/repos/chg-agent/changes", { intent: "Strip headers", agent_version: "dev@2" })).json();
    expect((await stored(created.id)).get("change").agent_version).toBe("dev@2");
    const payload = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'develop'").bind(created.id).first("payload");
    expect(JSON.parse(payload).agent).toBe("dev@2");
    const [listed] = await (await call("/api/repos/chg-agent/changes", undefined, "GET")).json();
    expect([listed.agent_version, listed.agent, listed.ver]).toEqual(["dev@2", "dev", "2"]);
    expect(validateChange(listed)).toEqual({ ok: true, errors: [] });
  });

  it("list filters by label and sorts by priority", async () => {
    const { call } = await setup("chg-filter");
    const make = async (intent, fields) => (await (await call("/api/repos/chg-filter/changes", { intent, draft: true, ...fields })).json()).id;
    const low = await make("low cart", { priority: "P3", labels: ["cart"] });
    const plain = await make("plain cart", { labels: ["cart"] });
    const urgent = await make("urgent cart", { priority: "P0", labels: ["cart", "pay"] });
    await make("urgent other", { priority: "P0", labels: ["other"] });
    const list = async (q) => (await (await call(`/api/repos/chg-filter/changes?${q}`, undefined, "GET")).json()).map((c) => c.id);
    expect(await list("label=cart")).toEqual([low, plain, urgent]);
    expect(await list("label=cart&sort=priority")).toEqual([urgent, plain, low]);
    expect(await list("label=cart&sort=age")).toEqual([low, plain, urgent]);
    expect(await list("label=cart&priority=P2")).toEqual([plain]);
    expect((await call("/api/repos/chg-filter/changes?priority=urgent", undefined, "GET")).status).toBe(400);
    expect((await call("/api/repos/chg-filter/changes?sort=size", undefined, "GET")).status).toBe(400);
  });

  it("promoting a canary version to stable makes new agent changes use it", async () => {
    const { call, stored } = await setup("chg-promote");
    const row = "INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES (?, 'developer', ?, 'claude-code', 'm', 'default', 'h', '[]', '{}')";
    await env.DB.batch([env.DB.prepare(row).bind("agent/developer/v7", 7), env.DB.prepare(row).bind("agent/developer/v8", 8),
      env.DB.prepare("INSERT INTO channels (agent_name, channel, version) VALUES ('developer', 'stable', 7), ('developer', 'canary', 8)")]);
    onTestFinished(() => env.DB.batch([env.DB.prepare("DELETE FROM channels WHERE agent_name = 'developer'"), env.DB.prepare("DELETE FROM agent_versions WHERE name = 'developer'")]));
    const agentOf = async () => (await stored((await (await call("/api/repos/chg-promote/changes", { intent: "Strip headers" })).json()).id)).get("change").agent_version;
    expect(await agentOf()).toBe("developer@v7");
    expect((await call("/api/agents/developer/channels/stable", { version: 8 }, "PUT")).status).toBe(200);
    expect(await agentOf()).toBe("developer@v8");
  });

  it("target not allowed by policy → 422", async () => {
    const { fake, call } = await setup("chg-422");
    const res = await call("/api/repos/chg-422/changes", { intent: "x", target_branch: "feature/x" });
    expect(res.status).toBe(422);
    expect(fake.calls.map((c) => c.method)).not.toContain("fork");
  });

  it("acceptance content never reaches the fork", async () => {
    const { fake, call, stored } = await setup("chg-acc");
    const acceptance = [{ path: "test/secret.test.js", content: "it('ACCEPTANCE-MARKER')" }];
    const res = await call("/api/repos/chg-acc/changes", { intent: "add it", acceptance });
    expect(res.status).toBe(201);
    const { id, fork } = await res.json();
    expect(fake.repos.get(fork).files).toEqual({});
    expect(JSON.stringify(fake.calls)).not.toContain("ACCEPTANCE-MARKER");
    expect((await stored(id)).get("acceptance")).toEqual(acceptance);
  });

  it("develop report adds a StageRecord", async () => {
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName("chg-stage"));
    const record = {
      change_id: "chg-stage", stage: "develop", agent_version: "agent/dev/v1", harness: "claude-code", model: "claude-opus",
      cost_usd: 0.42, duration_ms: 61000, session: "sess-1", verdict: "pass", dirty: false, started_at: "2026-10-04T00:00:00Z",
    };
    await stub.report(record);
    expect(await runInDurableObject(stub, async (i) => {
      await expect(i.report({ ...record, session: "" })).rejects.toThrow("session");
      return i.ctx.storage.get("stages");
    })).toEqual([record]);
  });

  it("illegal transition → 409 and no event", async () => {
    const { call } = await setup("chg-409");
    const { id } = await (await call("/api/repos/chg-409/changes", { intent: "x" })).json();
    const setState = (state) => runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)), async (i) => {
      await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state });
    });
    for (const state of ["merged", "closed"]) {
      await setState(state);
      const before = await (await call(`/api/changes/${id}`, undefined, "GET")).json();
      expect((await call(`/api/changes/${id}/close`)).status).toBe(409);
      const after = await (await call(`/api/changes/${id}`, undefined, "GET")).json();
      expect(after).toEqual(before);
    }
  });

  it("a failed event insert aborts the transition", async () => {
    const { call } = await setup("chg-evt");
    const { id } = await (await call("/api/repos/chg-evt/changes", { intent: "x" })).json();
    const before = await (await call(`/api/changes/${id}`, undefined, "GET")).json();
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)), (i) =>
      expect(i.transition("closed", { kind: "closed", actor: "owner" })).rejects.toThrow(/bad ChangeEvent/));
    expect(await (await call(`/api/changes/${id}`, undefined, "GET")).json()).toEqual(before);
    expect(await env.DB.prepare("SELECT state FROM changes WHERE id = ?").bind(id).first()).toEqual({ state: "leased" });
  });

  it("list filters by target branch", async () => {
    const { fake, call } = await setup("chg-list");
    fake.repos.get("chg-list").files[".cinder.yml"] = "branches:\n  integration: [main, next]\n";
    const onMain = await (await call("/api/repos/chg-list/changes", { intent: "a" })).json();
    const onNext = await (await call("/api/repos/chg-list/changes", { intent: "b", target_branch: "next" })).json();
    expect(onNext.target_branch).toBe("next");
    const list = (q) => call(`/api/repos/chg-list/changes${q}`, undefined, "GET").then((r) => r.json());
    expect((await list("?target=next")).map((c) => c.id)).toEqual([onNext.id]);
    expect((await list("?target=main")).map((c) => c.id)).toEqual([onMain.id]);
    expect((await list("")).map((c) => c.id).sort()).toEqual([onMain.id, onNext.id].sort());
    expect(await list("?target=next&state=closed")).toEqual({ changes: [], next: null });
    for (const c of await list("")) expect(validateChange(c)).toEqual({ ok: true, errors: [] });
  });

  it("closing a change deletes its fork", async () => {
    const { call, fake } = await setup("chg-fork-del");
    const merged = await (await call("/api/repos/chg-fork-del/changes", { intent: "merge me" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(merged.id));
    await runInDurableObject(stub, async (i) => { await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "in_queue" }); });
    await stub.transition("merged", { kind: "merge_done", actor: { type: "system", id: "r1" }, action: "job.report", target: merged.id, result: "done" });
    expect(fake.repos.has(merged.fork)).toBe(false);

    const closed = await (await call("/api/repos/chg-fork-del/changes", { intent: "close me" })).json();
    const remove = fake.delete;
    let failures = 1;
    fake.delete = async (name) => (failures-- > 0 ? Promise.reject(new Error("artifacts down")) : remove(name));
    expect((await call(`/api/changes/${closed.id}/close`)).status).toBe(200);
    expect(fake.calls.filter((c) => c.method === "delete" && c.args[0] === closed.fork)).toHaveLength(1);
    expect(fake.repos.has(closed.fork)).toBe(false);
  });

  it("close from any state records actor", async () => {
    const { call } = await setup("chg-close");
    const closable = CHANGE_STATES.filter((s) => CHANGE_TRANSITIONS[s].includes("closed"));
    expect(closable).toHaveLength(12);
    for (const state of closable) {
      const { id } = await (await call("/api/repos/chg-close/changes", { intent: state })).json();
      await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)), async (i) => {
        await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state });
      });
      const res = await call(`/api/changes/${id}/close`);
      expect(res.status).toBe(200);
      expect((await res.json()).state).toBe("closed");
      const { events, ...change } = await (await call(`/api/changes/${id}`, undefined, "GET")).json();
      expect(validateChangeDetail({ ...change, events })).toEqual({ ok: true, errors: [] });
      expect(change.blockers.map((b) => b.code)).toContain("no_verdict");
      expect(validateChange(change)).toEqual({ ok: true, errors: [] });
      const last = events.at(-1);
      expect(last).toMatchObject({ kind: "closed", actor: { type: "human", id: "owner" }, from_state: state, to_state: "closed" });
      expect(validateChangeEvent(last)).toEqual({ ok: true, errors: [] });
      expect(await env.DB.prepare("SELECT state FROM changes WHERE id = ?").bind(id).first()).toEqual({ state: "closed" });
    }
  });

  it("approval is stale after a converge push", async () => {
    const { call } = await setup("chg-stale");
    const { id } = await (await call("/api/repos/chg-stale/changes", { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.setReview({ route: "human", reason: "risk high" });
    await stub.moveHead("sha1");
    const approved = await (await call(`/api/changes/${id}/review`, { verdict: "approve" })).json();
    expect(approved.approvals).toEqual([{ actor: { type: "human", id: "owner" }, head_sha: "sha1", at: expect.any(String) }]);
    const codes = async () => (await (await call(`/api/changes/${id}`, undefined, "GET")).json()).blockers.map((b) => b.code);
    expect(await codes()).not.toContain("approval_stale");
    await stub.moveHead("sha2");
    expect(await codes()).toContain("approval_stale");
  });

  it("change detail shows no blocker once verdict, guard and approval are met", async () => {
    const { call } = await setup("chg-gate");
    const { id } = await (await call("/api/repos/chg-gate/changes", { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    const codes = async () => (await (await call(`/api/changes/${id}`, undefined, "GET")).json()).blockers.map((b) => b.code);
    await stub.setReview({ route: "human", reason: "risk high" });
    await stub.moveHead("sha1");
    await stub.report({ change_id: id, stage: "verify", agent_version: "cinder-agent@v0", harness: "claude-code", model: "default", cost_usd: 0,
      duration_ms: 0, session: "s1", verdict: "pass", dirty: false, started_at: new Date().toISOString() });
    await stub.setGuard({ status: "clear", reason: null, at: new Date().toISOString(), deps: [], sha: "sha1" });
    expect(await codes()).toEqual(["approval_missing"]);
    expect((await call(`/api/changes/${id}/review`, { verdict: "approve" })).status).toBe(200);
    expect(await codes()).toEqual([]);
  });

  it("approving through review still queues as before", async () => {
    const { call } = await setup("chg-review-queue");
    const { id } = await (await call("/api/repos/chg-review-queue/changes", { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.setReview({ route: "human", reason: "risk high" });
    await runInDurableObject(stub, async (i) => i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "verifying",
      head: "h1", verdict: { sha: "h1", status: "pass", at: new Date().toISOString() } }));
    expect((await call(`/api/changes/${id}/approve`)).status).toBe(404);
    expect((await stub.get()).state).toBe("verifying");
    const res = await call(`/api/changes/${id}/review`, { verdict: "approve" });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("in_queue");
    expect(await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(id).first()).not.toBeNull();
  });

  it("approve does not queue while the new head is verifying", async () => {
    const { call } = await setup("chg-reverify");
    const { id } = await (await call("/api/repos/chg-reverify/changes", { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.setReview({ route: "human", reason: "risk high" });
    await runInDurableObject(stub, async (i) => i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "verifying", head: "sha1" }));
    expect(await verifyHead(env, await stub.get(), "sha2", "verifying")).not.toBeNull();
    const res = await call(`/api/changes/${id}/review`, { verdict: "approve" });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("verifying");
    expect(await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(id).first()).toBeNull();
  });

  const develop = (id, agent_version) => ({
    change_id: id, stage: "develop", agent_version, harness: "claude-code", model: "claude-opus",
    cost_usd: 0.1, duration_ms: 1000, session: "s", verdict: "pass", dirty: false, started_at: "2026-10-04T00:00:00Z",
  });

  it("refuses reviewer approval from the authoring agent version", async () => {
    const { call } = await setup("chg-self");
    const { id } = await (await call("/api/repos/chg-self/changes", { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.report(develop(id, "dev@v1"));
    expect(await stub.approve({ type: "agent", id: "dev", agent_version: "dev@v1" })).toBe(false);
    expect((await stub.get()).approvals).toBeUndefined();
    // Refused for being the author, not for being an agent: another version is accepted on the same change.
    expect((await stub.approve({ type: "agent", id: "dev", agent_version: "dev@v2" })).approvals).toHaveLength(1);
  });

  it("accepts reviewer approval from a different version", async () => {
    const { call } = await setup("chg-other");
    const { id } = await (await call("/api/repos/chg-other/changes", { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.report(develop(id, "dev@v1"));
    await stub.moveHead("sha1");
    const actor = { type: "agent", id: "dev", agent_version: "dev@v2" };
    expect((await stub.approve(actor)).approvals).toEqual([{ actor, head_sha: "sha1", at: expect.any(String) }]);
  });
  it("429 after the change creation limit", async () => {
    const { call } = await setup("chg-limit");
    // Invalid bodies count too, so the limit is cheap to reach; windows are wall-clock minutes, so allow one boundary.
    let n = 0;
    let res;
    while ((res = await call("/api/repos/chg-limit/changes", {})).status === 400 && n < 60) n++;
    expect(n).toBeGreaterThanOrEqual(30);
    expect(res.status).toBe(429);
    expect((await call("/api/repos/chg-uni/changes", {})).status).toBe(400);
  });

  it("one person's change limit doesn't block another on the same repo", async () => {
    await setup("chg-person");
    serveCerts();
    onTestFinished(() => vi.restoreAllMocks());
    const post = async (headers) => (await worker.fetch(new Request("http://cinder.test/api/repos/chg-person/changes", { method: "POST", headers, body: "{}" }), ACCESS)).status;
    const boss = await as("boss@example.com");
    let n = 0;
    while (await post(boss) === 400 && n < 60) n++;
    expect(n).toBeGreaterThanOrEqual(30);
    expect(await post(boss)).toBe(429);
    // The owner token is boss too (the first of OWNERS), so another person is a developer.
    await env.DB.prepare("INSERT INTO person_roles VALUES ('dev@example.com', 'developer') ON CONFLICT (email) DO UPDATE SET role = excluded.role").run();
    expect(await post(await as("dev@example.com"))).toBe(400);
  });
});

describe("change cards", () => {
  it("the repo changes list returns adds and dels per change", async () => {
    const { call } = await setup("chg-stats");
    const a = await (await call("/api/repos/chg-stats/changes", { intent: "a" })).json();
    const b = await (await call("/api/repos/chg-stats/changes", { intent: "b" })).json();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, 'sha-a')").bind(a.id),
      env.DB.prepare("INSERT INTO compares VALUES (?, 'base', 'sha-a', ?)").bind(a.repo_id, JSON.stringify({ stats: { files_changed: 2, additions: 12, deletions: 3 } })),
    ]);
    const list = await (await call("/api/repos/chg-stats/changes", undefined, "GET")).json();
    for (const c of list) expect(validateChange(c).errors).toEqual([]);
    expect(Object.fromEntries(list.map(({ id, adds, dels }) => [id, [adds, dels]]))).toEqual({ [a.id]: [12, 3], [b.id]: [null, null] });
  });

  it("the changes list response carries Server-Timing", async () => {
    const { call } = await setup("chg-timing");
    await call("/api/repos/chg-timing/changes", { intent: "a" });
    const res = await call("/api/repos/chg-timing/changes", undefined, "GET");
    expect(res.headers.get("Server-Timing")).toMatch(/^db;dur=\d+, cards;dur=\d+$/);
  });

  it("listChanges returns adds and dels for a change with a head", async () => {
    const { call, fake } = await setup("chg-head-stats");
    fake.repos.get("chg-head-stats").commits.push({ hash: "base1", message: "base" });
    const c = await (await call("/api/repos/chg-head-stats/changes", { intent: "a" })).json();
    const fork = fake.repos.get(c.fork);
    Object.assign(fork.files, { "a.md": "keep\nnew\n" });
    fork.commits.unshift({ hash: "c1", message: "edit" });
    fork.at = { base1: { "a.md": "keep\nold\n" }, c1: fork.files };
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, 'c1')").bind(c.id).run();
    const list = await (await call("/api/repos/chg-head-stats/changes", undefined, "GET")).json();
    expect(list.map(({ adds, dels }) => [adds, dels])).toEqual([[1, 1]]);
  });

  it("a developing change's card carries its agent version and tokens", async () => {
    const { call } = await setup("card-dev");
    const { id } = await (await call("/api/repos/card-dev/changes", { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.report({
      change_id: id, stage: "develop", agent_version: "dev@v3", harness: "claude-code", model: "claude-opus", cost_usd: 0.1,
      duration_ms: 1000, session: "s", verdict: null, dirty: false, started_at: "2026-10-04T00:00:00Z", tokens: [1200, 300, 4000],
    });
    await stub.transition("developing", { kind: "develop_claimed", actor: { type: "system", id: "cinder" }, action: "job.claim", target: id, result: "ok" }, {}, "leased");
    const [card] = await (await call("/api/repos/card-dev/changes", undefined, "GET")).json();
    expect(validateChange(card).errors).toEqual([]);
    expect(card).toMatchObject({ id, state: "developing", agent: "dev", ver: "v3", tok: [1200, 300, 4000], lease: { kind: "held" }, risk_judge: null });
  });

  it("listing 50 changes makes no per-change DO call", async () => {
    const { fake } = await setup("card-50");
    const { id: repoId } = await env.DB.prepare("SELECT id FROM repos WHERE name = 'card-50'").first();
    for (let i = 0; i < 50; i++) await newChange({ ...env, ARTIFACTS: fake }, "card-50", repoId, `change ${i}`, "main", []);
    let doCalls = 0;
    const CHANGE_DO = { idFromName: (n) => env.CHANGE_DO.idFromName(n), get: (id) => { doCalls++; return env.CHANGE_DO.get(id); } };
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/card-50/changes", { headers: OWNER }), { ...env, ARTIFACTS: fake, CHANGE_DO });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(50);
    expect(doCalls).toBe(0);
  });
});

describe("draft changes", () => {
  const developJobs = (id) => env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE change_id = ? AND kind = 'develop'").bind(id).first("n");
  const leases = (name) => env.REPO_DO.get(env.REPO_DO.idFromName(name)).leases("main");

  it("a change created with draft:true stays in draft with no lease or develop job", async () => {
    const { call } = await setup("draft-new");
    const res = await call("/api/repos/draft-new/changes", { intent: "later", draft: true });
    expect(res.status).toBe(201);
    const { id, state } = await res.json();
    expect(state).toBe("draft");
    const change = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get();
    expect(change.state).toBe("draft");
    expect(change.events).toMatchObject([{ kind: "created", from_state: null, to_state: "draft" }]);
    expect(await env.DB.prepare("SELECT state FROM changes WHERE id = ?").bind(id).first("state")).toBe("draft");
    expect(await developJobs(id)).toBe(0);
    expect((await leases("draft-new"))[id]).toBeUndefined();
  });

  it("creating a draft with priority high and labels qa returns both from GET /api/changes/:id", async () => {
    const { call } = await setup("draft-labels");
    const { id } = await (await call("/api/repos/draft-labels/changes", { intent: "later", draft: true, priority: "P1", labels: ["qa"] })).json();
    const change = await (await call(`/api/changes/${id}`, undefined, "GET")).json();
    expect([change.priority, change.labels]).toEqual(["P1", ["qa"]]);
    const [listed] = await (await call("/api/repos/draft-labels/changes", undefined, "GET")).json();
    expect([listed.priority, listed.labels]).toEqual(["P1", ["qa"]]);
    expect(validateChange(listed).errors).toEqual([]);
  });

  it("creating a change with an invalid priority returns 400", async () => {
    const { call } = await setup("draft-bad-priority");
    expect((await call("/api/repos/draft-bad-priority/changes", { intent: "later", draft: true, priority: "urgent" })).status).toBe(400);
  });

  it("ready moves a draft to planned and it is scheduled", async () => {
    const { call } = await setup("draft-ready");
    const { id } = await (await call("/api/repos/draft-ready/changes", { intent: "later", draft: true })).json();
    const res = await call(`/api/changes/${id}/ready`);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("leased");
    const { events } = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get();
    expect(events.map((e) => [e.kind, e.from_state, e.to_state])).toEqual([["created", null, "draft"], ["ready", "draft", "planned"], ["leased", "planned", "leased"]]);
    expect(await developJobs(id)).toBe(1);
    expect((await leases("draft-ready"))[id]).toBeDefined();
    // A second ready finds it no longer a draft.
    expect((await call(`/api/changes/${id}/ready`)).status).toBe(409);
  });
});

describe("ended changes by state", () => {
  // Inserts ended changes with cards straight into D1: [id, state, created_at, merged_at?].
  async function seed(name, rows) {
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
    await env.DB.batch(rows.flatMap(([id, state, created_at, merged_at]) => [
      env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', ?, ?)").bind(id, repo, state, created_at),
      env.DB.prepare("INSERT INTO change_cards (change_id, card) VALUES (?, ?)").bind(id, JSON.stringify({ id, repo_id: repo, state, intent: id })),
      ...(merged_at ? [env.DB.prepare("INSERT INTO change_merges (change_id, repo_id, merged_at) VALUES (?, ?, ?)").bind(id, repo, merged_at)] : []),
    ]));
  }

  it("state=failed lists failed changes newest first with a next cursor", async () => {
    const { call } = await setup("chg-failed");
    const at = (i) => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    await seed("chg-failed", [...Array.from({ length: 51 }, (_, i) => [`f${String(i).padStart(2, "0")}`, "failed", at(i)]), ["open1", "leased", at(60)]]);
    const first = await (await call("/api/repos/chg-failed/changes?state=failed", undefined, "GET")).json();
    expect(first.changes.map((c) => c.id)).toEqual(Array.from({ length: 50 }, (_, i) => `f${String(50 - i).padStart(2, "0")}`));
    expect(first.next).toEqual(expect.any(String));
    const second = await (await call(`/api/repos/chg-failed/changes?state=failed&cursor=${encodeURIComponent(first.next)}`, undefined, "GET")).json();
    expect(second).toEqual({ changes: [expect.objectContaining({ id: "f00", state: "failed" })], next: null });
    expect((await call("/api/repos/chg-failed/changes?state=failed&cursor=junk", undefined, "GET")).status).toBe(400);
  });

  it("state=merged since 30 days includes merges older than 24 hours", async () => {
    const { call } = await setup("chg-merged");
    const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
    await seed("chg-merged", [["m-new", "merged", ago(12), ago(0.1)], ["m-old", "merged", ago(12), ago(3)], ["m-gone", "merged", ago(50), ago(40)]]);
    const res = await call(`/api/repos/chg-merged/changes?state=merged&since=${ago(30)}`, undefined, "GET");
    expect((await res.json()).changes.map((c) => c.id)).toEqual(["m-new", "m-old"]);
  });
});

describe("repair rounds", () => {
  it("a verified change is not repairing", async () => {
    const { call } = await setup("repair-passed");
    const change = await (await call("/api/repos/repair-passed/changes", { intent: "x" })).json();
    // Earlier tests leave jobs queued on other repos; only this change's jobs stay claimable.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed') AND change_id <> ?").bind(change.id).run();
    const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop", "verify"] })).json()).token;
    const work = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${runner}` }, body: JSON.stringify(body) }), env);
    const claim = async (kind) => (await (await work("/api/work/claim", { kinds: [kind] })).json()).job.id;
    const report = async (kind, status) => (await (await work(`/api/work/jobs/${await claim(kind)}/report`, { status })).json()).change;
    await report("develop", "done");
    expect(repairing(await report("verify", "failed"))).toBe(true);
    await report("develop", "done");
    // Auto-queue off: the verified change waits in verifying instead of queueing.
    await env.DB.prepare("INSERT INTO change_views (change_id, auto_queue) VALUES (?, 0)").bind(change.id).run();
    const verified = await report("verify", "done");
    expect(verified).toMatchObject({ state: "verifying", repair: { round: 1, passed: true } });
    expect(repairing(verified)).toBe(false);
  });
});
