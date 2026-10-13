import { readdirSync, readFileSync } from "node:fs";
import { repoAt } from "./fake-repos.js";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import history from "../../worker/src/api/fixtures/wiki-history.json";
import { routes } from "./routes.jsx";

const WIKI = "/api/repos/acme%2Fweb/wiki";
const page = { id: "p-arch", repo_id: "r-web", parent_id: null, title: "Architecture", slug: "architecture", type: "page", content: "Leases first.",
  sort_order: 1, view_count: 4, created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-04T16:20:00.000Z",
  agent_context: false, words: 2, read_minutes: 1, views: 3, toc: [], children: [] };

// Live mode against a fake API; `tree` is the wiki's page tree.
const live = (tree) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (url) => {
    if (repoAt(url)) return Response.json(repoAt(url));
    if (url === "/api/repos/no-such-page") return new Response(null, { status: 404 });
    if (url === `${WIKI}/tree`) return Response.json(tree);
    if (url === `${WIKI}/pages/p-arch/history`) return Response.json(history);
    if (url === `${WIKI}/pages/p-arch`) return Response.json(page);
    return Response.json([]);
  });
};
const main = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  return (await new Response(prelude).text()).match(/<main.*/s)[0]; // to the end: streamed Suspense content lands after </main>
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("No placeholder or \"not in this pass\" text anywhere in the app", async () => {
  const dir = new URL("./", import.meta.url);
  const sources = readdirSync(dir, { recursive: true }).filter((f) => /\.(jsx?|css)$/.test(f) && !/\.test\./.test(f) && f !== "fake-dom.js");
  for (const f of sources) expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/not in this pass|not designed yet|design pass|undesigned|placeholder page/i);

  live([]);
  const html = await main("/no-such-page");
  expect(html).toContain("<h3>Page not found</h3>");
  expect(html).toMatch(/<a class="btn btn-secondary" href="\/"[^>]*>All repositories<\/a>/);
  expect(html).not.toContain("Retry");
});

it("Wiki renders in v3 cards with v3 empty states, scrolling tables and no legacy panels", async () => {
  live([page]);
  const pages = { wiki: await main("/wiki/acme%2Fweb/p-arch") };
  for (const [name, html] of Object.entries(pages)) expect(html, name).not.toMatch(/class="(panel|panel-head|state [a-z]+)"/);
  expect(pages.wiki).toMatch(/>History<\/a>.*>Edit<\/a>.*<div class="wk-title"><h1>Architecture<\/h1><p class="meta">Updated .* by owner · v3/s);
  expect(pages.wiki).toMatch(/<section class="wk-cm" aria-label="Comments"><h3>Comments/);

  live([]);
  expect(await main("/wiki/acme%2Fweb")).toMatch(/<div class="card"><div class="empty">.*<h3>No wiki pages yet<\/h3>/);
});
