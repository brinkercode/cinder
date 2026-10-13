import { readFileSync } from "node:fs";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const render = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const app = <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />;
  return new Response((await prerender(app)).prelude).text();
};
// Demo mode: every list is a fixture; the wiki (always live) answers with a page tree that must not show.
const demo = () => {
  vi.stubEnv("VITE_FIXTURES", "1");
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("fetch", async () => Response.json([{ id: "p-arch", parent_id: null, title: "Architecture", slug: "architecture", type: "page", sort_order: 1, agent_context: false, children: [] }]));
};
const PAGES = [["changes", "No changes yet"], ["releases", "No releases yet"], ["watchtower", "Nothing to scan yet"],
  ["insights", "No data yet"], ["flows", "No flows yet"], ["environments", "No environments yet"]].map(([p, t]) => [`/acme%2Fstatus-page/${p}`, t])
  .concat([["/wiki/acme%2Fstatus-page", "No wiki pages yet"]]);
// The work area: the frame body up to the end of the main column.
const work = (html) => html.split('<div class="f-body">')[1].split("</main>")[0];
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("empty repo pages", () => {
  it("status-page shows no fake data on any repo page", async () => {
    demo();
    for (const [path, title] of PAGES) {
      const w = work(await render(path));
      // One card, holding only the empty state: title, its sentence and the actions.
      expect(w.match(/class="card"/g), path).toHaveLength(1);
      expect(text(w), path).toMatch(new RegExp(`^${title} [^%]+\\. (Describe a change |New issue |Create the first page )?Quick setup$`));
    }
  });

  it("each empty state is centred in its card and has at least one action", async () => {
    demo();
    expect(readFileSync(new URL("styles/app.css", import.meta.url), "utf8")).toContain(".empty{padding:56px var(--s-6);text-align:center;display:flex;flex-direction:column;align-items:center");
    for (const [path] of PAGES) {
      const w = work(await render(path));
      expect(w, path).toMatch(/^<div class="card"><div class="empty">/);
      expect(w.match(/<a class="btn btn-primary" href="[^"]+"/g), path).toHaveLength(1);
      expect(w, path).toContain('href="/acme%2Fstatus-page/code/main" data-discover="true"><svg');
    }
  });
});
