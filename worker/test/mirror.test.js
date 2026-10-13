import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { recordJudgment, recordOutcome } from "../src/judgments.js";
import { ingestAdvisories, judgeResemblesVuln } from "../src/mirror.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, init = {}) =>
  worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: OWNER }), { ...env, ARTIFACTS: fakeArtifacts() });

// Fake embedding: normalised character-bigram counts hashed into 256 buckets, so near-duplicate code lands close.
function embed(text) {
  const v = new Array(256).fill(0);
  const s = text.replace(/\s+/g, " ");
  for (let i = 0; i < s.length - 1; i++) v[(s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) % 256] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

// Fake Vectorize: cosine similarity over the indexed vectors.
const fakeIndex = (rows) => ({
  rows,
  getByIds: async (ids) => rows.filter((r) => ids.includes(r.id)),
  upsert: async (vectors) => {
    for (const v of vectors) rows.splice(rows.findIndex((r) => r.id === v.id) >>> 0, 1, v);
  },
  query: async (vector, { topK }) => ({
    matches: rows
      .map((r) => ({ id: r.id, score: r.values.reduce((s, x, i) => s + x * vector[i], 0), metadata: r.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK),
  }),
});

// Fake AI: embeds for the embedding model; as the clef backend it answers the Noul with the nearest match's score.
const clef = fakeClefAI(async (model, body) => ({ resembles_vuln: Math.max(0, body.state.matches[0]?.score ?? 0) }));
const fakeAI = {
  run: async (model, body) => body.text
    ? { data: body.text.map(embed) }
    : clef.run(model, body),
};

const VULN = `function readFile(req, res) {
  const p = path.join(ROOT, req.query.name);
  res.send(fs.readFileSync(p));
}`;

const vulnIndex = () => fakeIndex([
  { id: "CVE-2021-0001", values: embed(VULN), metadata: { cve: "CVE-2021-0001" } },
  { id: "CVE-2022-0002", values: embed("SELECT * FROM users WHERE id = ' + id + '"), metadata: { cve: "CVE-2022-0002" } },
]);

// Creates the repo with post and trusts its resembles_vuln judge: one recorded outcome against a min_outcomes of 1.
async function trustedRepo(name, post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) })) {
  await post("/api/repos", { name });
  const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'resembles_vuln', 'clef', 'clef@1')").bind(repo),
    env.DB.prepare("INSERT OR REPLACE INTO repo_trust (repo, min_outcomes) VALUES (?, 1)").bind(repo),
  ]);
  const id = await recordJudgment(env.DB, { repo, kind: "resembles_vuln", backend: "clef", model: "clef@1", state_hash: "sha256:01", question: "q", answer: "yes", p: 0.99 });
  await recordOutcome(env.DB, id, "yes", "2026-10-04T10:00:00.000Z");
  return repo;
}

