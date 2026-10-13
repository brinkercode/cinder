import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { validateJudge, validateJudges } from "../src/api/contract.js";
import { brierByWeek, calibrate } from "../src/calibration.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, init = {}) =>
  worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: OWNER }), { ...env, ARTIFACTS: fakeArtifacts() });

// Records one judgment per p with answer "yes"; the outcome is "yes" (correct) when correct(i) is true.
// minOutcomes, when given, is stored as the repo's trust.min_outcomes setting.
async function judge(name, ps, correct, minOutcomes) {
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) });
  const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
  if (minOutcomes) await env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, ?)").bind(repo, minOutcomes).run();
  // Only configured judges are listed: the repo's risk judge runs the stat-1 series these judgments belong to.
  await env.DB.prepare("UPDATE judge_config SET backend = 'stat', model_version = 'stat-1' WHERE repo_id = ? AND kind = 'risk'").bind(repo).run();
  // One batch keeps the 30-outcome case fast on a loaded machine.
  await env.DB.batch(ps.flatMap((p, i) => [
    env.DB.prepare("INSERT INTO judgments (id, repo_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, 'risk', 'stat', 'stat-1', 'sha256:01', 'q', 'yes', ?, '2026-10-04T09:00:00.000Z')")
      .bind(`${name}-${i}`, repo, p),
    env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) VALUES (?, 'yes', ?, '2026-10-04T10:00:00.000Z')")
      .bind(`${name}-${i}`, correct(i) ? 1 : 0),
  ]));
  const res = await call(`/api/repos/${name}/judges`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(validateJudges(body)).toEqual({ ok: true, errors: [] });
  expect(body.trust).toEqual({ min_outcomes: minOutcomes ?? 200, min_races: 30 });
  const list = body.judges;
  for (const j of list) expect(validateJudge(j)).toEqual({ ok: true, errors: [] });
  return list.filter((j) => j.kind === "risk");
}

describe("calibration", () => {
  it("PAV on a known sequence gives the textbook result", () => {
    const xs = [1, 2, 3, 4, 5, 6];
    const { calibrated } = calibrate([1, 3, 2, 4, 3, 5].map((y, i) => ({ p: xs[i], y })));
    expect(xs.map(calibrated)).toEqual([1, 2.5, 2.5, 3.5, 3.5, 5]);
    const ties = calibrate([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.2, y: 0 }]);
    expect([0.1, 0.2, 0.5, 0.9].map(ties.calibrated)).toEqual([0, 0, 0.5, 0.5]);
    expect(calibrate([]).calibrated(0.7)).toBe(0.7);
  });

  it("a judge with 199 outcomes is untrusted under the default", async () => {
    const ps = Array.from({ length: 199 }, (_, i) => (i % 10) / 10);
    const [few] = await judge("cal-few", ps, (i) => i % 2 === 0);
    expect(few).toMatchObject({ kind: "risk", backend: "stat", model_version: "stat-1", count: 199, trusted: false });
    expect(few.bins.reduce((s, b) => s + b.count, 0)).toBe(199);
    const [enough] = await judge("cal-enough", [...ps, 0.5], (i) => i % 2 === 0);
    expect(enough).toMatchObject({ count: 200, trusted: true });
    expect((await call("/api/repos/missing/judges")).status).toBe(404);
  });

  it("a repo setting of 30 makes 30 outcomes trusted", async () => {
    const ps = Array.from({ length: 30 }, (_, i) => (i % 10) / 10);
    const [few] = await judge("cal-set-few", ps.slice(1), (i) => i % 2 === 0, 30);
    expect(few).toMatchObject({ count: 29, trusted: false });
    const [enough] = await judge("cal-set-enough", ps, (i) => i % 2 === 0, 30);
    expect(enough).toMatchObject({ count: 30, trusted: true });
  });

  it("Brier score of a perfect judge is 0", async () => {
    const [perfect] = await judge("cal-perfect", [1, 0, 1, 0], (i) => i % 2 === 0);
    expect(perfect.brier).toBe(0);
    expect(perfect.bins).toEqual([
      { lo: 0, hi: 0.1, count: 2, mean_p: 0, observed: 0 },
      { lo: 0.9, hi: 1, count: 2, mean_p: 1, observed: 1 },
    ]);
  });
});

describe("brierByWeek", () => {
  // Wednesday 2026-10-14; its week starts Monday 2026-10-12.
  const now = Date.parse("2026-10-14T12:00:00Z");

  it("brierByWeek returns weeks entries, oldest first, on Mondays UTC", () => {
    const trend = brierByWeek([], 4, now);
    expect(trend.map((w) => w.week)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
  });

  it("brierByWeek fills the gaps with null", () => {
    const trend = brierByWeek([{ p: 0.5, y: 1, observed_at: "2026-09-22T00:00:00Z" }], 4, now);
    expect(trend.map((w) => [w.count, w.brier])).toEqual([[1, 0.25], [0, null], [0, null], [0, null]]);
  });

  it("brierByWeek buckets Sunday 23:59Z versus Monday 00:00Z correctly", () => {
    const trend = brierByWeek([
      { p: 1, y: 1, observed_at: "2026-10-11T23:59:59Z" },
      { p: 0, y: 1, observed_at: "2026-10-12T00:00:00Z" },
    ], 2, now);
    expect(trend).toEqual([{ week: "2026-10-05", count: 1, brier: 0 }, { week: "2026-10-12", count: 1, brier: 1 }]);
  });

  it("brierByWeek matches a hand-computed Brier and drops outcomes outside the window", () => {
    const trend = brierByWeek([
      { p: 0.9, y: 1, observed_at: "2026-10-12T08:00:00Z" },
      { p: 0.3, y: 0, observed_at: "2026-10-13T08:00:00Z" },
      { p: 0.6, y: 0, observed_at: "2026-10-14T08:00:00Z" },
      { p: 0.6, y: 0, observed_at: "2026-09-01T08:00:00Z" },
    ], 1, now);
    // (0.01 + 0.09 + 0.36) / 3
    expect(trend).toHaveLength(1);
    expect(trend[0].count).toBe(3);
    expect(trend[0].brier).toBeCloseTo(0.46 / 3, 10);
  });
});
