import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

const asked = [];
const AI = fakeClefAI(async (model, body) => (asked.push(body), { secret: 0, agent_instructions: 0, file_type: 0 }));

async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake, AI },
  );
  await call("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  // Creating the change leased it and queued a develop job; each test queues its own jobs.
  await env.DB.prepare("DELETE FROM jobs WHERE change_id = ?").bind(change.id).run();
  await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'guard', 'clef', 'clef@1')").bind(change.repo_id).run();
  const token = (await (await call("/api/runners", { name: "lab", kinds: ["develop", "guard", "verify"] })).json()).token;
  const run = async (kind, report) => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, ?, ?, 'queued', ?, '{}')")
      .bind(id, change.repo_id, kind, change.id, new Date().toISOString()).run();
    const claim = await call("/api/work/claim", { kinds: [kind] }, token);
    if (report) expect((await call(`/api/work/jobs/${id}/report`, report, token)).status).toBe(200);
    return { id, claim };
  };
  return { call, fake, stub, run };
}

// Fakes OSV: every queried package has the vulns { id: [cvss vectors] }; null makes OSV unreachable.
function fakeOsv(vulns) {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (!vulns) throw new TypeError("fetch failed");
    if (String(url) === "https://api.osv.dev/v1/querybatch") {
      return Response.json({ results: JSON.parse(init.body).queries.map(() => ({ vulns: Object.keys(vulns).map((id) => ({ id })) })) });
    }
    const id = String(url).split("/").at(-1);
    return Response.json({ id, severity: vulns[id].map((score) => ({ type: "CVSS_V3", score })) });
  });
  onTestFinished(() => fetch.mockRestore());
}

const LEFT_PAD = [{ ecosystem: "npm", name: "left-pad", version: "1.3.0", license: "MIT", class: "permissive" }];

