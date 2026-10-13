import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { queueScan } from "../src/scans.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A repo whose main is at s1, and a runner that claims scan jobs.
async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  await call("/api/repos", { name });
  fake.repos.get(name).commits.unshift({ sha: "s1" });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  const token = (await (await call("/api/runners", { name: `${name}-lab`, kinds: ["scan"] })).json()).token;
  // Only this test's scans may be claimed.
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'scan' AND status = 'queued'").run();
  const claim = async () => (await call("/api/work/claim", { kinds: ["scan"] }, token)).json();
  return { call, repo, token, claim };
}

describe("target branch scans", () => {
  it("a secret already on main produces an open finding", async () => {
    const { call, repo, token, claim } = await setup("scan-secret");
    await queueScan(env, repo.id, "main", "merge");
    const { job, payload, read_token: read, target_remote: remote } = await claim();
    expect({ kind: job.kind, sha: payload.sha, read: Boolean(read), remote: Boolean(remote) }).toEqual({ kind: "scan", sha: "s1", read: true, remote: true });
    const secret = { rule: "aws_access_key_id", path: "config.js", line: 1, masked: "AKIA************MNOP", fingerprint: "fp-aws" };
    expect((await call(`/api/work/jobs/${job.id}/report`, { status: "done", secrets: [secret] }, token)).status).toBe(200);
    expect(await env.DB.prepare("SELECT source, path, state, first_sha FROM findings WHERE repo_id = ?").bind(repo.id).first())
      .toEqual({ source: "secret", path: "config.js", state: "open", first_sha: "s1" });
    expect(await env.DB.prepare("SELECT source, sha, status, counts FROM scans WHERE job_id = ?").bind(job.id).first())
      .toEqual({ source: "merge", sha: "s1", status: "done", counts: JSON.stringify({ secret: 1, dependency: 0, code: 0 }) });
  });

  it("a timed-out scan is marked failed and the next scan runs", async () => {
    const { repo, claim } = await setup("scan-timeout");
    await queueScan(env, repo.id, "main", "merge");
    const crashed = (await claim()).job;
    await env.DB.prepare("UPDATE jobs SET lease_expires_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(crashed.id).run();
    await queueScan(env, repo.id, "main", "daily");
    const next = await claim();
    expect(next.job.id).not.toBe(crashed.id);
    expect(next.payload.source).toBe("daily");
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(crashed.id).first("status")).toBe("failed");
    expect(await env.DB.prepare("SELECT status FROM scans WHERE job_id = ?").bind(crashed.id).first("status")).toBe("failed");
  });
});
