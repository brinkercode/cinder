// My model access, rendered against this worker after the seed's models section, which saves no key and records no run.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { client, seed } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";
import { seedArtifacts } from "./fakes/seed.js";

const fake = seedArtifacts();
const cf = fakeCloudflare();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake, ...cf.env });

async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
  return (await new Response((await prerender(el)).prelude).text()).replace(/<!--.*?-->| data-discover="true"/g, "");
}

beforeAll(async () => {
  env.ARTIFACTS = fake;
  vi.stubGlobal("fetch", cf.through(real));
  await seed(client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real }), undefined, ["models"]);
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", cf.through(real));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

it("after the seed, My model access shows no saved key and no usage", async () => {
  const text = (await render("/me/models")).replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
  for (const row of ["|Cloudflare credits|Cloudflare credits|connected|never|", "|Anthropic|—|missing|never|Connect|", "|xAI|—|missing|never|Connect|",
    "|Tokens|0|Spend|$0.00|Agent runs|0|"]) expect(text).toContain(row);
});
