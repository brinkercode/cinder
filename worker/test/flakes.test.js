import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { classifyFailure } from "../src/flakes.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";
import { verifyRepo } from "./helpers/verify.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

async function repoWithFlakeJudge(name, calls) {
  await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }),
    { ...env, ARTIFACTS: fakeArtifacts() });
  const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
  await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'flake', 'clef', 'clef@1')").bind(repo).run();
  const AI = fakeClefAI(async (model, body) => (calls.push(body), { failure: { infra: 0.1, flaky: 0.8, code: 0.1 } }));
  return { repo, env: { ...env, AI } };
}

describe("failure classification", () => {
  it("failure that also fails on target → infra without calling System 1", async () => {
    const calls = [];
    const { repo, env: e } = await repoWithFlakeJudge("classify-target", calls);
    expect(await classifyFailure(e, repo, { test: "t1", attempt: 1, fails_on_target: true }))
      .toEqual({ kind: "infra", action: "requeue" });
    expect(calls).toEqual([]);
  });

  it("flaky reruns once only", async () => {
    const calls = [];
    const { repo, env: e } = await repoWithFlakeJudge("classify-flaky", calls);
    const failure = { test: "t1", quarantined: true };
    expect(await classifyFailure(e, repo, { ...failure, attempt: 1 })).toEqual({ kind: "flaky", action: "rerun" });
    expect(await classifyFailure(e, repo, { ...failure, attempt: 2 })).toEqual({ kind: "flaky", action: "needs_fix" });
    expect(calls).toEqual([]);
  });
});

it("a test that passed and failed on the same sha reports a flake rate", async () => {
  const { call, verify } = await verifyRepo("flakes-from-reports");
  expect((await verify({ status: "failed", tests: [{ test: "t1", status: "fail", duration: 1 }, { test: "t2", status: "pass", duration: 1 }] })).res.status).toBe(200);
  expect((await verify({ status: "failed", tests: [{ test: "t1", status: "pass", duration: 1 }, { test: "t2", status: "pass", duration: 1 }] })).res.status).toBe(200);
  const res = await call("/api/repos/flakes-from-reports/flakes");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([
    { test: "t1", runs: 1, flakes: 1, rate: 1, quarantined: false, quarantined_since: null, quarantined_by: null },
    { test: "t2", runs: 1, flakes: 0, rate: 0, quarantined: false, quarantined_since: null, quarantined_by: null },
  ]);
});

it("quarantined follows test_quarantine at the threshold", async () => {
  const { call, repo, verify } = await verifyRepo("flakes-at-threshold");
  await env.DB.prepare("INSERT INTO repo_settings (repo, flake_quarantine) VALUES (?, 1)").bind(repo).run();
  const t1 = async () => (await (await call("/api/repos/flakes-at-threshold/flakes")).json()).find((f) => f.test === "t1");
  await verify({ status: "failed", tests: [{ test: "t1", status: "fail", duration: 1 }] });
  await verify({ status: "failed", tests: [{ test: "t1", status: "pass", duration: 1 }] });
  expect(await t1()).toMatchObject({ rate: 1, quarantined: false, quarantined_since: null });
  // Rate 1 equals the threshold 1, so this failure quarantines t1.
  await verify({ status: "failed", tests: [{ test: "t1", status: "fail", duration: 1 }] });
  const got = await t1();
  expect(got).toMatchObject({ rate: 1, quarantined: true, quarantined_by: "verifier" });
  expect(got.quarantined_since).not.toBeNull();
});
