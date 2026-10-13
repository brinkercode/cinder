import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import * as contract from "../src/api/contract.js";
import { FIXTURES } from "./helpers/fixtures.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import self from "./contract.test.js?raw";

const { CHANGE_STATES, canTransition, validateChange, validateChangeDetail, validateChangeEvent, validateLeaseMap } = contract;
const files = import.meta.glob("../src/api/fixtures/*.json", { eager: true, import: "default" });
const fixture = (name) => files[`../src/api/fixtures/${name}.json`];
const [changeDetail, changes, judgments, leaseMap, repoOverview, repos] =
  ["change-detail", "changes", "judgments", "lease-map", "repo-overview", "repos"].map(fixture);

describe("api contract", () => {
  it("every fixture passes its validator", () => {
    for (const [name, validator, min] of FIXTURES) {
      const [items, validate] = [fixture(name), contract[validator]];
      expect(items, name).toBeDefined();
      expect(validate, validator).toBeTypeOf("function");
      if (min === undefined) { expect(validate(items), name).toEqual({ ok: true, errors: [] }); continue; }
      expect(items.length, name).toBeGreaterThanOrEqual(min);
      for (const item of items) expect(validate(item), `${name} ${item.id}`).toEqual({ ok: true, errors: [] });
    }
    expect(judgments.every((j) => j.outcome !== null)).toBe(true);
    expect(repos.map((r) => r.strategy).sort()).toEqual(["gitflow", "release", "trunk", "trunk"]);
    expect(repoOverview.repos.map((r) => r.repo_id)).toEqual(repos.map((r) => r.id));
  });

  it("pools and BYO pools with settings pass validatePool and validateByoPool", () => {
    for (const p of fixture("pools")) expect(contract.validatePool(p), p.id).toEqual({ ok: true, errors: [] });
    for (const p of fixture("byo-pools")) expect(contract.validateByoPool(p), p.id).toEqual({ ok: true, errors: [] });
    expect(fixture("byo-pools").map((p) => p.repos)).toEqual(["*", ["cinder"]]);
    const { keep_warm_s, ...unset } = fixture("pools")[0];
    expect(contract.validatePool({ ...unset, keep_warm_s, egress: "closed" }).errors).toEqual(["egress: expected allowlist, none or open"]);
    expect(contract.validateByoPool({ ...fixture("byo-pools")[0], repos: [] }).errors).toEqual(['repos: expected "*" or a non-empty list of repo names']);
    expect(contract.validatePool(unset).errors).toEqual(["keep_warm_s: expected integer >= 0"]);
  });

  it("fixtures cover every CHANGE_STATE", () => {
    expect(CHANGE_STATES).toHaveLength(14);
    expect(new Set(changes.map((c) => c.state))).toEqual(new Set(CHANGE_STATES));
  });

  it("transitions reject merged → developing and allow conflict → resolving", () => {
    expect(canTransition("merged", "developing")).toBe(false);
    expect(canTransition("conflict", "resolving")).toBe(true);
  });

  it("failed may move to verifying and closed only", () => {
    expect(CHANGE_STATES.filter((s) => canTransition("failed", s))).toEqual(["verifying", "closed"]);
  });

  it("change detail fixture includes blockers", () => {
    expect(validateChangeDetail(changeDetail)).toEqual({ ok: true, errors: [] });
    expect(changeDetail.blockers.length).toBeGreaterThan(0);
    expect(validateChangeDetail({ ...changeDetail, blockers: [{ code: "nope", reason: "x", since: null }] }).ok).toBe(false);
  });

  it("lease map fixture passes and rejects an edge to an unlisted change", () => {
    expect(validateLeaseMap(leaseMap)).toEqual({ ok: true, errors: [] });
    const edges = [{ ...leaseMap.edges[0], b: "c-9999" }];
    expect(validateLeaseMap({ ...leaseMap, edges })).toEqual({ ok: false, errors: ["edges[0].b: expected id of a listed change"] });
  });

  it("GET /agents/:name/versions and its fixture pass validateAgentVersions", async () => {
    expect(contract.validateAgentVersions(fixture("agent-version-list"))).toEqual({ ok: true, errors: [] });
    for (const v of [1, 2]) {
      await env.DB.prepare("INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
        "VALUES (?, 'contractdev', ?, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{}')").bind(`agent/contractdev/v${v}`, v).run();
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO channels (agent_name, channel, version) VALUES ('contractdev', 'stable', 1), ('contractdev', 'canary', 2)"),
      env.DB.prepare("INSERT INTO canary_shares (agent_name, share) VALUES ('contractdev', 30)"),
      env.DB.prepare("INSERT INTO agent_outcomes (id, agent_version, outcome, change_id, at) VALUES ('o1', 'contractdev@v2', 'merged', 'c1', '2026-10-08T00:00:00Z'), " +
        "('o2', 'contractdev@v2', 'failed', 'c2', '2026-10-08T00:00:00Z'), ('o3', 'contractdev@v2', 'race_won', 'c3', '2026-10-08T00:00:00Z')"),
    ]);
    const res = await worker.fetch(new Request("http://cinder.test/api/agents/contractdev/versions", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    const body = await res.json();
    expect(contract.validateAgentVersions(body)).toEqual({ ok: true, errors: [] });
    expect(body).toEqual([
      { version: 1, channel: "stable", share: 0, released_at: null, outcomes: { merged: 0, n: 0, trusted: false }, web: { mode: "raw", converted: 0, saved_bytes: 0 } },
      { version: 2, channel: "canary", share: 30, released_at: null, outcomes: { merged: 1, n: 2, trusted: false }, web: { mode: "raw", converted: 0, saved_bytes: 0 } },
    ]);
    expect(contract.validateAgentVersions([{ ...body[1], share: 101 }]).ok).toBe(false);
  });

  it("wiki page and wiki context responses pass their validators", async () => {
    const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), { ...env, ARTIFACTS: fakeArtifacts() });
    expect((await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "contract-wiki" }) })).status).toBe(201);
    await env.DB.prepare("INSERT INTO wiki_pages (id, repo_id, title, slug, content, created_at, updated_at) SELECT 'cw-1', id, 'Rules', 'rules', '## Style', 'now', 'now' FROM repos WHERE name = 'contract-wiki'").run();
    expect((await call("/api/repos/contract-wiki/wiki/pages/cw-1", { method: "PATCH", body: JSON.stringify({ agent_context: true }) })).status).toBe(200);
    const page = await (await call("/api/repos/contract-wiki/wiki/pages/cw-1")).json();
    expect(contract.validateWikiPage(page)).toEqual({ ok: true, errors: [] });
    expect(contract.validateWikiPage({ ...page, toc: [{ level: 4, text: "x", anchor: "x" }] }).ok).toBe(false);
    const ctx = await (await call("/api/repos/contract-wiki/wiki/context")).json();
    expect(contract.validateWikiContext(ctx)).toEqual({ ok: true, errors: [] });
    expect(ctx.pages.map((p) => p.id)).toEqual(["cw-1"]);
    expect(contract.validateWikiContext({ ...ctx, truncated: "no" }).ok).toBe(false);
  });

  it("GET /work and fixtures/work.json pass validateWorkBoard", async () => {
    expect(contract.validateWorkBoard(fixture("work"))).toEqual({ ok: true, errors: [] });
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('id-cwork', 'cwork', 'main', 'trunk', '{}', ?)").bind(at),
      env.DB.prepare("INSERT INTO issues (id, repo_id, number, title, author, labels, created_at, updated_at) VALUES ('cw-1', 'id-cwork', 1, 'One', 'ana@example.com', '[\"bug\"]', ?1, ?1), " +
        "('cw-2', 'id-cwork', 2, 'Two', 'ana@example.com', '[]', ?1, ?1)").bind(at),
      env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES ('cw-c', 'id-cwork', 'main', 'conflict', ?)").bind(at),
      env.DB.prepare("INSERT INTO change_cards (change_id, card) VALUES ('cw-c', ?)").bind(JSON.stringify({ id: "cw-c", title: "Fix", state: "conflict", agent: "developer", ver: "v7", updated_at: at })),
      env.DB.prepare("INSERT INTO issue_links (issue_id, change_id) VALUES ('cw-2', 'cw-c')"),
      env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES ('cw-j1', 'id-cwork', 'verify', 'cw-c', 'done', ?1, '{}'), " +
        "('cw-j2', 'id-cwork', 'verify', 'cw-c', 'failed', ?1, '{}')").bind(at),
    ]);
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/cwork/work", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    const body = await res.json();
    expect(contract.validateWorkBoard(body)).toEqual({ ok: true, errors: [] });
    expect(body.items.map((i) => [i.n, i.lane, i.why])).toEqual([[2, "verify", "Conflicts with its target"], [1, "intent", null]]);
    expect(body.tiles.verifier).toEqual({ pass: 1, n: 2, trusted: false });
    expect(contract.validateWorkBoard({ ...body, items: [{ ...body.items[0], lane: "blocked" }] }).ok).toBe(false);
  });

  it("me/accounts passes validateAccountList", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('org-cma', 'Contract Org')"),
      env.DB.prepare("INSERT INTO accounts (id, name, slug, org_id, created_at) VALUES ('acc-cma', 'Contract Account', 'contract-account', 'org-cma', '2026-10-01')"),
    ]);
    const res = await worker.fetch(new Request("http://cinder.test/api/me/accounts", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}`, Cookie: "cinder_account=acc-cma" } }), env);
    const body = await res.json();
    expect(contract.validateAccountList(body)).toEqual({ ok: true, errors: [] });
    expect(body.organization).toEqual({ id: "org-cma", name: "Contract Org" });
    expect(body.accounts).toEqual([{ id: "acc-cma", name: "Contract Account", slug: "contract-account", git_role: "admin", implicit: false, repos: 0, can_create: true, current: true }]);
    expect(contract.validateAccountList({ ...body, accounts: [{ ...body.accounts[0], git_role: "owner" }] }).ok).toBe(false);
  });

  it("the services fixture passes validateService", () => {
    const services = fixture("services");
    expect(services.map((s) => s.kind)).toEqual(["worker", "container", "terraform"]);
    for (const s of services) expect(contract.validateService(s), s.id).toEqual({ ok: true, errors: [] });
    expect(contract.validateService({ ...services[0], id: "worker:other" }).ok).toBe(false);
    expect(contract.validateService({ ...services[0], flow: { name: "x", yaml: "name: x\n" } }).ok).toBe(false);
  });

  it("change responses with a repair pass validateChangeRepair", () => {
    const repaired = changes.find((c) => c.repair);
    expect(contract.validateChangeRepair(repaired.repair)).toEqual({ ok: true, errors: [] });
    expect(validateChange(repaired).ok).toBe(true);
    expect(validateChange({ ...repaired, repair: { round: 3, max: 2 } }).errors).toEqual(["repair.round: expected integer in [1, max]"]);
  });

  it("validateChange rejects a change without target_branch", () => {
    const change = { ...changes[0] };
    delete change.target_branch;
    expect(validateChange(changes[0]).ok).toBe(true);
    expect(validateChange(change)).toEqual({ ok: false, errors: ["target_branch: required"] });
  });

  it("rejects insights with a malformed lists field", () => {
    const insights = fixture("insights");
    const bad = (lists) => contract.validateInsights({ ...insights, lists }).ok;
    expect(contract.validateInsights(insights)).toEqual({ ok: true, errors: [] });
    expect(bad(undefined)).toBe(false);
    expect(bad([{ metric: "", list: { path: "/api/agents", query: {} } }])).toBe(false);
    expect(bad([{ metric: "x", list: { path: "changes", query: {} } }])).toBe(false);
    expect(bad([{ metric: "x", list: { path: "/api/agents", query: null } }])).toBe(false);
    expect(bad([{ metric: "x", list: { path: "/api/agents", query: { since: 1 } } }])).toBe(false);
  });

  it("rejects an event with an unregistered action", () => {
    const event = changeDetail.events[0];
    expect(validateChangeEvent(event).ok).toBe(true);
    expect(validateChangeEvent({ ...event, action: "change.delete" }).ok).toBe(false);
  });

  it("agent events require agent_version", () => {
    const event = { ...changeDetail.events[0], actor: { type: "agent", id: "dev", runner: "lab" } };
    expect(validateChangeEvent(event)).toEqual({ ok: false, errors: ["actor.agent_version: required for agent events"] });
    expect(validateChangeEvent({ ...event, actor: { ...event.actor, agent_version: "agent/dev/v2" } }).ok).toBe(true);
  });

  it("flow list and flow file responses pass their validators", async () => {
    const fake = fakeArtifacts();
    const call = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
    await call("POST", "/api/repos", { name: "contract-flows" });
    Object.assign(fake.repos.get("contract-flows"), { commits: [{ sha: "s1" }],
      files: { ".cinder/flows/ci.yml": "name: ci\non: [manual]\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n", ".cinder/flows/bad.yml": "nope\n" } });
    expect((await call("POST", "/api/repos/contract-flows/flows/ci/runs")).status).toBe(201);
    const list = await (await call("GET", "/api/repos/contract-flows/flows")).json();
    expect(list.map((f) => [f.flow, f.last_run?.number])).toEqual([["ci", 1], ["bad", undefined]]);
    expect(contract.validateFlowList(list)).toEqual({ ok: true, errors: [] });
    for (const flow of ["ci", "bad"]) expect(contract.validateFlowFile(await (await call("GET", `/api/repos/contract-flows/flows/${flow}`)).json()), flow).toEqual({ ok: true, errors: [] });
    expect(contract.validateFlowList([{ ...list[0], health: { ...list[0].health, n: 9 } }]).ok).toBe(false);
    expect(contract.validateFlowFile({ yaml: "", def: null, head: "s1", last_run_steps: {} }).ok).toBe(false);
  });

  it("log pages and annotations pass their validators", () => {
    const [page, notes] = [fixture("flow-log-page"), fixture("flow-annotations")];
    expect(contract.validateFlowLogPage(page)).toEqual({ ok: true, errors: [] });
    for (const a of notes) expect(contract.validateFlowAnnotation(a)).toEqual({ ok: true, errors: [] });
    expect(contract.validateFlowLogPage({ ...page, next: 1 }).ok).toBe(false);
    expect(contract.validateFlowLogPage({ ...page, lines: [{ ...page.lines[0], n: 0 }] }).ok).toBe(false);
    expect(contract.validateFlowAnnotation({ ...notes[1], level: "fatal" }).ok).toBe(false);
  });

  it("policy preview response matches its shape", async () => {
    const fake = fakeArtifacts();
    await fake.create("contract-preview");
    Object.assign(fake.repos.get("contract-preview"), { commits: [{ sha: "c1" }], files: { ".cinder.yml": "branches:\n  integration: [develop, main]\n" } });
    await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('id-cpv', 'contract-preview', 'main', 'gitflow', '{}', ?)").bind(new Date().toISOString()).run();
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("contract-preview")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/contract-preview/policy/preview?strategy=release", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), { ...env, ARTIFACTS: fake });
    const body = await res.json();
    expect(body.changes.map((c) => c.key)).toEqual(["integration", "release"]);
    expect(contract.validatePolicyPreview(body)).toEqual({ ok: true, errors: [] });
    expect(contract.validatePolicyPreview(fixture("policy-preview"))).toEqual({ ok: true, errors: [] });
    expect(contract.validatePolicyPreview({ ...body, changes: [{ key: "check", from: "a", to: "b" }] }).ok).toBe(false);
    expect(contract.validatePolicyPreview({ ...body, policy: { ...body.policy, rules: [{ branch: "main" }] } }).ok).toBe(false);
  });
});

// Every source and test that could name a shape or a fixture, minus the shape files and the fixtures table themselves.
// A glob skips the file it is in, so this file comes in by its own import.
const sources = Object.entries({ self,
  ...import.meta.glob(["../src/**/*.js", "!../src/api/shapes/*.js", "./**/*.js", "!./helpers/fixtures.js"], { eager: true, query: "?raw", import: "default" }),
  ...import.meta.glob("../../web/src/**/*.{js,jsx}", { eager: true, query: "?raw", import: "default" }),
}).map(([, text]) => text).join("\n");
const nameUsed = (name, text = sources) => new RegExp(`\\b${name}\\b`).test(text);

it("every shape is used by a route", () => {
  const shapes = import.meta.glob("../src/api/shapes/*.js", { eager: true });
  const raw = import.meta.glob("../src/api/shapes/*.js", { eager: true, query: "?raw", import: "default" });
  // A validator another shape imports (pool.js's validateSettings) counts as used.
  const unused = Object.entries(shapes).flatMap(([file, m]) => Object.keys(m).filter((k) => k.startsWith("validate"))
    .filter((v) => !nameUsed(v) && !Object.entries(raw).some(([f, text]) => f !== file && nameUsed(v, text))));
  expect(unused).toEqual([]);
});

it("every fixture is checked and none is unused", () => {
  const rows = new Map(FIXTURES.map(([name, validator]) => [name, validator]));
  const unused = Object.keys(files).map((f) => f.match(/([^/]+)\.json$/)[1])
    .filter((name) => !sources.includes(`${name}.json`) && !(rows.has(name) && nameUsed(rows.get(name))));
  expect(unused).toEqual([]);
  expect(FIXTURES.filter(([, validator]) => !nameUsed(validator)).map(([name]) => name)).toEqual([]);
});

it("topic is not a judgment kind", () => {
  expect(contract.JUDGMENT_KINDS).not.toContain("topic");
});

it("every judgment kind has a question", () => {
  expect(Object.keys(contract.KIND_QUESTIONS)).toEqual(contract.JUDGMENT_KINDS);
});

it("bisect and acceptance are not job kinds", () => {
  expect(contract.JOB_KINDS).not.toContain("bisect");
  expect(contract.JOB_KINDS).not.toContain("acceptance");
});
