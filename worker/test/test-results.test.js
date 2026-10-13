import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { SHA, verifyRepo } from "./helpers/verify.js";

it("a verify report's tests are stored as one run with its results", async () => {
  const { repo, change, verify } = await verifyRepo("test-results-store");
  const { job, res } = await verify({ status: "failed", tests: [{ test: "t1", status: "pass", duration: 1.5 }, { test: "t2", status: "fail", duration: 0 }] });
  expect(res.status).toBe(200);
  const { results: run } = await env.DB.prepare("SELECT job, change_id, sha, attempt FROM verify_runs WHERE repo = ?").bind(repo).all();
  expect(run).toEqual([{ job: job.id, change_id: change.id, sha: SHA, attempt: 1 }]);
  const { results } = await env.DB.prepare("SELECT sha, test, attempt, status, duration FROM test_results WHERE repo = ? ORDER BY test").bind(repo).all();
  expect(results).toEqual([
    { sha: SHA, test: "t1", attempt: 1, status: "pass", duration: 1.5 },
    { sha: SHA, test: "t2", attempt: 1, status: "fail", duration: 0 },
  ]);
  const { results: runs } = await env.DB.prepare("SELECT sha, test, status FROM test_runs WHERE repo = ? ORDER BY test").bind(repo).all();
  expect(runs).toEqual([{ sha: SHA, test: "t1", status: "pass" }, { sha: SHA, test: "t2", status: "fail" }]);
});

it("a malformed tests list answers 400 and stores nothing", async () => {
  const { repo, verify } = await verifyRepo("test-results-malformed");
  const many = Array.from({ length: 5001 }, (_, i) => ({ test: `t${i}`, status: "pass", duration: 0 }));
  for (const tests of [{}, [{ test: "t1", status: "flaky", duration: 0 }], [{ test: "", status: "pass", duration: 0 }],
    [{ test: "t1", status: "pass", duration: -1 }], [{ test: "t1", status: "pass", duration: 0 }, { test: "t1", status: "fail", duration: 0 }], many]) {
    const { job, res } = await verify({ status: "done", tests });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(job.id).first("status")).toBe("claimed");
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM test_results WHERE repo = ?").bind(repo).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM verify_runs WHERE repo = ?").bind(repo).first("n")).toBe(0);
});
