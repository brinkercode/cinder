import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const settled = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const html = await new Response((await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />)).prelude).text();
  return html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
};
const live = (body) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(async (path) => (path === "/api/repos" ? Response.json(repos) : body(path))));
};
const ENTRY = { name: "sec-review", source: "published", description: "Reviews changes for leaked secrets", publisher: "labs", harness: "claude-code", model: "claude-opus-5-5",
  tools: ["read"], egress: ["pkg.go.dev"], versions: [1, 2], wins: 2, races: 3, installs: 7, tokens_per_merge: 21000, visibility: "instance", mine: false };

it("marketplace cards show version, publisher, harness, model, installs, untrusted win rate and tokens per merged change", async () => {
  live((path) => Response.json(path === "/api/marketplace" ? [ENTRY] : []));
  const t = await settled("/automation/marketplace");
  expect(t).toContain("sec-review v2 Reviews changes for leaked secrets · by labs · claude-code · claude-opus-5-5 7 installs Install");
  expect(t).toContain("Win rate untrusted: 3 outcomes");
  expect(t).toContain("21k tokens per merged change");
});

it("a marketplace that fails to load shows an inline error with Retry", async () => {
  live(() => Response.json({ error: { message: "unavailable" } }, { status: 503 }));
  const t = await settled("/automation/marketplace");
  expect(t).toContain("Couldn't load the marketplace. Installed agents keep running.");
  expect(t).toContain("Retry");
});
