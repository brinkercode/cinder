import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { recordScan } from "../src/findings.js";
import worker from "../src/index.js";
import { judgeResemblesVuln } from "../src/mirror.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

const fake = fakeArtifacts();
const call = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`,
  { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });

// Fake AI and Vectorize: every function's nearest advisory is CVE-1, and the clef judge answers yes.
const clef = fakeClefAI(async () => ({ resembles_vuln: 0.9 }));
const AI = { run: async (model, body) => (body.text ? { data: body.text.map(() => [1]) } : clef.run(model, body)) };
const VULN_INDEX = { query: async () => ({ matches: [{ id: "CVE-1", score: 0.9, metadata: {} }] }) };

// A change whose resembles_vuln judge judged src/files.js, then a scan at the change's head finding a rule in that file.
async function judgedScan(name) {
  await call("POST", "/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call("POST", `/api/repos/${name}/changes`, { intent: "x" })).json();
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'resembles_vuln', 'clef', 'clef@1')").bind(change.repo_id),
    env.DB.prepare("INSERT OR REPLACE INTO change_heads (change_id, head_sha) VALUES (?, 'h1')").bind(change.id),
  ]);
  await judgeResemblesVuln({ ...env, AI, VULN_INDEX }, change.repo_id, [{ path: "src/files.js", name: "serve", body: "x()" }], change.id);
  const judgment = await env.DB.prepare("SELECT id FROM judgments WHERE change_id = ? AND kind = 'resembles_vuln'").bind(change.id).first("id");
  await recordScan(env.DB, { repo: change.repo_id, target: "main", source: "code", sha: "h1", full: false,
    findings: [{ rule: "path-traversal", severity: "high", path: "src/files.js", fingerprint: "path-traversal|src/files.js" }] });
  const finding = await env.DB.prepare("SELECT id FROM findings WHERE repo_id = ?").bind(change.repo_id).first("id");
  return { change, judgment, finding };
}

describe("finding judgments", () => {
  it("a scan finding on a judged path links to its hazard judgment", async () => {
    const { judgment, finding } = await judgedScan("fj-link");
    expect(judgment).toBeTruthy();
    expect(await env.DB.prepare("SELECT judgment_id FROM finding_judgments WHERE finding_id = ?").bind(finding).first("judgment_id")).toBe(judgment);
  });

  it("a false-positive dismissal scores the linked judgment no", async () => {
    const { judgment, finding } = await judgedScan("fj-dismiss");
    expect((await call("POST", `/api/findings/${finding}/dismiss`, { reason: "false_positive" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT actual, correct FROM outcomes WHERE judgment_id = ?").bind(judgment).first())
      .toEqual({ actual: "no", correct: 0 });
  });

  it("an open linked finding blocks merging the judged change", async () => {
    const { change, finding } = await judgedScan("fj-block");
    const blockers = (await (await call("GET", `/api/changes/${change.id}`)).json()).blockers.filter((b) => b.code === "finding_open");
    expect(blockers).toHaveLength(1);
    expect(JSON.stringify(blockers[0])).toContain(String(finding));
  });
});
