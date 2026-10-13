import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const settled = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  return new Response((await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />)).prelude).text();
};
const unauthorized = () => Response.json({ error: { code: "access_denied", message: "missing or invalid Cloudflare Access JWT" } }, { status: 401 });

describe("session expiry", () => {
  it("the SPA shows the re-sign-in message on a 401", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    const fetch = vi.fn(async (path) => (path === "/api/repos" ? Response.json(repos) : unauthorized()));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const page = await settled("/acme%2Fapi/insights");
    expect(page).toContain('<h2>Session expired, sign in again</h2><a class="btn btn-primary" href="/">Sign in</a>');
    expect(page).not.toContain("Retry");

    // The shell's own load failing is not a dead page either.
    vi.stubGlobal("fetch", async () => unauthorized());
    expect(await settled("/automation/workers")).toContain("<main><div class=\"frame\"><div class=\"fc\"><div class=\"f-body\"><div class=\"panel\"><div class=\"state error\"><h2>Session expired, sign in again</h2>");
  });

  it("a loader error from a 401 access_no_email renders the no-email state, not Session expired", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("fetch", async () => Response.json({ error: { code: "access_no_email", message: "no email" } }, { status: 401 }));
    const page = await settled("/automation/workers");
    expect(page).toContain("<h2>This Access identity has no email</h2>");
    expect(page).not.toContain("Session expired");
    expect(page).not.toContain("Sign in");
  });
});
