import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateWatchtower } from "../src/api/contract.js";
import { recordScan } from "../src/findings.js";
import worker from "../src/index.js";
import { recordJudgment } from "../src/judgments.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

async function repo(id) {
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', '2026-10-05T00:00:00Z')")
    .bind(id, id).run();
}
const secret = (line) => ({ rule: "aws-key", severity: "high", path: "src/a.js", line, fingerprint: "sha256:aws" });
const rows = (id) => env.DB.prepare("SELECT * FROM findings WHERE repo_id = ? ORDER BY id").bind(id).all().then((r) => r.results);

describe("findings store", () => {
  it("the same secret moved to another line keeps one finding", async () => {
    await repo("f-move");
    await recordScan(env.DB, { repo: "f-move", target: "main", source: "secret", sha: "s1", full: true, findings: [secret(3)] });
    await recordScan(env.DB, { repo: "f-move", target: "main", source: "secret", sha: "s2", full: true, findings: [secret(40)] });
    expect(await rows("f-move")).toMatchObject([{ fingerprint: "sha256:aws", state: "open", first_sha: "s1", last_sha: "s2" }]);
  });

  it("a finding missing from the next full scan becomes fixed", async () => {
    await repo("f-fix");
    const dep = { rule: "osv", severity: "low", path: "go.mod", fingerprint: "sha256:dep" };
    await recordScan(env.DB, { repo: "f-fix", target: "main", source: "secret", sha: "s1", full: true, findings: [secret(3)] });
    await recordScan(env.DB, { repo: "f-fix", target: "main", source: "dependency", sha: "s1", full: true, findings: [dep] });
    await recordScan(env.DB, { repo: "f-fix", target: "main", source: "secret", sha: "s2", full: false, findings: [] });
    expect((await rows("f-fix"))[0].state).toBe("open");
    await recordScan(env.DB, { repo: "f-fix", target: "main", source: "secret", sha: "s3", full: true, findings: [] });
    expect(await rows("f-fix")).toMatchObject([
      { fingerprint: "sha256:aws", state: "fixed", fixed_sha: "s3", last_sha: "s1" },
      { fingerprint: "sha256:dep", state: "open", fixed_sha: null },
    ]);
  });

  it("a dismissed finding stays dismissed when it is seen again", async () => {
    await repo("f-dismiss");
    await recordScan(env.DB, { repo: "f-dismiss", target: "main", source: "secret", sha: "s1", full: true, findings: [secret(3)] });
    await env.DB.prepare("UPDATE findings SET state = 'dismissed', dismiss_reason = 'test key', dismissed_by = 'amy@x' WHERE repo_id = 'f-dismiss'").run();
    await recordScan(env.DB, { repo: "f-dismiss", target: "main", source: "secret", sha: "s2", full: true, findings: [secret(9)] });
    expect(await rows("f-dismiss")).toMatchObject([{ state: "dismissed", dismiss_reason: "test key", dismissed_by: "amy@x", last_sha: "s2" }]);
  });
});

