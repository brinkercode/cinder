// The web Insights page, rendered against this worker with seeded data instead of fixtures.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REPOS, client, seed } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { markReady } from "./helpers/pool.js";
import { seedArtifacts } from "./fakes/seed.js";

const fake = seedArtifacts();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });
const PATH = `/${REPOS.trunk}/insights`;

// prerender waits for the deferred insights data.
async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
  return (await new Response((await prerender(el)).prelude).text()).replace(/<!-- -->| data-discover="true"/g, "");
}

beforeAll(async () => {
  env.ARTIFACTS = fake;
  const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
  await seed(api, undefined, ["changes", "insights"]);
  // A person marks the seed's drafts ready, so the changes take their leases.
  await markReady(api, Object.values(REPOS));
  await real("/api/repos", { method: "POST", body: JSON.stringify({ name: "manual-empty-1" }) });
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("insights (live)", () => {
  const insights = async (repo, hours) => (await real(`/api/repos/${repo}/insights?from=${new Date(Date.now() - hours * 3600000).toISOString()}`,
    { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } })).json();
  it("seed: the insights section adds no usage, outcomes or merges; those come only from real runs", async () => {
    const [trunk, gitflow, idle] = await Promise.all([[REPOS.trunk, 720], [REPOS.gitflow, 720], ["manual-empty-1", 24]].map(([r, h]) => insights(r, h)));
    expect(trunk.series.some((b) => b.merged > 0)).toBe(false);
    for (const d of [trunk, gitflow, idle]) expect([d.usage.tokens, d.usage.by_agent, d.calibration.count]).toEqual([0, [], 0]);
    expect(idle.series.some((b) => b.merged || b.passed || b.failed || b.tokens)).toBe(false);
  });

  it("the usage lens shows its empty state without gateway usage", async () => {
    const html = await render(`${PATH}?lens=usage`);
    expect(html).toContain("No usage in this range");
    expect(html).not.toContain("outside cinder</span></td>");
  });

  it("an API error shows the error state, not a blank page", async () => {
    const path = `/api/repos/${REPOS.trunk}/insights`;
    vi.stubGlobal("fetch", async (url, init) => (url.startsWith(path) ? new Response("", { status: 503 }) : real(url, init)));
    const html = await render(PATH);
    expect(html).not.toContain("<h1>");
    expect(html).toContain('<div class="state error"><h2>Couldn&#x27;t load insights</h2>');
    expect(html).toMatch(new RegExp(`<pre>GET ${path}\\?from=[^<]+: HTTP 503</pre>`));
  });
});
