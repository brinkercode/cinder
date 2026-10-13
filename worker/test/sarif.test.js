import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const fake = fakeArtifacts();
const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
  new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  { ...env, ARTIFACTS: fake },
);
const sarif = JSON.stringify({ version: "2.1.0", runs: [{ results: [{ ruleId: "sqli", locations: [] }] }] });

describe("sarif upload", () => {
  it("an uploaded SARIF's ingest report records a critical code finding", async () => {
    expect((await call("/api/repos", { name: "sarif-ok" })).status).toBe(201);
    const runner = (await (await call("/api/runners", { name: "ci", kinds: ["ingest-sarif"] })).json()).token;
    const up = await call("/api/repos/sarif-ok/sarif?sha=abc", sarif);
    expect(up.status).toBe(202);
    const claim = await (await call("/api/work/claim", { kinds: ["ingest-sarif"], slots_free: 1 }, runner)).json();
    expect(claim).toMatchObject({ job: { id: (await up.json()).job, kind: "ingest-sarif" }, payload: { sha: "abc", target: "main", sarif } });
    const finding = { rule: "sqli", file: "db.go", line: 7, severity: "critical", fingerprint: "sha256:x" };
    expect((await call(`/api/work/jobs/${claim.job.id}/report`, { status: "done", findings: [finding] }, runner)).status).toBe(200);
    const row = await env.DB.prepare("SELECT f.* FROM findings f JOIN repos r ON r.id = f.repo_id WHERE r.name = 'sarif-ok'").first();
    expect(row).toMatchObject({ source: "code", severity: "critical", rule: "sqli", path: "db.go", target: "main", first_sha: "abc", state: "open" });
  });

  it("rejects a SARIF upload from a runner holding no job of that repo", async () => {
    for (const name of ["sarif-mine", "sarif-other"]) expect((await call("/api/repos", { name })).status).toBe(201);
    const runner = (await (await call("/api/runners", { name: "ci", kinds: ["ingest-sarif"] })).json()).token;
    expect((await call("/api/repos/sarif-mine/sarif?sha=abc", sarif)).status).toBe(202);
    expect((await call("/api/work/claim", { kinds: ["ingest-sarif"] }, runner)).status).toBe(200);
    const res = await call("/api/repos/sarif-other/sarif?sha=abc", sarif, runner);
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'ingest-sarif' AND repo_id = (SELECT id FROM repos WHERE name = 'sarif-other')").first("n")).toBe(0);
  });

  it("an upload over 1 MiB returns 413", async () => {
    expect((await call("/api/repos", { name: "sarif-big" })).status).toBe(201);
    const big = JSON.stringify({ version: "2.1.0", runs: [], pad: "x".repeat(1 << 20) });
    const res = await call("/api/repos/sarif-big/sarif?sha=abc", big);
    expect(res.status).toBe(413);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'ingest-sarif' AND repo_id = (SELECT id FROM repos WHERE name = 'sarif-big')").first("n")).toBe(0);
  });

  it("a SARIF result's startLine is stored as the finding's line", async () => {
    expect((await call("/api/repos", { name: "sarif-line" })).status).toBe(201);
    const runner = (await (await call("/api/runners", { name: "ci", kinds: ["ingest-sarif"] })).json()).token;
    expect((await call("/api/repos/sarif-line/sarif?sha=abc", sarif)).status).toBe(202);
    const claim = await (await call("/api/work/claim", { kinds: ["ingest-sarif"], slots_free: 1 }, runner)).json();
    const finding = { rule: "sqli", file: "db.go", line: 4, severity: "high", fingerprint: "sha256:line" };
    expect((await call(`/api/work/jobs/${claim.job.id}/report`, { status: "done", findings: [finding] }, runner)).status).toBe(200);
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/sarif-line/watchtower", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), { ...env, ARTIFACTS: fake });
    expect((await res.json()).findings).toMatchObject([{ rule: "sqli", path: "db.go", line: 4 }]);
  });
});
