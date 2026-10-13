// The web Judges and calibration page, rendered against this worker with seeded data instead of fixtures.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REPOS, client, seed } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import { KIND_QUESTIONS } from "../src/api/contract.js";
import { validateJudges } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { recordJudgment, recordOutcome } from "../src/judgments.js";
import { seedArtifacts } from "./fakes/seed.js";

const fake = seedArtifacts();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });

// prerender waits for the deferred judges data.
async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
  return (await new Response((await prerender(el)).prelude).text()).replace(/<!-- -->| data-discover="true"/g, "");
}

beforeAll(async () => {
  env.ARTIFACTS = fake;
  await seed(client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real }), undefined, ["judges"]);
  // The seed records no judgments, so give one series a scored judgment.
  const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(REPOS.trunk).first()).id;
  const id = await recordJudgment(env.DB, { repo, kind: "risk", backend: "clef", model: "clef@2", state_hash: "s1", question: "q", answer: "yes", p: 0.3 });
  await recordOutcome(env.DB, id, "no", new Date().toISOString());
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("judges and calibration (live)", () => {
  it("page renders from a real local worker with seeded data", async () => {
    const html = await render("/automation/judges?kind=risk");
    expect(html).not.toContain("Couldn&#x27;t load judges");
    expect(html).toContain(`<a class="mono" href="/automation/judges/risk%3Aclef%40clef%402">clef@clef@2</a>`);
  });

  it("after seeding, the page's API calls list the judge with a real judgment and the configured ones at count 0", async () => {
    const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
    const bodies = await Promise.all((await api("GET", "/api/repos")).map((r) => api("GET", `/api/repos/${r.name}/judges`)));
    for (const b of bodies) expect(validateJudges(b).errors).toEqual([]);
    const judges = bodies.flatMap((b) => b.judges);
    expect(judges.filter((j) => j.count).map((j) => [j.backend, j.model_version, j.count, j.trusted])).toEqual([["clef", "clef@2", 1, false]]);
    // One tab per kind with a judge.
    expect((await render("/automation/judges")).match(/role="tab"/g)).toHaveLength(new Set(judges.map((j) => j.kind)).size);
  });

  it("an API error shows the error state, not a blank page", async () => {
    const path = `/api/repos/${REPOS.trunk}/judges`;
    vi.stubGlobal("fetch", (url, init) => (url === path ? new Response("", { status: 503 }) : real(url, init)));
    const html = await render("/automation/judges");
    expect(html).toContain(`<div class="err" role="alert"><span class="dot bad"></span><span>Couldn&#x27;t load judges: ${path}: HTTP 503</span>`);
  });
});

describe("judges API (live)", () => {
  const name = "judges-v7";
  const get = async (q = "") => (await (await real(`/api/repos/${name}/judges${q}`)).json());
  const risk = (body) => body.judges.find((j) => j.kind === "risk" && j.backend === "stat");

  // The repo's risk judge ran stat-0, then swapped to stat-1; bea reviews risk too. None of these judgments has a change.
  beforeAll(async () => {
    await real("/api/repos", { method: "POST", body: JSON.stringify({ name }) });
    const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
    await env.DB.prepare("UPDATE judge_config SET backend = 'stat', model_version = 'stat-1' WHERE repo_id = ? AND kind = 'risk'").bind(repo).run();
    const scored = async (backend, model, p) => {
      const id = await recordJudgment(env.DB, { repo, kind: "risk", backend, model, state_hash: "s", question: "q", answer: "yes", p });
      await recordOutcome(env.DB, id, "yes", new Date().toISOString());
    };
    await scored("stat", "stat-0", 0.4);
    await scored("stat", "stat-1", 0.8);
    await scored("human:bea", "human", 0.6);
    await recordJudgment(env.DB, { repo, kind: "risk", backend: "stat", model: "stat-1", state_hash: "s", question: "q", answer: "yes", p: 0.5 });
  });

  it("question is on a configured judge and on a reviewer", async () => {
    const body = await get();
    expect(validateJudges(body).errors).toEqual([]);
    expect(risk(body).question).toBe(KIND_QUESTIONS.risk);
    expect(body.judges.find((j) => j.backend === "human:bea").question).toBe(KIND_QUESTIONS.risk);
  });

  it("?weeks=4 gives 4 trend points and ?weeks=99 gives 52", async () => {
    const four = risk(await get("?weeks=4"));
    expect(four.trend).toHaveLength(4);
    expect(four.trend.at(-1)).toEqual({ week: four.trend.at(-1).week, count: 1, brier: expect.closeTo(0.04, 10) });
    expect(risk(await get("?weeks=99")).trend).toHaveLength(52);
    expect(risk(await get()).trend).toHaveLength(12);
  });

  it("after a swap, history[0].bins is kept and since/until are ordered", async () => {
    const j = risk(await get());
    expect(j.history.map((h) => h.model_version)).toEqual(["stat-0"]);
    expect(j.history[0].bins.length).toBeGreaterThan(0);
    expect(j.history[0].trend).toHaveLength(12);
    expect(j.history[0].since <= j.history[0].until).toBe(true);
    expect(j.history[0].until <= j.since).toBe(true);
  });

  it("an inherited judgment counts in inherited", async () => {
    const j = risk(await get());
    // Two stat-1 judgments have no change; only the scored one is an outcome.
    expect(j.inherited).toBe(1);
  });

  it("recent[0].made_at is present", async () => {
    const j = risk(await get());
    expect(Date.parse(j.recent[0].made_at)).not.toBeNaN();
  });
});
