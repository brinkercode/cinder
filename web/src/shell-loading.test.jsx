import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const api = (fetch) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(fetch));
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe("shell loading", () => {
  it("with /api/repos pending, a page renders its skeleton", async () => {
    api(() => new Promise(() => {}));
    const page = async (path) => {
      const handler = createStaticHandler(routes);
      const context = await Promise.race([handler.query(new Request(`http://cinder.test${path}`)), tick(200)]);
      expect(context, `${path}'s loaders answer before /api/repos`).toBeTruthy();
      // renderToString draws every pending boundary's fallback: what the browser paints first.
      return renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
    };
    expect(await page("/automation/judges")).toContain('<p role="status" class="sr-only">Loading Judges</p>');
    expect(await page("/")).toContain('<p role="status" class="sr-only">Loading repositories</p>');
  });

  it("a rejected needs request produces no unhandled rejection", async () => {
    const answers = { "/api/repos": () => Response.json([]), "/api/needs": () => new Response("boom", { status: 500 }) };
    api(async (url) => (answers[url] ? answers[url]() : new Promise(() => {})));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // Nothing renders the loader data here, as when a redirect or error drops it before <Await> mounts.
      const data = await routes[0].loader({ request: new Request("http://cinder.test/"), params: {} });
      await tick(50);
      expect(unhandled).not.toHaveBeenCalled();
      await expect(data.needs).rejects.toThrow("/api/needs: HTTP 500");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
