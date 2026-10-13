import { renderToString } from "react-dom/server";
import { repoAt } from "./fake-repos.js";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, MemoryRouter, Route, Routes, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Every page's data stays pending, so prerender stops on its skeletons; the shell's repos still answer.
const loading = async (path) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(async (url) => (repoAt(url) ? Response.json(repoAt(url)) : new Promise(() => {}))));
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const stop = new AbortController();
  const pending = prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />, { signal: stop.signal });
  setTimeout(() => stop.abort(), 50);
  return new Response((await pending).prelude).text();
};
const n = (html, re) => html.match(re)?.length ?? 0;
const counts = (html) => ({
  status: html.match(/<p role="status" class="sr-only">([^<]*)<\/p>/g)?.filter((s) => s.includes("Loading")).map((s) => s.replace(/<[^>]+>/g, "")),
  listCards: n(html, /class="card skel-card"/g),
  tableRows: [...html.matchAll(/<tbody>(.*?)<\/tbody>/g)].map((m) => n(m[1], /<tr style="height:44px">/g)),
  tiles: n(html, /class="tile flat"/g),
});
const headers = (html) => [...html.matchAll(/<thead><tr>(.*?)<\/tr><\/thead>/g)].map((m) => [...m[1].matchAll(/<th>([^<]*)<\/th>/g)].map((t) => t[1]));

const count = (html, s) => html.split(s).length - 1;