describe("mirror", () => {
  it("a near-duplicate of an indexed vulnerable function scores high (fake AI and Vectorize)", async () => {
    const repo = await trustedRepo("mirror");
    const VULN_INDEX = vulnIndex();
    const fns = [
      { path: "src/files.js", name: "serveFile", body: VULN.replace("readFile", "serveFile").replace("name", "file") },
      { path: "src/math.js", name: "add", body: "export const add = (a, b) => a + b;" },
    ];
    const out = await judgeResemblesVuln({ ...env, AI: fakeAI, VULN_INDEX }, repo, fns);
    expect(out["src/files.js:serveFile"]).toMatchObject({ answer: "yes", trusted: true, match: "CVE-2021-0001" });
    expect(out["src/files.js:serveFile"].p).toBeGreaterThan(0.9);
    expect(out["src/math.js:add"]).toMatchObject({ answer: "no", trusted: true });
    const list = (await env.DB.prepare("SELECT j.* FROM judgments j JOIN repos r ON r.id = j.repo_id WHERE r.name = ? AND j.kind = ? ORDER BY j.made_at").bind("mirror", "resembles_vuln").all()).results;
    expect(list.map((j) => j.kind)).toEqual(["resembles_vuln", "resembles_vuln", "resembles_vuln"]);
  });

  it("a guard report calls the judge and its match shows in Watchtower", async () => {
    const name = "mirror-guard";
    const fake = fakeArtifacts();
    const e = { ...env, ARTIFACTS: fake, AI: fakeAI, VULN_INDEX: vulnIndex() };
    const post = (path, body, token = env.OWNER_TOKEN) => worker.fetch(new Request(`http://cinder.test${path}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), e);
    const repo = await trustedRepo(name, post);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const change = await (await post(`/api/repos/${name}/changes`, { intent: "x" })).json();
    await env.DB.prepare("DELETE FROM jobs WHERE change_id = ?").bind(change.id).run();
    const token = (await (await post("/api/runners", { name: "lab", kinds: ["guard"] })).json()).token;
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'guard', ?, 'queued', ?, '{}')")
      .bind(job, repo, change.id, new Date().toISOString()).run();
    await post("/api/work/claim", { kinds: ["guard"] }, token);
    const body = VULN.replace("readFile", "serveFile").replace("name", "file").split("\n").map((l) => `+${l}`).join("\n");
    const diff = `diff --git a/src/files.js b/src/files.js\n--- /dev/null\n+++ b/src/files.js\n@@ -0,0 +1,4 @@\n${body}\n`;
    expect((await post(`/api/work/jobs/${job}/report`, { status: "done", findings: [], diff }, token)).status).toBe(200);
    const tower = await (await call(`/api/repos/${name}/watchtower`)).json();
    expect(tower.findings).toEqual([expect.objectContaining({ source: "code", severity: "high", title: "resembles CVE-2021-0001", location: "src/files.js" })]);
  });

  it("the cron embeds each scanned advisory into the index once, with its fix commit's removed lines, skipping one OSV lacks", async () => {
    await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "mirror-ingest" }) });
    const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = 'mirror-ingest'").first()).id;
    const job = crypto.randomUUID();
    const deps = [{ name: "send", vulns: [{ id: "GHSA-aaaa" }, { id: "GHSA-gone" }] }];
    await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) VALUES (?, ?, 'scan', 'done', '2026-10-04', '{}')").bind(job, repo),
      env.DB.prepare("INSERT INTO scans (job_id, repo_id, target, source, sha, status, started_at) VALUES (?, ?, 'main', 'daily', 'abc', 'done', '2026-10-04')").bind(job, repo),
      env.DB.prepare("INSERT INTO scan_deps (job_id, deps) VALUES (?, ?)").bind(job, JSON.stringify(deps)),
    ]);
    const fix = "https://github.com/o/send/commit/abcdef1";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === `${fix}.diff`) return new Response(`--- a/index.js\n+++ b/index.js\n-${VULN}\n+safe()\n`);
      if (String(url).endsWith("GHSA-gone")) return new Response("not found", { status: 404 });
      return Response.json({ id: "GHSA-aaaa", summary: "path traversal", references: [{ type: "FIX", url: fix }] });
    });
    onTestFinished(() => fetch.mockRestore());
    const embedded = [];
    const ai = { run: async (model, { text }) => (embedded.push(...text), { data: text.map(embed) }) };
    const VULN_INDEX = fakeIndex([]);
    await ingestAdvisories({ ...env, AI: ai, VULN_INDEX });
    await ingestAdvisories({ ...env, AI: ai, VULN_INDEX });
    expect(VULN_INDEX.rows.map((r) => [r.id, r.metadata])).toEqual([["GHSA-aaaa", { cve: "GHSA-aaaa", summary: "path traversal" }]]);
    expect(embedded).toEqual([`path traversal\n${VULN.split("\n")[0]}`]);
  });
});