const fake = fakeArtifacts();
const call = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`,
  { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });

// A repo with one change, a guard judgment on it and an open finding that judgment raised.
async function hazard(name) {
  await call("POST", "/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call("POST", `/api/repos/${name}/changes`, { intent: "x" })).json();
  const judgment = await recordJudgment(env.DB, { repo: change.repo_id, change: change.id, kind: "guard", backend: "clef", model: "clef@1",
    state_hash: "h", question: "secret?", answer: "yes", p: 0.9 });
  await recordScan(env.DB, { repo: change.repo_id, target: "main", source: "secret", sha: "s1", full: false, findings: [secret(3)] });
  const finding = await env.DB.prepare("SELECT id FROM findings WHERE repo_id = ?").bind(change.repo_id).first("id");
  await env.DB.prepare("INSERT INTO finding_judgments (finding_id, judgment_id) VALUES (?, ?)").bind(finding, judgment).run();
  return { change, judgment, finding };
}
const findingBlockers = async (id) => (await (await call("GET", `/api/changes/${id}`)).json()).blockers.filter((b) => b.code === "finding_open");

describe("finding dismissal", () => {
  it("dismiss records the reason and actor", async () => {
    const { finding } = await hazard("f-dismiss-actor");
    expect((await call("POST", `/api/findings/${finding}/dismiss`, { reason: "nope" })).status).toBe(400);
    const res = await call("POST", `/api/findings/${finding}/dismiss`, { reason: "risk_accepted", note: "test fixture" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "dismissed", dismiss_reason: "risk_accepted", note: "test fixture", dismissed_by: "owner" });
    expect(await env.DB.prepare("SELECT dismiss_reason, dismissed_by, n.note FROM findings JOIN finding_notes n ON n.finding_id = id WHERE id = ?").bind(finding).first())
      .toEqual({ dismiss_reason: "risk_accepted", dismissed_by: "owner", note: "test fixture" });
    expect((await call("POST", `/api/findings/${finding}/dismiss`, { reason: "wont_fix" })).status).toBe(409);
    expect((await call("POST", "/api/findings/999999/dismiss", { reason: "wont_fix" })).status).toBe(404);
  });

  it("a false positive closes the linked guard judgment with no", async () => {
    const { finding, judgment } = await hazard("f-dismiss-fp");
    expect((await call("POST", `/api/findings/${finding}/dismiss`, { reason: "false_positive" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT actual, correct FROM outcomes WHERE judgment_id = ?").bind(judgment).first())
      .toEqual({ actual: "no", correct: 0 });
  });

  it("dismiss with reason revoked succeeds on a secret finding", async () => {
    const { finding } = await hazard("f-dismiss-revoked");
    const res = await call("POST", `/api/findings/${finding}/dismiss`, { reason: "revoked" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "secret", state: "dismissed", dismiss_reason: "revoked" });
  });

  it("reopen makes the finding block again", async () => {
    const { change, finding } = await hazard("f-reopen");
    expect(await findingBlockers(change.id)).toHaveLength(1);
    await call("POST", `/api/findings/${finding}/dismiss`, { reason: "wont_fix" });
    expect(await findingBlockers(change.id)).toEqual([]);
    const res = await call("POST", `/api/findings/${finding}/reopen`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "open", dismiss_reason: null, dismissed_by: null, note: null });
    expect(await findingBlockers(change.id)).toMatchObject([{ code: "finding_open", reason: `finding ${finding}: aws-key in src/a.js` }]);
  });
});

// A repo whose latest done scan saw lodash 4.17.20 with a vuln fixed in 4.17.21, and its open dependency finding.
async function vulnerableLodash(name) {
  await call("POST", "/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const repoId = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
  const job = crypto.randomUUID();
  const deps = [{ ecosystem: "npm", name: "lodash", version: "4.17.20", vulns: [{ id: "GHSA-35jh-r3h4-6jhm", fixed_in: "4.17.21" }] }];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) VALUES (?, ?, 'scan', 'done', '2026-10-05T00:00:00Z', '{}')").bind(job, repoId),
    env.DB.prepare("INSERT INTO scans (job_id, repo_id, target, source, sha, status, started_at, finished_at) VALUES (?, ?, 'main', 'daily', 's1', 'done', " +
      "'2026-10-05T00:00:00Z', '2026-10-05T00:01:00Z')").bind(job, repoId),
    env.DB.prepare("INSERT INTO scan_deps (job_id, deps) VALUES (?, ?)").bind(job, JSON.stringify(deps)),
  ]);
  await recordScan(env.DB, { repo: repoId, target: "main", source: "dependency", sha: "s1", full: true,
    findings: [{ rule: "GHSA-35jh-r3h4-6jhm", severity: "high", path: "lodash@4.17.20", fingerprint: "npm|lodash|GHSA-35jh-r3h4-6jhm" }] });
  const finding = await env.DB.prepare("SELECT id FROM findings WHERE repo_id = ?").bind(repoId).first("id");
  return { repoId, finding };
}

describe("fix with an agent", () => {
  it("fix creates a change whose intent names the package and fixed version", async () => {
    const { finding } = await vulnerableLodash("f-fix-intent");
    const res = await call("POST", `/api/findings/${finding}/fix`);
    expect(res.status).toBe(201);
    const change = await res.json();
    expect(change.intent).toBe(`bump lodash 4.17.20 → 4.17.21 (fixes GHSA-35jh-r3h4-6jhm, finding ${finding})`);
    expect(change.target_branch).toBe("main");
    expect((await call("POST", "/api/findings/999999/fix")).status).toBe(404);
  });

  it("the finding links to the change and closes after the clean scan", async () => {
    const { repoId, finding } = await vulnerableLodash("f-fix-close");
    const change = await (await call("POST", `/api/findings/${finding}/fix`)).json();
    const link = () => env.DB.prepare("SELECT change_id, fixed_by, f.state, f.fixed_sha FROM finding_fixes JOIN findings f ON f.id = finding_id WHERE finding_id = ?")
      .bind(finding).first();
    expect(await link()).toEqual({ change_id: change.id, fixed_by: null, state: "open", fixed_sha: null });
    expect((await (await call("GET", "/api/repos/f-fix-close/watchtower")).json()).findings[0].fix_change).toBe(change.id);
    await env.DB.prepare("UPDATE changes SET state = 'merged' WHERE id = ?").bind(change.id).run();
    await recordScan(env.DB, { repo: repoId, target: "main", source: "dependency", sha: "s2", full: true, findings: [] });
    expect(await link()).toEqual({ change_id: change.id, fixed_by: change.id, state: "fixed", fixed_sha: "s2" });
    expect((await call("POST", `/api/findings/${finding}/fix`)).status).toBe(409);
  });
});

describe("fix change reuse", () => {
  it("Open fix change on a finding with an open fix returns that change and keeps its link", async () => {
    const { finding } = await vulnerableLodash("f-fix-reuse");
    const first = await (await call("POST", `/api/findings/${finding}/fix`)).json();
    const again = await call("POST", `/api/findings/${finding}/fix`);
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(first.id);
    expect(await env.DB.prepare("SELECT change_id FROM finding_fixes WHERE finding_id = ?").bind(finding).first("change_id")).toBe(first.id);
  });
});

describe("watchtower findings", () => {
  it("GET watchtower returns a secret finding with state, rule, path and first_seen; ?state=all adds the dismissed one with its reason", async () => {
    await call("POST", "/api/repos", { name: "f-wt-states" });
    const repoId = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind("f-wt-states").first("id");
    const stripe = { rule: "stripe-secret-key", severity: "high", path: ".env.production", line: 4, fingerprint: "sha256:stripe" };
    await recordScan(env.DB, { repo: repoId, target: "main", source: "secret", sha: "s1", full: true, findings: [stripe, secret(3)] });
    await env.DB.prepare("UPDATE findings SET state = 'dismissed', dismiss_reason = 'revoked' WHERE repo_id = ? AND rule = 'aws-key'").bind(repoId).run();
    const open = await (await call("GET", "/api/repos/f-wt-states/watchtower")).json();
    expect(open.findings).toMatchObject([{ source: "secret", state: "open", rule: "stripe-secret-key", path: ".env.production", line: 4, dismiss_reason: null, fix_change: null }]);
    expect(Date.parse(open.findings[0].first_seen)).not.toBeNaN();
    const all = await (await call("GET", "/api/repos/f-wt-states/watchtower?state=all")).json();
    expect(validateWatchtower(all)).toEqual({ ok: true, errors: [] });
    expect(all.findings.map((f) => [f.rule, f.state, f.dismiss_reason])).toEqual([["stripe-secret-key", "open", null], ["aws-key", "dismissed", "revoked"]]);
  });
});
