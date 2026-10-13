// The web Repo settings page, rendered against this worker with seeded data instead of fixtures.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REPOS, client, seed } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { seedArtifacts } from "./fakes/seed.js";
import { indexFor, markReady } from "./helpers/pool.js";

const fake = seedArtifacts();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });
const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });

// Wait for the real worker to answer every card's GET the loader started, then render twice: the first marks them settled.
async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  await Promise.allSettled(Object.values(context.loaderData).flatMap((d) => Object.values(d ?? {})));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context });
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el).replace(/<!-- -->| data-discover="true"/g, "");
}

beforeAll(async () => {
  // The RepoDO reads .cinder.yml through its own env (see seed.test.js).
  env.ARTIFACTS = fake;
  // A pool indexes develop before the gitflow section files its intents, so they lease the symbols they name.
  await seed(api, undefined, []);
  await indexFor(api, REPOS.gitflow, "develop", [{ path: "lib/cart/discount.ts", name: "applyDiscount", kind: "function", line: 2, end: 4 }]);
  await seed(api, undefined, ["gitflow"]);
  // A person marks the seed's drafts ready, so the changes take their leases.
  await markReady(api, [REPOS.gitflow]);
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("repo settings page (live)", () => {
  it("page renders from a real local worker with seeded data", async () => {
    const html = await render(`/${REPOS.gitflow}/settings`);
    expect(html).toContain("<h1>Settings</h1>");
    expect(html).toContain('<span class="pill">from <code>.cinder.yml</code></span>');
    expect(html).not.toContain("aria-busy");
    // Seed: the gitflow repo's .cinder.yml names develop and main as integration branches.
    const rows = [...html.matchAll(/<tr><td class="mono">([^<]+)<\/td><td><input type="checkbox" role="switch"/g)].map((m) => m[1]);
    expect(rows).toEqual(["develop", "main"]);
    // Without the import the trunk repo has no .cinder.yml, so the API answers with defaults and the page shows its hint.
    const defaults = await render(`/${REPOS.trunk}/settings`);
    expect(defaults).toContain("No <code>.cinder.yml</code> yet. These are the defaults; saving commits one to");
  });

  it("after seeding, the page's API calls return data for every state the design shows", async () => {
    // Import: the imported repo and the gitflow repo imported from pulse are listed.
    const repos = await api("GET", "/api/repos");
    expect(repos.map((r) => r.name)).toEqual(expect.arrayContaining(Object.values(REPOS)));
    // Branch policy: gitflow's comes from pulse's .cinder.yml with no runner; trunk has none (the empty state).
    expect(await api("GET", `/api/repos/${REPOS.gitflow}/policy`)).toMatchObject({ integration: ["develop", "main"], release: ["release/*"], defaulted: false });
    expect(await api("GET", `/api/repos/${REPOS.trunk}/policy`)).toMatchObject({ defaulted: true });
    // Launched changes: on an integration and a release branch, and leases for the prediction rail's collisions.
    const targets = (await api("GET", `/api/repos/${REPOS.gitflow}/changes`)).map((c) => c.target_branch);
    expect(targets).toEqual(expect.arrayContaining(["develop", "release/1.2"]));
    const map = await api("GET", `/api/repos/${REPOS.gitflow}/lease-map`);
    expect(map.leases.map((l) => l.symbol)).toContain("lib/cart/discount.ts#applyDiscount");
  });

  it("an API error shows the error state, not a blank page", async () => {
    const path = `/api/repos/${REPOS.gitflow}/policy`;
    vi.stubGlobal("fetch", (url, init) => (url === path ? new Response("", { status: 503 }) : real(url, init)));
    const html = await render(`/${REPOS.gitflow}/settings`);
    expect(html).toContain("<h1>Settings</h1>");
    expect(html).toContain(`<span>Couldn&#x27;t load branch policy: GET ${path}</span>`);
    expect(html).toContain("<h3>Repository</h3>");
  });
});
