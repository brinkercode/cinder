import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { recordJudgment, recordVerdict } from "../src/judgments.js";
import { queueScan } from "../src/scans.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A repo with one verifying change.
async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN, method = body === undefined ? "GET" : "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  fake.repos.get(name).commits.unshift({ sha: "s1" });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
  const { id } = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
  for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: id, result: "ok" });
  const needs = async (kind) => (await (await call("/api/needs")).json()).filter((n) => n.kind === kind && n.repo === name);
  return { call, repo, id, stub, needs };
}

describe("needs you producers", () => {
  it("conflicting judgments on a verified change raise a Judges disagree need", async () => {
    const { repo, id, needs } = await setup("need-disagree");
    await recordVerdict(env.DB, { id, repo_id: repo }, { person: "owner", verdict: "fail" });
    expect(await needs("Judges disagree")).toEqual([]);
    await recordJudgment(env.DB, { repo, change: id, kind: "risk", backend: "workers-ai", model: "m1", state_hash: "h", question: "How risky is this change?", answer: "low", p: 0.8 });
    expect((await needs("Judges disagree")).map((n) => [n.change, n.actions])).toEqual([[id, ["Merge", "Reject", "Open change"]]]);
    // The person relabels it low: the judges agree and the need clears.
    await recordVerdict(env.DB, { id, repo_id: repo }, { person: "owner", verdict: "pass" });
    expect(await needs("Judges disagree")).toEqual([]);
  });

  // Two judges disagree on the verifying change: a Judges disagree item is open.
  const disagree = async (repo, id, needs) => {
    await recordVerdict(env.DB, { id, repo_id: repo }, { person: "owner", verdict: "fail" });
    await recordJudgment(env.DB, { repo, change: id, kind: "risk", backend: "workers-ai", model: "m1", state_hash: "h", question: "How risky is this change?", answer: "low", p: 0.8 });
    expect(await needs("Judges disagree")).toHaveLength(1);
  };

  it("closing a change with a Judges disagree item removes it from GET /api/needs", async () => {
    const { call, repo, id, needs } = await setup("need-disagree-close");
    await disagree(repo, id, needs);
    expect((await call(`/api/changes/${id}/close`, {})).status).toBe(200);
    expect(await needs("Judges disagree")).toEqual([]);
  });

  it("a change moving from verifying to needs_fix leaves no Merge/Reject decision item", async () => {
    const { repo, id, stub, needs } = await setup("need-disagree-fix");
    await disagree(repo, id, needs);
    await stub.transition("needs_fix", { kind: "needs_fix", actor: { type: "system", id: "test" }, action: "stage.decide", target: id, result: "fail" });
    expect((await stub.get()).state).toBe("needs_fix");
    expect((await needs("Judges disagree")).filter((n) => n.change === id)).toEqual([]);
  });

  it("a scan with a critical advisory raises a Critical advisory need", async () => {
    const { call, repo, needs } = await setup("need-advisory");
    const critical = { id: "GHSA-crit", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }], affected: [] };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => (String(url).endsWith("/querybatch")
      ? Response.json({ results: JSON.parse(init.body).queries.map((q) => ({ vulns: q.package.name === "next" ? [{ id: "GHSA-crit" }] : [] })) })
      : Response.json(critical)));
    onTestFinished(() => fetch.mockRestore());
    const token = (await (await call("/api/runners", { name: "need-advisory-lab", kinds: ["scan"] })).json()).token;
    const scan = async (deps) => {
      await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'scan' AND status = 'queued'").run();
      await queueScan(env, repo, "main", "merge");
      const { job } = await (await call("/api/work/claim", { kinds: ["scan"] }, token)).json();
      expect((await call(`/api/work/jobs/${job.id}/report`, { status: "done", deps }, token)).status).toBe(200);
    };
    await scan([{ ecosystem: "npm", name: "next", version: "16.3.8", license: "MIT", class: "permissive" }]);
    expect((await needs("Critical advisory")).map((n) => [n.text, n.actions])).toEqual([["next 16.3.8 has critical advisory GHSA-crit.", ["Open fix change", "Watchtower"]]]);
    // A later scan without it clears the need.
    await scan([{ ecosystem: "npm", name: "react", version: "19.0.0", license: "MIT", class: "permissive" }]);
    expect(await needs("Critical advisory")).toEqual([]);
  });

  it("a lease takeover raises a Lease takeover need for the previous holder", async () => {
    const { call, id, stub, needs } = await setup("need-takeover");
    await stub.setDriver("ana");
    expect((await call(`/api/changes/${id}/takeover`, null)).status).toBe(200);
    expect((await needs("Lease takeover")).map((n) => [n.change, n.text, n.actions]))
      .toEqual([[id, `owner took over ana's lease on change ${id}.`, ["Grant to ana", "Open change"]]]);
    // Releasing the change clears it.
    await call(`/api/changes/${id}/release`, null);
    expect(await needs("Lease takeover")).toEqual([]);
  });
});
