import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); });

const page = async (path) => {
  vi.stubEnv("VITE_FIXTURES", "1");
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const html = await new Response((await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />)).prelude).text();
  return html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&amp;", "&");
};

describe("workers and settings pages", () => {
  it("workers, tokens and people pages show the API's pools, workers and people", async () => {
    const workers = await page("/automation/workers");
    expect(workers).toContain("Managed · build default One sandbox per run");
    expect(workers).toContain("eu-gpu bring your own For builds that need more than 4 vCPU or 20 GB of disk, or a GPU. Runs anywhere, including other clouds. 3 of 4 online Edit AWS eu-west-1 Labels gpu large-disk Heartbeat");
    const people = await page("/settings/access");
    expect(people).toContain("Access group eng-payments Owner Maintainer Contributor billing-api, ledger-ui");
    expect(people).toContain("sam sam@acme.test developer Owner Maintainer Contributor never Remove sam");
  });

  // Component sources minus comments, imports, the old /automation/runners path that redirects, the /api/runners API path and the v3 prototype's
  // "runner pool" and "runner token", the CLI's real register command and module path the BYO registration step prints, and AWS's App Runner service.
  it("the UI never names the lab machine, nor runner outside a runner pool or token", async () => {
    const sources = import.meta.glob(["./*.jsx", "!./*.test.jsx"], { query: "?raw", import: "default", eager: true });
    expect(Object.keys(sources)).toContain("./runners.jsx");
    const strip = (s) => s.replace(/(automation|api)\\?\/runners|[Rr]unner (pool|token)s?|cinder runner register|cinder\/runner\/cmd\/|[Aa]pp ?[Rr]unner/g, "");
    for (const [file, src] of Object.entries(sources)) {
      expect(strip(src.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$|^import .*$|import\("[^"]*"\)/gm, "")), file).not.toMatch(/runner|home.?lab/i);
    }
    for (const path of ["/automation/workers", "/settings/keystore"]) expect(strip(await page(path))).not.toMatch(/runner|home.?lab/i);
  });
});
