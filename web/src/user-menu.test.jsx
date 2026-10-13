import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (path) => Response.json({ "/api/repos": repos, "/api/me": { email: "ada@example.com", owner: true } }[path] ?? []));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const top = async () => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://cinder.test/needs"));
  const html = await new Response((await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />)).prelude).text();
  return html.match(/<header class="top">.*?<\/header>/)[0];
};
const menu = (html) => html.match(/<div popover="auto" id="user-menu".*?<\/div>/)[0];

describe("user menu", () => {
  it("opening the user menu renders the person's name and email and the five items in order", async () => {
    const items = [...menu(await top()).matchAll(/<(p|a|button)[^>]*>(.*?)<\/\1>/g)].map((m) => m[2].replace(/<svg.*?<\/svg>|<!--.*?-->/g, ""));
    expect(items).toEqual(["<strong>ada</strong><br/>ada@example.com", 'My model access<span class="tag">new</span>', "Toggle theme", "Access &amp; people", "Sign out"]);
  });

  it("Sign out links to /cdn-cgi/access/logout", async () => {
    expect(menu(await top())).toMatch(/<a href="\/cdn-cgi\/access\/logout"><svg.*?<\/svg>Sign out<\/a>/);
  });

  it("the avatar renders the person's initial from /api/me", async () => {
    expect(await top()).toMatch(/aria-label="Account"[^>]*><!--\$-->A<!--\/\$--><\/button>/);
  });
});
