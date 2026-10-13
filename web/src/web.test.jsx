import { readdirSync, readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { prerender } from "react-dom/static";
import { IconContext } from "react-icons";
import { PiBookBookmark, PiBracketsAngle, PiDatabase, PiGearSix, PiHouse, PiPulse, PiRobot, PiShieldCheck, PiSidebarSimple, PiSparkle, PiWarningCircle } from "react-icons/pi";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import changes from "../../worker/src/api/fixtures/changes.json";
import needs from "../../worker/src/api/fixtures/needs.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import { list } from "./client.js";
import { ErrorPage, routes } from "./routes.jsx";
import { toggleTheme } from "./shell.jsx";


beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "1");
  vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("web foundation", () => {
  it("fixture mode returns fixture changes", async () => {
    expect(await list("/api/changes")).toEqual(changes);
  });

  const repo = `/${encodeURIComponent(repos[0].name)}`;
  // The app's main routes (repos, code, changes, change detail, agents, settings, new change, needs you, insights).
  const paths = ["/", "/:repo/code/:ref/*", "/:repo/changes", "/:repo/changes/:id/:tab?", "/automation/agents/:id?/:tab?",
    "/:repo/settings", "/:repo/changes/new", "/needs", "/:repo/insights"].map((r) => r.replace("/:repo", repo)
    .replace(":ref", "main").replace("*", "src/a.js").replace(/\/:\w+\?/g, "").replace(":id", changes[0].id));

  const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");

  it("every main route renders inside the shell", async () => {
    expect(paths).toHaveLength(9);
    const handler = createStaticHandler(routes);
    for (const path of paths) {
      const context = await follow(handler, path);
      expect(context.errors, path).toBeNull();
      expect(context.statusCode, path).toBe(200);
      const html = renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
      expect(html, path).toContain('<aside class="side">');
      expect(html, path).toContain('<div class="slabel">Git<span class="pill">Beta</span></div>');
      expect(html, path).toContain('<main class="main"><div class="frame');
      expect(html, path).not.toContain("<h1>Error</h1>");
    }
  });

  // The standalone race path redirects to its agent's page, so follow redirects to the page that renders.
  const follow = async (handler, path) => {
    const res = await handler.query(new Request(`http://cinder.test${path}`));
    return res instanceof Response && res.headers.get("Location") ? follow(handler, res.headers.get("Location")) : res;
  };
  const shellAt = async (path) => {
    const handler = createStaticHandler(routes);
    const context = await follow(handler, path);
    const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
    return new Response(prelude).text();
  };

  it("the shell renders exactly one sidebar, with no platform rail and no product sidebar", async () => {
    const [page, drawer] = (await shellAt(`${repo}/changes`)).split('<dialog class="drawer"');
    const html = page;
    expect(html.match(/<aside/g)).toHaveLength(1);
    expect(html.match(/<nav class="nav"/g)).toHaveLength(1);
    // The <=720px drawer holds the same sidebar, not a second one.
    expect(drawer.match(/<aside.*?<\/aside>/g).map((a) => a.replaceAll("drawer-sec-", "sec-"))).toEqual(html.match(/<aside.*?<\/aside>/g));
    expect(html).not.toContain("prail");
    expect(html).not.toContain("All products");
    expect(html).not.toContain("tagline");
    expect(html).toMatch(/<aside class="side"><div class="sb-header"><svg class="mark".*?<\/svg><button type="button" class="acct"[^>]*><span class="acct-name">/);
    expect(html.match(/<header class="top">.*?<\/header>/)[0]).not.toContain("acct-name");
  });

  it("the sidebar renders exactly these groups and items, with the Beta pill, no Cinder item and no owner-token UI", async () => {
    const side = (await shellAt("/")).match(/<aside class="side">.*?<\/aside>/)[0];
    expect(side).toMatch(/<div class="slabel">Git<span class="pill">Beta<\/span><\/div>/);
    const nav = side.match(/<nav class="nav" aria-label="Git">(.*?)<\/nav>/)[1];
    const sections = [...nav.matchAll(/<button class="sec-head"[^>]*>.*?<span>([^<]+)<\/span>.*?<\/button>(.*?)<\/div><\/div><\/div>/g)]
      .map(([, name, body]) => [name, [...body.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1])]);
    expect(sections).toEqual([
      ["Code", ["Code", "Changes", "Watchtower", "Insights", "Settings"]],
      ["Automation", ["Agents", "Marketplace", "Judges &amp; calibration", "Flows", "Environments", "Workers"]],
      ["Settings", ["Access &amp; people", "Keystore"]],
    ]);
    expect(nav).toMatch(/<\/div><\/div><\/div><a href="\/wiki"[^>]*>.*?<span>Wiki<\/span><\/a><div class="sec"><button class="sec-head"[^>]*>.*?<span>Automation<\/span>/);
    expect(nav).toMatch(/Workers<\/a><span class="sec-line" aria-hidden="true"><\/span><\/div><\/div><\/div><a href="\/needs"[^>]*>.*?<span>Needs you<\/span>.*?<\/a><div class="sec"><button class="sec-head".*?Settings/);
    expect(side).not.toContain("Cinder");
    expect(side).not.toMatch(/token|<input|<form/i);
  });

  it("Code with no repo in the URL opens the last chosen repo, else asks for one", async () => {
    vi.stubGlobal("localStorage", { getItem: (k) => (k === "cinder.last_repo" ? repos[0].name : null) });
    const res = await createStaticHandler(routes).query(new Request("http://cinder.test/code"));
    expect(res.headers.get("Location")).toBe(`${repo}/code/${repos[0].default_branch}`);
    vi.stubGlobal("localStorage", { getItem: () => null });
    expect(await shellAt("/code")).toContain(`<a class="btn btn-secondary" href="${repo}/code/${repos[0].default_branch}"`);
  });

  it("the removed Insights › Overview and Settings › Branch policies URLs redirect to the repo's Insights and Settings", async () => {
    vi.stubGlobal("localStorage", { getItem: (k) => (k === "cinder.last_repo" ? repos[0].name : null) });
    for (const page of ["insights", "settings"]) {
      const res = await createStaticHandler(routes).query(new Request(`http://cinder.test/${page}`));
      expect(res.headers.get("Location"), page).toBe(`${repo}/${page}`);
    }
  });

  it("Web test: /explore and /topics/x render Page not found", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    // A missing repo is a 404, as the API answers it.
    vi.stubGlobal("fetch", async (url) => (url.startsWith("/api/repos/") ? new Response(null, { status: 404 }) : Response.json([])));
    for (const path of ["/explore", "/topics/x", "/community/explore", "/community/topics/x"]) {
      expect(await shellAt(path), path).toContain("<h3>Page not found</h3>");
    }
  });

  it("the top bar has no platform name and no search field, and shows repo › target branch on repo pages", async () => {
    const html = await shellAt(`${repo}/code/main/src/a.js`);
    const top = html.match(/<header class="top">.*?<\/header>/)[0];
    expect(top).not.toMatch(/nimbus|role="search"|Search/);
    expect(top).toMatch(new RegExp(`<nav class="crumb" aria-label="Breadcrumb"><svg.*?</svg><span class="cur">${repos[0].name}</span>.*?popoverTarget="branch-menu".*?<span class="bm-n mono">main</span>`));
    expect(top).not.toMatch(/class="live/);
    expect(top).toMatch(/Support.*aria-label="Notifications".*aria-label="Toggle light\/dark".*aria-label="Account"/);
  });

  it("Needs you shows the live count", async () => {
    expect(await shellAt("/")).toContain(`<span>Needs you</span><!--$--><span class="count">${needs.length}</span><!--/$--></a>`);
  });

  it("platform items open the dashboard", async () => {
    const side = (await shellAt(`${repo}/changes`)).match(/<aside class="side">.*?<\/aside>/)[0];
    const platform = side.replace(/<nav class="nav".*?<\/nav>/, "");
    const linked = ["Account home", "Observability", "Compute", "AI", "Storage &amp; databases", "Zero Trust"];
    for (const l of linked) expect(platform, l).toMatch(new RegExp(`<a class="stub" href="https://dash\\.cloudflare\\.com/[^"]*" target="_blank" rel="noreferrer"><svg[^>]*>.*?</svg><span>${l}</span>`));
    expect(platform.match(/<span class="pill">New<\/span>/g)).toHaveLength(1);
    expect(platform.indexOf("Protect &amp; connect")).toBeLessThan(platform.indexOf(">Git<"));
  });

  it("each sidebar item renders an svg", async () => {
    const side = (await shellAt("/")).match(/<aside class="side">.*?<\/aside>/)[0];
    const items = [["Account home", PiHouse],
      ["Observability", PiPulse], ["Compute", PiBracketsAngle], ["AI", PiSparkle], ["Storage &amp; databases", PiDatabase],
      ["Zero Trust", PiShieldCheck],
      ["Code", PiBookBookmark], ["Automation", PiRobot],
      ["Needs you", PiWarningCircle], ["Settings", PiGearSix]];
    // The react-icons/pi markup, sized by .ico (16px) with currentColor and hidden from screen readers.
    const svg = (Pi) => renderToString(<IconContext.Provider value={{ className: "ico", attr: { "aria-hidden": "true" } }}><Pi /></IconContext.Provider>);
    for (const [label, Pi] of items) {
      expect(side.match(new RegExp(`(<svg(?:(?!<svg).)*?</svg>)<span>${label.replace(".", "\\.")}</span>`))?.[1], label).toBe(svg(Pi));
    }
    expect(side.match(/title="Collapse sidebar">(<svg.*?<\/svg>)/)?.[1]).toBe(svg(PiSidebarSimple));
    expect(svg(PiHouse)).toMatch(/^<svg stroke="currentColor" fill="currentColor"[^>]*viewBox="0 0 256 256" class="ico"/);
  });

  it("the Git section has no collapse control and is always expanded", async () => {
    const html = (await shellAt("/automation/judges")).match(/<aside class="side">.*?<\/aside>/)[0];
    expect(html).toMatch(/<div class="slabel">Git<span class="pill">Beta<\/span><\/div><nav class="nav" aria-label="Git">/);
    expect(html).not.toMatch(/<(summary|button)[^>]*>(<[^>]+>)*Git</);
  });

  it("the shell grid and breakpoints match (260/1fr, the content column a 58px top bar over .main, still 260px at 1100, one column at 900) in the stylesheet", () => {
    expect(css).toContain(".app{display:grid;grid-template-columns:260px minmax(0,1fr);height:100vh}");
    expect(css).toContain(".app-col{grid-area:1/2;display:flex;flex-direction:column;min-width:0;min-height:0}");
    expect(css).toContain(".top{height:58px;flex:none;");
    expect(css).toContain(".main{flex:1;min-height:0;overflow:auto;min-width:0}");
    expect(css).not.toMatch(/@media \(max-width:1100px\)\{\.app\{grid-template-columns/);
    expect(css).toMatch(/@media \(max-width:900px\)\{\s*\.app\{grid-template-columns:minmax\(0,1fr\)\}\.app>\.side,\.hide-s\{display:none\}/);
  });

  it("an Access 401 shows no token form", async () => {
    const handler = createStaticHandler([{ path: "/", errorElement: <ErrorPage />,
      loader: () => { throw Object.assign(new Error("/api/repos: HTTP 401"), { status: 401, code: "access_denied" }); } }]);
    const context = await handler.query(new Request("http://cinder.test/"));
    const html = renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
    expect(html).not.toContain('name="token"');
  });

  it("theme toggle swaps the .dark class and keeps the choice", () => {
    const classes = new Set();
    const startViewTransition = vi.fn((go) => go());
    const toggle = (c) => (classes.has(c) ? !classes.delete(c) : !!classes.add(c));
    const setItem = vi.fn();
    vi.stubGlobal("document", { startViewTransition, documentElement: { classList: { toggle } } });
    vi.stubGlobal("localStorage", { setItem });
    toggleTheme();
    expect(classes.has("dark")).toBe(true);
    expect(setItem).toHaveBeenLastCalledWith("cinder.theme", "dark");
    toggleTheme();
    expect(classes.has("dark")).toBe(false);
    expect(setItem).toHaveBeenLastCalledWith("cinder.theme", "light");
    expect(startViewTransition).toHaveBeenCalledTimes(2);
  });

  it("target-branch switcher changes the route's target", async () => {
    const handler = createStaticHandler(routes);
    const flow = `/${encodeURIComponent(repos[1].name)}/changes`;
    const target = async (path) => {
      const context = await handler.query(new Request(`http://cinder.test${path}`));
      const html = renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
      expect(html).toContain(`href="${flow}?target=main"`);
      return html.match(/popoverTarget="branch-menu".*?<span class="h">([^<]*)</)[1];
    };
    expect(await target(flow)).toBe(repos[1].default_branch);
    expect(await target(`${flow}?target=main`)).toBe("main");
  });

  it("no color literal or font-family outside tokens.css", () => {
    const dir = new URL("./", import.meta.url);
    const defined = new Set([...readFileSync(new URL("styles/tokens.css", dir), "utf8").matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
    const files = readdirSync(dir, { recursive: true }).filter((f) => /\.(css|jsx?)$/.test(f) && !/tokens\.css|\.test\./.test(f));
    expect(files).toContain("styles/app.css");
    expect(files).toContain("repos.jsx");
    expect(files).toContain("automation-agents.jsx");
    expect(files).toContain("judges.jsx");
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/);
      expect(src, f).not.toMatch(/font-family:\s*(?!var\(--font-)|fontFamily(?!:\s*"var\(--font-)/);
      for (const [, name] of src.matchAll(/var\((--[\w-]+)/g)) expect(defined, `${f} ${name}`).toContain(name);
    }
  });
});

it("no web/src module imports from docs/", () => {
  const dir = new URL("./", import.meta.url);
  const hits = readdirSync(dir, { recursive: true }).filter((f) => /\.(css|jsx?)$/.test(f))
    .filter((f) => /(?:\bfrom|\bimport\(?|@import)\s*["'][^"']*\bdocs\//.test(readFileSync(new URL(f, dir), "utf8")));
  expect(hits).toEqual([]);
});