describe("page skeletons", () => {
  it("each page's skeleton counts match the spec", async () => {
    const needs = renderToString((await routes[0].children.find((r) => r.path === "/needs").lazy()).hydrateFallbackElement);
    expect(needs).toContain("<h1>Needs you");
    expect(counts(needs)).toEqual({ status: ["Loading Needs you"], listCards: 3, tableRows: [], tiles: 0 });

    const judges = await loading("/automation/judges");
    expect(judges).toMatch(/<button type="button" class="btn btn-primary" disabled="">.*Add judge<\/button>/);
    expect(counts(judges)).toEqual({ status: ["Loading Judges"], listCards: 3, tableRows: [], tiles: 0 });

    const workers = await loading("/automation/workers");
    expect(workers).toContain("<h1>Workers");
    expect(counts(workers)).toEqual({ status: ["Loading Workers"], listCards: 2, tableRows: [], tiles: 0 });

    // Tables: 4–8 rows under real headers and card titles, the card's own button disabled.
    const access = await loading("/settings/access");
    expect(counts(access)).toEqual({ status: ["Loading Access &amp; people"], listCards: 0, tableRows: [4, 6, 2], tiles: 0 });
    expect(headers(access)).toEqual([["Source", "Group", "Cinder role", "Repos", ""], ["Name", "Email", "Role", "Last seen", ""], ["Name", "Client ID", ""]]);
    expect(access).toMatch(/<h3>Group → role mapping<\/h3><span class="end"><button type="button" class="btn btn-secondary btn-sm" disabled="">/);

    const keystore = await loading("/settings/keystore");
    expect(counts(keystore)).toEqual({ status: ["Loading Keystore"], listCards: 0, tableRows: [6], tiles: 0 });
    expect(headers(keystore)[0]).toEqual(["Name", "Scope", "Applies to", "Last used", "Changed by", ""]);
    expect(keystore).toMatch(/<input aria-label="Search secrets" placeholder="Search secrets" disabled=""/);
    expect(keystore).toContain("<h3>Org model keys</h3>");
    expect(keystore).not.toContain("Runner tokens");

    const models = await loading("/me/models");
    expect(counts(models)).toEqual({ status: ["Loading My model access"], listCards: 0, tableRows: [5], tiles: 4 });
    expect(headers(models)).toEqual([["Provider", "Source", "Status", "Last used", ""]]);
    expect(models).toContain("<h3>Credential sources</h3>");
    expect(n(models, /<div class="srow"><div class="skel-lines">/g)).toBe(3);
    for (const l of ["Tokens", "Spend", "Agent runs", "Personal budget"]) expect(models).toContain(`<div class="l">${l}</div>`);

    const releases = await loading(`/${encodeURIComponent(repos[0].name)}/releases`);
    expect(counts(releases)).toEqual({ status: ["Loading Releases"], listCards: 3, tableRows: [], tiles: 0 });
    expect(releases).toMatch(/<nav class="crumb" aria-label="Breadcrumb"><a href="[^"]+"[^>]*>Code<\/a><span>›<\/span><span class="cur">Releases<\/span><\/nav><div class="end"><button type="button" class="btn btn-secondary" disabled="">/);
    expect(releases).toMatch(/<input aria-label="Search tags and releases" placeholder="Search tags and releases" disabled=""/);

    // Agents index (F2): 4 list cards; the aside shows an empty ring and its tiles.
    const agents = await loading("/automation/agents");
    expect(counts(agents)).toEqual({ status: ["Loading Agents"], listCards: 4, tableRows: [], tiles: 2 });
    expect(agents).toMatch(/<aside><!--\$\?--><template[^>]*><\/template><h2>Fleet<\/h2>/);
    expect(agents).toMatch(/<svg class="ring"[^>]*><circle[^>]*><\/circle><text[^>]*><\/text><\/svg>/);

    // Agent detail (F1): real tabs, 4 tiles and the run's calls table.
    const agent = await loading("/automation/agents/developer");
    expect(counts(agent)).toEqual({ status: ["Loading Agent"], listCards: 0, tableRows: [4], tiles: 4 });
    expect(agent).toContain('aria-label="Agent views"');
    expect(headers(agent)).toEqual([["Model", "Call", "Input", "Output", "Cost", "Latency"]]);
  });

  it("keystore, access, workers, judges, agents and models draw a skeleton before data", async () => {
    const fallback = async (path, at = path) => {
      const route = await routes[0].children.find((r) => r.path === path).lazy();
      return renderToString(<MemoryRouter initialEntries={[at]}><Routes><Route path={path} element={route.hydrateFallbackElement} /></Routes></MemoryRouter>);
    };
    for (const [path, h1, page, at] of [
      ["/settings/keystore", "<h1>Keystore", "Keystore"],
      ["/settings/access", "<h1>Access &amp; people", "Access &amp; people"],
      ["/automation/workers", "<h1>Workers", "Workers"],
      ["/automation/judges/:id?", "<h1>Judges &amp; calibration", "Judges", "/automation/judges"],
      ["/automation/agents", "<h1>Agents", "Agents"],
      ["/automation/agents/:name/:tab?", 'aria-label="Agent views"', "Agent", "/automation/agents/developer"],
      ["/me/models", "<h1>My model access", "My model access"],
    ]) {
      const html = await fallback(path, at);
      expect(html, path).toContain(h1);
      expect(counts(html).status, path).toEqual([`Loading ${page}`]);
    }
  });

  it("each page's skeleton counts match the spec: Repos, Code", async () => {
    const home = await loading("/");
    expect(home).toContain('<p role="status" class="sr-only">Loading repositories</p>');
    expect(home).toMatch(/<div class="tb-in">.*placeholder="Search repositories" aria-label="Search repositories" disabled/);
    expect(count(home, 'class="card skel-card"')).toBe(4);
    // The aside: an empty ring (track only) and 4 tiles under their real labels.
    expect(home).toMatch(/<h3>Token budget<\/h3>.*<svg class="ring"[^>]*><circle[^>]*><\/circle><text[^>]*><\/text><\/svg>/);
    expect(count(home, '<div class="tile flat"><div class="l">')).toBe(4);
    expect(home).toContain('<div class="l">Changes merged</div>');

    const code = await loading("/acme%2Fweb/code/develop");
    expect(code).toContain('<p role="status" class="sr-only">Loading code</p>');
    expect(code).toMatch(/<div class="toolbar code-bar"><form role="search"><input[^>]*disabled/);
    expect(count(code, '<div class="panel cmd"><div class="panel-head"><h2>Commits</h2><span class="bone"')).toBe(1);
    expect(count(code, '<li class="skel-row" style="padding-left:')).toBe(12);
    expect(code).toContain('style="padding-left:32px"'); // indented
    expect(count(code, '<div class="cl"><span class="ln"><span class="bone"')).toBe(24);
    const rail = code.split("<h2>Active in acme/web</h2>")[1];
    expect(count(rail, "<li>")).toBe(3);
  });

  it("Code's skeleton toolbar renders the same toolbar class and the Add file, Clone and New change bones as the loaded toolbar", async () => {
    const bar = (await loading("/acme%2Fweb/code/develop")).match(/<div class="toolbar code-bar">(.*?)<\/div>/)[1];
    expect(bar).toMatch(/^<form role="search"><input[^>]*disabled/);
    expect([...bar.matchAll(/<button type="button" class="btn (btn-\w+)" disabled="">.*?([\w ]+)<\/button>/g)].map((m) => [m[1], m[2]]))
      .toEqual([["btn-secondary", "Add file"], ["btn-secondary", "Clone"], ["btn-primary", "New change"]]);
  });
});
