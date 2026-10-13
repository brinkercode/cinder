// The web Changes board, rendered against this worker with seeded data instead of fixtures.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REPOS, client, seed } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { markReady, runFor } from "./helpers/pool.js";
import { seedArtifacts } from "./fakes/seed.js";

const fake = seedArtifacts();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });

// Wait for the real worker to answer, then the first render starts tracking the cards promise and the second shows it.
async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  await Promise.allSettled(Object.values(context.loaderData).map((d) => d?.data));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context });
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el).replace(/<!-- -->| data-discover="true"/g, "");
}

beforeAll(async () => {
  // The RepoDO reads .cinder.yml through its own env (see seed.test.js).
  env.ARTIFACTS = fake;
  const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
  await seed(api, undefined, ["changes"]);
  await markReady(api, Object.values(REPOS));
  await real("/api/repos", { method: "POST", body: JSON.stringify({ name: "manual-empty-1" }) });
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("changes board (live)", () => {
  it("Dummy data: the seed fills the board's cards and empty columns, and leaves a repo with no changes", async () => {
    const html = await render(`/${REPOS.trunk}/changes`);
    const cols = [...html.matchAll(/<section class="col" aria-label="([^"]+)">.*?<span class="n">(\d+)/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(cols).toEqual(["Intents:0", "In progress:0", "Verifying:11", "Needs review:0", "Merge queue:0", "Merged · 24h:0"]);
    expect(html).toMatch(/<h4 title="Paginate GET \/orders with limit and after">Paginate GET \/orders with limit and after<\/h4>.*Nothing here/);
    expect(await render("/manual-empty-1/changes")).toContain("<h3>No changes yet</h3>");
    expect(html).not.toContain("Drop the unused /v0/orders route");
  });

  it("after seeding, the page's API calls return the filed changes on every target branch", async () => {
    const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
    await seed(api, undefined, ["gitflow"]);
    await markReady(api, [REPOS.gitflow]);
    const changes = (await Promise.all([REPOS.trunk, REPOS.gitflow].map((r) => api("GET", `/api/repos/${r}/changes`)))).flat();
    expect(new Set(changes.map((c) => c.state))).toEqual(new Set(["leased", "closed"]));
    expect(new Set(changes.map((c) => c.target_branch))).toEqual(new Set(["main", "develop", "release/1.2"]));
  });

  it("a failed change's Verifying card names the step it failed at and its reason", async () => {
    const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
    const { id } = (await api("GET", `/api/repos/${REPOS.gitflow}/changes`)).find((c) => c.intent === "Add Apple Pay to the checkout form");
    await runFor(api, "develop", id, { status: "failed", blockers: [{ summary: "Apple Pay button never renders in Safari 17", repro: "npm test -- applepay.button" }] });
    expect((await render(`/${REPOS.gitflow}/changes`)).match(/aria-label="Verifying">.*?<\/section>/)[0])
      .toContain("Failed at develop: Apple Pay button never renders in Safari 17 (repro: npm test -- applepay.button)");
  });

  it("an API error shows the error state, not a blank page", async () => {
    const path = `/api/repos/${REPOS.trunk}/work`;
    vi.stubGlobal("fetch", (url, init) => (url === path ? new Response("", { status: 503 }) : real(url, init)));
    const html = await render(`/${REPOS.trunk}/changes`);
    expect(html).not.toContain("<h1>");
    expect(html).toContain(`<span>Couldn&#x27;t load changes: GET ${path}: HTTP 503</span><button`);
  });
});
