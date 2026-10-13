import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { validateEgress } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

it("the 7d window aggregates across jobs and versions", async () => {
  const name = "egress-7d";
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  await env.DB.batch(["v3", "v4"].map((v) => env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
    "VALUES (?, 'egress-dev', ?, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{}')").bind(`agent/egress-dev/${v}`, Number(v.slice(1)))));
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
  const reports = [
    ["egress-dev@v3", { "api.github.com": 2 }, { "evil.example": 1 }],
    ["egress-dev@v3", { "api.github.com": 3, "pypi.org": 1 }, {}],
    ["egress-dev@v4", { "api.github.com": 1 }, { "evil.example": 4 }],
    ["egress-dev@v4", { "old.example": 9 }, {}], // reported 8 days ago, outside the window
  ];
  const ids = [];
  for (const [agent, allowed, denied] of reports) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
    await env.DB.prepare("UPDATE jobs SET payload = ? WHERE change_id = ? AND kind = 'develop'").bind(JSON.stringify({ agent }), change.id).run();
    const claim = await (await call("/api/work/claim", { kinds: ["develop"], slots_free: 1 }, runner)).json();
    expect(claim.job.change_id).toBe(change.id);
    expect((await call(`/api/work/jobs/${claim.job.id}/report`, { status: "done", egress: { allowed, denied } }, runner)).status).toBe(200);
    ids.push(claim.job.id);
  }
  await env.DB.prepare("UPDATE job_egress_verdicts SET at = ? WHERE job_id = ?").bind(new Date(Date.now() - 8 * 86400000).toISOString(), ids[3]).run();

  const res = await call(`/api/repos/${name}/egress?window=7d`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(validateEgress(body)).toEqual({ ok: true, errors: [] });
  expect(body).toEqual({ window: "7d", jobs: expect.any(Array), versions: [
    { agent: "egress-dev@v3", counts: { allowed: 6, denied: 1, would_deny: 0 },
      allowed: [{ host: "api.github.com", count: 5 }, { host: "pypi.org", count: 1 }], denied: [{ host: "evil.example", count: 1 }], would_deny: [] },
    { agent: "egress-dev@v4", counts: { allowed: 1, denied: 4, would_deny: 0 },
      allowed: [{ host: "api.github.com", count: 1 }], denied: [{ host: "evil.example", count: 4 }], would_deny: [] },
  ] });
  expect((await (await call(`/api/repos/${name}/egress?window=30d`)).json()).versions[1].allowed).toContainEqual({ host: "old.example", count: 9 });
  expect((await call(`/api/repos/${name}/egress?window=1y`)).status).toBe(400);
});

// Releases agent egress-audit@v1 with egress_mode audit through the push queue, as the release job's tag push does, and
// runs one develop job as it that reports egress; returns the job's id and the claim.
async function auditJob(name, egress) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  const lock = { name: "egress-audit", version: 1, harness: "claude-code", model: "claude-opus-5-5", effort: "high", prompt_hash: "sha256:abc",
    tools: ["bash"], limits: { max_cost_usd: 8, max_minutes: 120 }, egress: ["api.github.com"], egress_mode: "audit" };
  await env.DB.prepare("INSERT OR IGNORE INTO ref_writes (repo, ref, sha) VALUES ('cinder-agents', ?, ?)").bind("refs/tags/agent/egress-audit/v1", "d".repeat(40)).run();
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "cinder-agents" },
    payload: { ref: "refs/tags/agent/egress-audit/v1", before: "0".repeat(40), after: "d".repeat(40), commits: [{ id: "e".repeat(40), message: JSON.stringify(lock) }] } } }] }, env);
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  await env.DB.prepare("UPDATE jobs SET payload = ? WHERE change_id = ? AND kind = 'develop'").bind(JSON.stringify({ agent: "egress-audit@v1" }), change.id).run();
  const claim = await (await call("/api/work/claim", { kinds: ["develop"], slots_free: 1 }, runner)).json();
  expect(claim.job.change_id).toBe(change.id);
  expect((await call(`/api/work/jobs/${claim.job.id}/report`, { status: "done", egress }, runner)).status).toBe(200);
  return { claim, get: async () => (await call(`/api/repos/${name}/egress?window=24h`)).json() };
}

it("an audit-mode job's off-list host is stored and returned as would_deny", async () => {
  const { claim, get } = await auditJob("egress-audit-store", { allowed: { "api.github.com": 2 }, denied: {}, would_deny: { "evil.example": 3 } });
  // The runner's proxy lets off-list hosts through only when the claim says audit (runner TestRun_DevelopClaim_AuditMode_ReportsOffListHostAsWouldDeny).
  expect(claim.agent.egress_mode).toBe("audit");
  const { results } = await env.DB.prepare("SELECT host, verdict, count FROM job_egress_verdicts WHERE job_id = ? ORDER BY host").bind(claim.job.id).all();
  expect(results).toEqual([{ host: "api.github.com", verdict: "allowed", count: 2 }, { host: "evil.example", verdict: "would_deny", count: 3 }]);
  const body = await get();
  expect(body.versions).toContainEqual(expect.objectContaining({ agent: "egress-audit@v1", would_deny: [{ host: "evil.example", count: 3 }], denied: [] }));
});

it("the egress API returns would_deny hosts and per-verdict counts", async () => {
  const { claim, get } = await auditJob("egress-audit-counts",
    { allowed: { "api.github.com": 2, "pypi.org": 1 }, denied: { "blocked.example": 1 }, would_deny: { "evil.example": 3, "odd.example": 4 } });
  const body = await get();
  expect(validateEgress(body)).toEqual({ ok: true, errors: [] });
  const counts = { allowed: 3, denied: 1, would_deny: 7 };
  expect(body.versions).toEqual([{ agent: "egress-audit@v1", counts,
    allowed: [{ host: "api.github.com", count: 2 }, { host: "pypi.org", count: 1 }], denied: [{ host: "blocked.example", count: 1 }],
    would_deny: [{ host: "odd.example", count: 4 }, { host: "evil.example", count: 3 }] }]);
  expect(body.jobs).toEqual([{ job_id: claim.job.id, agent: "egress-audit@v1", counts }]);
});
