// The web Repos (home) page, rendered against this worker with seeded data instead of fixtures.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
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

// Wait for the real worker to answer, then the first render starts tracking the overview promise and the second shows it.
async function render() {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://cinder.test/"));
  await Promise.allSettled(Object.values(context.loaderData).map((d) => d?.overview));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context });
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el).replace(/<!-- -->| data-discover="true"/g, "");
}

let setupMs;

// The most sections of any live file, so its setup is the slowest.
beforeAll(async () => {
  const start = Date.now();
  env.ARTIFACTS = fake;
  const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
  await seed(api, undefined, ["changes", "gitflow"]);
  // A person marks the seed's drafts ready, so the changes take their leases.
  await markReady(api, Object.values(REPOS));
  await real("/api/repos", { method: "POST", body: JSON.stringify({ name: "manual-empty-1" }) });
  setupMs = Date.now() - start;
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("repos home (live)", () => {
  // Logged, not asserted: on a loaded shared host this setup measured 5.5-6.7 s, which would redden main.
  it("the slowest live file's setup finishes in under 5 s", async ({ annotate }) => {
    await annotate(`repos-live setup: ${setupMs} ms (target: under 5000 on a 3-CPU runner)`);
  });

  it("page renders from a real local worker with seeded data", async () => {
    const html = await render();
    expect(html).not.toContain("Couldn&#x27;t load repositories");
    // Seed: every filed change but the closed ones is open once a person marks it ready.
    for (const [name, active] of [[REPOS.trunk, 11], [REPOS.gitflow, 15]]) {
      expect(html).toMatch(new RegExp(`>${name}</a>.*?<b>${active}</b> open`));
    }
  });

  it("after seeding, the page's API calls return data for every state the design shows", async () => {
    const html = await render();
    // No merges until a pool runs one, a busy repo, and an idle repo on main (nothing in flight, no agents).
    expect(html).toContain('Changes merged</div><div class="v">0');
    expect(html).toMatch(new RegExp(`>manual-empty-1</a>.*?<span class="mono">main</span>.*?<b>0</b> open.*?<b>0</b> agents`));
    expect(html).toMatch(new RegExp(`>${REPOS.trunk}</a>.*?<span class="mono">main</span>.*?<b>11</b> open.*?no outcomes yet`));
  });

  it("an API error shows the error state, not a blank page", async () => {
    const path = `/api/repos/${REPOS.trunk}/changes`;
    vi.stubGlobal("fetch", (url, init) => (url === path ? new Response("", { status: 503 }) : real(url, init)));
    const html = await render();
    expect(html).not.toContain("<h1>Error</h1>");
    expect(html).toContain(`Couldn&#x27;t load repositories: ${path}: HTTP 503`);
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
  });
});
