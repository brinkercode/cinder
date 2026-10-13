import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { validateChangeCheck, validateFlake, validateNeed } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { SHA, verifyRepo } from "./helpers/verify.js";

const run = (tests) => ({ status: "failed", tests: tests.map(([test, status]) => ({ test, status, duration: 1 })) });

// A repo where t1 failed then passed on the head sha, so its flake rate (1) is over the default threshold.
async function flakyRepo(name) {
  const repo = await verifyRepo(name);
  await repo.verify(run([["t1", "fail"], ["t2", "pass"]]));
  await repo.verify(run([["t1", "pass"], ["t2", "pass"]]));
  return repo;
}

it("a test over the threshold is quarantined and its failure no longer fails verify", async () => {
  const { call, change, verify } = await flakyRepo("quarantine-pass");
  const { res } = await verify(run([["t1", "fail"], ["t2", "pass"]]));
  expect((await res.json()).job.status).toBe("done");
  const list = await (await call("/api/repos/quarantine-pass/quarantine")).json();
  expect(list).toEqual([{ test: "t1", flake_rate: 1, since: expect.any(String) }]);
  const checks = await (await call(`/api/changes/${change.id}/checks`)).json();
  const marked = checks.filter((c) => c.kind === "test");
  expect(marked).toEqual([{ kind: "test", name: "t1", status: "quarantined", flake_rate: 1, since: list[0].since, sha: SHA, duration_ms: null, log_url: null }]);
  expect(validateChangeCheck(marked[0]).errors).toEqual([]);
});

it("a real failure in a quarantined run still fails verify", async () => {
  const { call, verify } = await flakyRepo("quarantine-real");
  const { res } = await verify(run([["t1", "fail"], ["t2", "fail"]]));
  expect((await res.json()).job.status).toBe("failed");
  expect((await (await call("/api/repos/quarantine-real/quarantine")).json()).map((q) => q.test)).toEqual(["t1"]);
});

it("releasing a test puts its failures back in the verdict", async () => {
  const { call, verify } = await flakyRepo("quarantine-release");
  // t2's real failure keeps the change in needs_fix; t1 is quarantined all the same.
  await verify(run([["t1", "fail"], ["t2", "fail"]]));
  const del = await worker.fetch(new Request("http://cinder.test/api/repos/quarantine-release/quarantine/t1",
    { method: "DELETE", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), { ...env, ARTIFACTS: fakeArtifacts() });
  expect(del.status).toBe(204);
  expect(await (await call("/api/repos/quarantine-release/quarantine")).json()).toEqual([]);
  expect((await (await verify(run([["t1", "fail"], ["t2", "pass"]]))).res.json()).job.status).toBe("failed");
});

it("quarantining raises one Test quarantined need with Release and Keep", async () => {
  const { call, verify } = await flakyRepo("quarantine-need");
  await verify(run([["t1", "fail"], ["t2", "fail"]]));
  await verify(run([["t1", "fail"], ["t2", "fail"]]));
  const needs = (await (await call("/api/needs")).json()).filter((n) => n.repo === "quarantine-need" && n.kind === "Test quarantined");
  expect(needs).toHaveLength(1);
  expect(needs[0].actions).toEqual(["Release", "Keep"]);
  expect(validateNeed(needs[0])).toEqual({ ok: true, errors: [] });
  const res = await call(`/api/needs/${needs[0].id}/resolve`, { action: "Release" });
  expect(res.status).toBe(200);
  expect(await (await call("/api/repos/quarantine-need/quarantine")).json()).toEqual([]);
});

it("quarantined tests never affect the verdict, with auto-quarantine off too", async () => {
  const { call, verify } = await flakyRepo("quarantine-verdict");
  await verify(run([["t1", "fail"], ["t2", "fail"]]));
  // Off stops new quarantines (t2 now flakes too) but leaves t1 held: its failures still pass verify.
  await verify(run([["t1", "pass"], ["t2", "pass"]]));
  expect((await (await call("/api/repos/quarantine-verdict/settings")).json()).auto_quarantine).toBe(true);
  const off = await worker.fetch(new Request("http://cinder.test/api/repos/quarantine-verdict/settings",
    { method: "PUT", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ auto_quarantine: false }) }), { ...env, ARTIFACTS: fakeArtifacts() });
  expect(off.status).toBe(204);
  expect((await (await call("/api/repos/quarantine-verdict/settings")).json()).auto_quarantine).toBe(false);
  expect((await (await verify(run([["t1", "fail"], ["t2", "fail"]]))).res.json()).job.status).toBe("failed");
  expect((await (await verify(run([["t1", "fail"], ["t2", "pass"]]))).res.json()).job.status).toBe("done");
  const flakes = await (await call(`/api/repos/quarantine-verdict/flakes?sha=${SHA}`)).json();
  expect(flakes.map((f) => [f.test, f.quarantined_by, f.result])).toEqual([["t1", "verifier", "fail"], ["t2", null, "pass"]]);
  expect(flakes[0].quarantined_since).toEqual(expect.any(String));
  expect(flakes.flatMap((f) => validateFlake(f).errors)).toEqual([]);
});

it("a released test counts from the next run", async () => {
  const { call, verify } = await flakyRepo("quarantine-next-run");
  // t2's real failure keeps the change in needs_fix, so the next verify can run.
  await verify(run([["t1", "fail"], ["t2", "fail"]]));
  const res = await call(`/api/repos/quarantine-next-run/flakes/${encodeURIComponent("t1")}/release`, {});
  expect(res.status).toBe(204);
  const [t1] = await (await call("/api/repos/quarantine-next-run/flakes")).json();
  expect([t1.quarantined_since, t1.quarantined_by]).toEqual([null, null]);
  expect((await (await verify(run([["t1", "fail"], ["t2", "pass"]]))).res.json()).job.status).toBe("failed");
  expect((await call("/api/repos/quarantine-next-run/flakes/t1/release", {})).status).toBe(404);
});