describe("guard", () => {
  it("a deterministic hit quarantines whatever System 1 answers, and scores its secret answer", async () => {
    const { stub, run } = await setup("guard-det");
    await run("guard", { status: "done", findings: [{ rule: "aws-access-key", path: "a.js", line: 3 }], diff: "+AKIA..." });
    const change = await stub.get();
    expect(change.guard).toMatchObject({ status: "quarantined", reason: "deterministic: aws-access-key" });
    // The judge answered no to the secret question; the scan proves the answer wrong.
    const scored = await env.DB.prepare("SELECT j.question, o.actual, o.correct FROM judgments j JOIN outcomes o ON o.judgment_id = j.id " +
      "WHERE j.change_id = ? AND j.kind = 'guard'").bind(change.id).all();
    expect(scored.results).toEqual([{ question: "Does this diff add secret-like content (keys, tokens, passwords)?", actual: "yes", correct: 0 }]);
  });

  it("verify refuses a quarantined change", async () => {
    const { fake, stub, run } = await setup("guard-verify");
    await run("develop", { status: "done" });
    await run("guard", { status: "done", findings: [{ rule: "binary", path: "x.bin" }] });
    // Claim the test's own verify job, not the one the develop report queued (which the quarantine cancelled).
    await env.DB.prepare("DELETE FROM job_cancels WHERE job_id IN (SELECT id FROM jobs WHERE change_id = ? AND kind = 'verify')").bind((await stub.get()).id).run();
    await env.DB.prepare("DELETE FROM jobs WHERE change_id = ? AND kind = 'verify'").bind((await stub.get()).id).run();
    const tokensBefore = fake.calls.filter((c) => c.method === "createToken" && c.args[0] !== "cinder-agents").length;
    const { id, claim } = await run("verify");
    expect(claim.status).toBe(204);
    expect(fake.calls.filter((c) => c.method === "createToken" && c.args[0] !== "cinder-agents").length).toBe(tokensBefore);
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(id).first()).status).toBe("failed");
    const change = await stub.get();
    expect(change.state).toBe("needs_fix");
    expect(change.events.at(-2)).toMatchObject({ kind: "quarantined", reason: "deterministic: binary" });
  });

  it("approval clears the dependency blocker", async () => {
    const { call, stub, run } = await setup("guard-deps");
    fakeOsv({});
    const deps = [{ ecosystem: "npm", name: "gpl-thing", version: "2.0.0", license: "GPL-3.0-only", class: "copyleft" }];
    await run("guard", { status: "done", findings: [], deps });
    const blockers = async () => (await (await worker.fetch(new Request(`http://cinder.test/api/changes/${(await stub.get()).id}`,
      { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env)).json()).blockers.filter((b) => b.code === "dependency_unapproved");
    expect((await blockers()).map((b) => b.reason)).toEqual(["copyleft npm dependency gpl-thing@2.0.0 (GPL-3.0-only) needs owner approval"]);
    const need = await env.DB.prepare("SELECT id FROM needs WHERE kind = 'Dependency needs approval' AND change_id = ?").bind((await stub.get()).id).first("id");
    expect((await call(`/api/needs/${need}/resolve`, { action: "Approve" })).status).toBe(200);
    expect(await blockers()).toEqual([]);
  });

  it("a known-vulnerable version is reported with its ID (fake OSV)", async () => {
    const { stub, run } = await setup("guard-osv-vuln");
    fakeOsv({ "GHSA-crit": ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"], "GHSA-med": ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N"] });
    await run("guard", { status: "done", findings: [], deps: LEFT_PAD });
    expect((await stub.get()).guard.deps[0]).toMatchObject({
      osv: "vulnerable", vulns: [{ id: "GHSA-crit", severity: "critical" }, { id: "GHSA-med", severity: "medium" }],
    });
    const detail = await (await worker.fetch(new Request(`http://cinder.test/api/changes/${(await stub.get()).id}`,
      { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env)).json();
    expect(detail.blockers.filter((b) => b.code === "dependency_vulnerable").map((b) => b.reason))
      .toEqual(["npm dependency left-pad@1.3.0 has critical GHSA-crit"]);
  });

  it("an unparseable vector yields 'unknown', not a number", async () => {
    const { stub, run } = await setup("guard-osv-unknown");
    fakeOsv({ "GHSA-odd": ["CVSS:3.1/AV:N/AC:L/garbage"] });
    await run("guard", { status: "done", findings: [], deps: LEFT_PAD });
    expect((await stub.get()).guard.deps[0].vulns).toEqual([{ id: "GHSA-odd", severity: "unknown", fixed_in: null, also_fixes: 0 }]);
  });

  it("OSV unreachable reports 'unchecked', not 'clean'", async () => {
    const { stub, run } = await setup("guard-osv-down");
    fakeOsv(null);
    await run("guard", { status: "done", findings: [], deps: LEFT_PAD });
    expect((await stub.get()).guard.deps[0]).toMatchObject({ osv: "unchecked", vulns: [] });
  });

  it("Release: false positive clears the quarantine and records the outcome", async () => {
    const { call, stub, run } = await setup("guard-release");
    fakeOsv({});
    await run("guard", { status: "done", findings: [], diff: "+x" });
    const change = await stub.get();
    // System 1 judged this diff; quarantine it as a trusted yes would.
    await stub.setGuard({ ...change.guard, status: "quarantined", reason: "hazard: secret" });
    const res = await call(`/api/changes/${change.id}/quarantine`, { action: "release" });
    expect(res.status).toBe(200);
    expect((await stub.get()).guard).toMatchObject({ status: "clear", reason: "hazard: secret" });
    const { results } = await env.DB.prepare(
      "SELECT o.actual FROM judgments j JOIN outcomes o ON o.judgment_id = j.id WHERE j.change_id = ? AND j.kind = 'guard'",
    ).bind(change.id).all();
    expect(results.map((r) => r.actual)).toEqual(["no", "no", "no"]);
    expect((await call(`/api/changes/${change.id}/quarantine`, { action: "release" })).status).toBe(409);
  });
});

describe("a quarantine after verify passed", () => {
  // develop, then a passing verify, then the guard reports a deterministic finding on the head verify already passed.
  async function lateQuarantine(name, person) {
    const { stub, run } = await setup(name);
    // An earlier test's repair job is still queued; a claim would pick it up.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await run("develop", { status: "done" });
    await env.DB.prepare("DELETE FROM jobs WHERE change_id = ? AND kind = 'verify'").bind((await stub.get()).id).run();
    await stub.stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: (await stub.get()).id, result: "ok" }, { head: "h1" });
    await run("verify", { status: "done" });
    if (person) await stub.setDriver("dev@example.com");
    // Claim the test's own guard job, not one queued for the change's head.
    await env.DB.prepare("DELETE FROM jobs WHERE change_id = ? AND kind = 'guard'").bind((await stub.get()).id).run();
    const before = (await stub.get()).state;
    expect(["verifying", "in_queue"]).toContain(before);
    await run("guard", { status: "done", findings: [{ rule: "stripe_secret_key", path: "a.js", line: 1 }], diff: "+sk_live_x" });
    return { change: await stub.get(), before };
  }
  const needs = async (id) => (await env.DB.prepare("SELECT kind FROM needs WHERE change_id = ?").bind(id).all()).results.map((n) => n.kind);

  it("a quarantine after verify passed sends an agent change back to needs_fix", async () => {
    const { change } = await lateQuarantine("guard-late-agent", false);
    expect(change.state).toBe("needs_fix");
    expect(change.events.some((e) => e.kind === "quarantined" && e.reason === "deterministic: stripe_secret_key")).toBe(true);
    const { results } = await env.DB.prepare("SELECT kind FROM jobs WHERE change_id = ? AND status = 'queued' AND id NOT IN (SELECT job_id FROM job_cancels)")
      .bind(change.id).all();
    expect(results.map((r) => r.kind)).toEqual(["develop"]);
    expect(await needs(change.id)).not.toContain("Change quarantined");
  });

  it("a person's quarantined change still waits for them", async () => {
    const { change, before } = await lateQuarantine("guard-late-person", true);
    expect(change.state).toBe(before);
    expect(change.guard.status).toBe("quarantined");
    expect(await needs(change.id)).toContain("Change quarantined");
  });
});
