import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

const web = "/acme%2Fweb";

// The first render starts tracking deferred data; once it settles, the second render shows it.
async function render(path) {
  const handler = createStaticHandler(routes);
  let context = await handler.query(new Request(`http://cinder.test${path}`));
  if (context instanceof Response) context = await handler.query(new Request(`http://cinder.test${context.headers.get("Location")}`));
  const el = <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />;
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el).replace(/<!-- -->| data-discover="true"/g, "");
}

beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "1");
  vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// The repo's sub-items under Code in the sidebar (the drawer's copy excluded): [href, label, aria-current].
const repoNav = (html) => [...html.split('<dialog class="drawer"')[0].match(/<div class="sec-body" id="sec-Code"><div>.*?<\/button>(?:<div popover.*?<\/div>)?(.*?)<span class="sb-subsep"/s)[1]
  .matchAll(/<a (?:aria-current="(page)" )?href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(([, cur, href, label]) => [href, label, cur]);

describe("repo navigation", () => {
  it("there is no repo header row inside any page body", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    for (const href of [`${web}/code/develop`, `${web}/changes`, `${web}/environments`,
      `${web}/watchtower`, `${web}/insights`, `${web}/settings`]) {
      const html = await render(href);
      const main = html.match(/<main class="main">.*<\/main>/s)[0];
      expect(main, href).not.toMatch(/repo-head|branch-menu|repo-menu|class="switch"/);
      expect(html.match(/<header class="top">.*?<\/nav>/)[0], href).toMatch(/<span class="cur">acme\/web<\/span>.*popoverTarget="branch-menu"/);
      expect(html, href).not.toMatch(/role="tablist" aria-label="Repository"/);
    }
  });

  it("switching repos on Changes lands on the new repo's Changes", async () => {
    const menu = (await render(`${web}/changes`)).match(/<div popover="auto" id="sec-repo-menu".*?<\/div>/)[0];
    expect([...menu.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])).toEqual(repos.map((r) => `/${encodeURIComponent(r.name)}/changes`));
  });

  it("the target branch survives navigation within a repo, and each repo remembers its own", async () => {
    const store = new Map();
    vi.stubGlobal("sessionStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
    let html = await render(`${web}/changes?target=main`);
    expect(repoNav(html).slice(0, 3).map(([href]) => href)).toEqual([`${web}/code/main`, `${web}/changes?target=main`, `${web}/watchtower?target=main`]);
    html = await render("/acme%2Fkv/insights?target=release%2F1.x");
    const picks = [...html.match(/<div popover="auto" id="sec-repo-menu".*?<\/div>/)[0].matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    expect(picks).toEqual(["/acme%2Fapi/insights", `${web}/insights?target=main`, "/acme%2Fkv/insights?target=release%2F1.x",
      "/acme%2Fstatus-page/insights"]);
  });

  it("the old Branches URL redirects to Code", async () => {
    const res = await createStaticHandler(routes).query(new Request(`http://cinder.test${web}/branches`));
    expect(res.headers.get("Location")).toBe(`${web}/code/develop`);
  });

  it("the sidebar keeps Wiki as an org-level item that opens /wiki", async () => {
    const html = (await render(`${web}/changes`)).split('<dialog class="drawer"')[0];
    expect(repoNav(html).find(([, label]) => label === "Wiki")).toBeUndefined();
    expect(html.match(/<nav class="nav" aria-label="Git">.*?<\/nav>/s)[0]).toMatch(/<a href="\/wiki"[^>]*><svg[^>]*>.*?<\/svg><span>Wiki<\/span><\/a>/);
  });

  it("on /:repo/changes the sidebar shows the repo expanded under Code with Changes marked aria-current", async () => {
    const html = (await render(`${web}/changes`)).split('<dialog class="drawer"')[0];
    expect(html).toMatch(/<button class="sec-head" aria-expanded="true" aria-controls="sec-Code">.*?<div class="sec-body" id="sec-Code"><div><div class="ctx"><button[^>]*class="ctx-r"[^>]*><span class="rp-av">A<\/span><b title="acme\/web">acme\/web<\/b>/);
    expect(repoNav(html)).toEqual([["code/develop", "Code"], ["changes", "Changes", "page"],
      ["watchtower", "Watchtower"], ["insights", "Insights"], ["settings", "Settings"]]
      .map(([t, label, cur]) => [t[0] === "/" ? t : `${web}/${t}`, label, cur]));
    expect([...html.matchAll(/aria-current="page"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Changes"]);
  });

  it("each repo feature renders that repo's data and nothing from other repos", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const others = repos.map((r) => r.name).filter((n) => n !== "acme/web");
    // Wiki opens the org wiki, outside the repo's pages.
    for (const [href, label] of repoNav(await render(web)).filter(([, label]) => label !== "Wiki")) {
      // The repo switcher lists every repo by design; everything else on the page belongs to acme/web.
      const html = (await render(href)).replace(/<div popover="auto" id="[^"]*repo-menu".*?<\/div>|<script>.*?<\/script>/g, "");
      expect(html, label).toMatch(/<span class="cur">acme\/web<\/span>/);
      expect(repoNav(html).find((n) => n[2])?.[1], label).toBe(label);
      for (const other of others) {
        expect(html, `${label} shows ${other}`).not.toContain(other);
        expect(html, `${label} shows ${other}`).not.toContain(encodeURIComponent(other));
      }
    }
  });
});
