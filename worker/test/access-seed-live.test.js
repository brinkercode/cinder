// Settings › Access & people, rendered against this worker after the seed's access section.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PEOPLE, ROLES, client, seed } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { seedArtifacts } from "./fakes/seed.js";

const fake = seedArtifacts();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });

async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
  return (await new Response((await prerender(el)).prelude).text()).replace(/<!--.*?-->| data-discover="true"/g, "");
}

beforeAll(async () => {
  env.ARTIFACTS = fake;
  await seed(client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real }), undefined, ["access"]);
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

it("Dummy data: seed.mjs seeds Access & people with PEOPLE and no group mappings", async () => {
  const html = await render("/settings/access");
  expect(html).not.toContain('<td class="mono">');
  for (const [i, email] of PEOPLE.entries()) {
    const name = email.split("@")[0], role = { maintainer: "Maintainer", contributor: "Contributor" }[ROLES[i]] ?? ROLES[i];
    const row = html.slice(html.indexOf(`${name}</span></td><td class="meta">${email}</td><td><select`)).split("</tr>")[0];
    expect(row).toMatch(new RegExp(`<option value="${ROLES[i]}"[^>]*selected="">${role}</option>.*<td class="meta">never</td>`));
  }
});
