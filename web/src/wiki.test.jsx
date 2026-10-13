import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import history from "../../worker/src/api/fixtures/wiki-history.json";
import { routes } from "./routes.jsx";
import { Wiki, wikiAction, wikiLoader } from "./wiki.jsx";

const PAGE = "/wiki/acme%2Fweb/p-arch";
const API = "/api/repos/acme%2Fweb/wiki";
const tree = [{ id: "p-arch", parent_id: null, title: "Architecture", slug: "architecture", type: "page", sort_order: 1, agent_context: false, children: [] }];
const row = { id: "p-arch", repo_id: "r-web", parent_id: null, title: "Architecture", slug: "architecture", type: "page", content: "# Architecture\nLeases first.",
  sort_order: 1, view_count: 4, created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-04T16:20:00.000Z",
  agent_context: false, words: 2, read_minutes: 1, views: 3, toc: [] };

const api = (patch, { pages = tree, page = row } = {}) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  const fetch = vi.fn(async (url, init) => {
    if (url === "/api/repos") return Response.json(repos);
    if (init?.method === "PATCH") return patch;
    if (init?.method === "POST" && url === `${API}/pages`) return Response.json({ ...row, id: "p-new", title: "Untitled" }, { status: 201 });
    if (url === `${API}/tree`) return Response.json(pages);
    if (url === `${API}/pages/p-arch/history`) return Response.json(history);
    if (url === `${API}/pages/p-arch/comments`) return Response.json([]);
    if (url.startsWith(`${API}/pages/p-arch/diff?`)) return Response.json({ from: 2, to: 3, lines: [" # Architecture", "-Leases.", "+Leases first."] });
    if (url === `${API}/pages/p-arch`) return Response.json(page);
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const render = async (request) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(request);
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  return new Response(prelude).text();
};
const text = (html) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// A client render (fake-dom) of the open page, before any server render in this file: a leftover static router context
// would nest the routers. afterEach drops fake-dom's globals, so each mount puts them back.
const mount = async (patch, over) => {
  const { all, click, doc, El } = await import("./fake-dom.js");
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = api(patch, over);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const router = createMemoryRouter([{ path: "/wiki/:repo/:id?", element: <Wiki />, loader: wikiLoader, action: wikiAction }], { initialEntries: [PAGE] });
  const root = createRoot(doc.body.appendChild(new El("div")));
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  const nodes = () => all(doc.body);
  return { act, click, doc, fetch, nodes, unmount: () => act(async () => root.unmount()) };
};

describe("wiki reading view", () => {
  it("the table of contents scrolls the .main scroller, not window", async () => {
    const { act, click, doc, nodes, unmount } = await mount(undefined, { page: { ...row, content: "# Architecture\n## Lease queue\nText.", toc: [{ level: 2, text: "Lease queue", anchor: "lease-queue" }] } });
    const heading = { textContent: "Lease queue", getBoundingClientRect: () => ({ top: 400 }) };
    const main = { scrollTop: 100, getBoundingClientRect: () => ({ top: 50 }), querySelectorAll: (s) => (s === ".wk-doc h3" ? [heading] : []), scrollTo: vi.fn() };
    doc.querySelector = (s) => (s === ".main" ? main : null);
    vi.stubGlobal("scrollTo", vi.fn());
    try {
      await act(async () => click(nodes().find((n) => n.nodeName === "A" && n.attrs.href === "#lease-queue")));
      expect(main.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: "smooth" });
      expect(globalThis.scrollTo).not.toHaveBeenCalled();
    } finally {
      delete doc.querySelector;
      await unmount();
    }
  });

  it("toggling agent context flips at once and rolls back when the PATCH fails", async () => {
    let answer;
    const { act, click, fetch, nodes, unmount } = await mount(new Promise((r) => { answer = r; }));
    const toggle = () => nodes().find((n) => n.attrs.role === "switch");
    const chip = () => nodes().some((n) => n.attrs.class === "wk-agc");
    expect([toggle().checked, chip()]).toEqual([false, false]);
    await act(async () => click(toggle()));
    expect([toggle().checked, chip()]).toEqual([true, true]); // before the PATCH answers
    expect(fetch).toHaveBeenCalledWith(`${API}/pages/p-arch`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ agent_context: true }) }));
    await act(async () => answer(Response.json({ error: { code: "internal", message: "D1 down" } }, { status: 500 })));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect([toggle().checked, chip()]).toEqual([false, false]);
    expect(nodes().find((n) => n.attrs.role === "alert").textContent).toContain("500 D1 down");
    await unmount();
  });
});

describe("wiki page", () => {
  it("saving posts text with base_sha and shows a 409 conflict message", async () => {
    const fetch = api(Response.json({ error: { code: "stale", message: "page is at version 4, not 3" } }, { status: 409 }));
    const html = await render(new Request(`http://cinder.test${PAGE}?v=edit`, { method: "POST",
      body: new URLSearchParams({ base_version: "3", content: "# Architecture\nMine.", message: "Rewrite" }) }));
    expect(fetch).toHaveBeenCalledWith(`${API}/pages/p-arch`, expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ content: "# Architecture\nMine.", message: "Rewrite", base_version: 3 }) }));
    expect(text(html)).toContain("Conflict: someone saved this page since you opened it.");
  });

  it("the editor toolbar shows icon buttons with accessible names", async () => {
    api();
    const html = await render(new Request(`http://cinder.test${PAGE}?v=edit`));
    const bar = html.match(/<div class="wk-etb">(.*?)<span class="end">/)[1];
    const buttons = [...bar.matchAll(/<button[^>]*aria-label="([^"]+)" title="([^"]+)"[^>]*>(.*?)<\/button>/g)];
    expect(buttons.map((b) => [b[1], b[2]])).toEqual([["Bold", "Bold (Ctrl B)"], ["Italic", "Italic (Ctrl I)"], ["Heading", "Heading"], ["List", "List"],
      ["Quote", "Quote"], ["Code", "Code"], ["Link", "Link (Ctrl K)"], ["Table", "Table"]]);
    for (const b of buttons) {
      expect(b[3], b[1]).toMatch(/^<svg/);
      expect(text(b[3]).trim(), b[1]).toBe(""); // an icon, not the word
    }
  });

  it("history renders from a fixture", async () => {
    const fetch = api();
    const t = text(await render(new Request(`http://cinder.test${PAGE}?v=history`)));
    for (const s of ["v3 current Document the lease queue owner · 2026-10-04", "v2 agent:dev · 2026-10-03", "v1 First draft owner · 2026-10-01",
      "v2 → v3 +1 −1", "# Architecture −Leases. +Leases first."]) expect(t).toContain(s);
    expect(fetch).toHaveBeenCalledWith(`${API}/pages/p-arch/diff?from=2&to=3`);
  });

  it("the page renders tree, reading column and rail, and the rail shows edited by, views, words and read time", async () => {
    api();
    const html = await render(new Request(`http://cinder.test${PAGE}`));
    expect(html).toMatch(/<div class="wk"><nav class="wk-nav" aria-label="Pages">.*<\/nav><div class="frame f-measure">.*<\/div><aside class="wk-rail" aria-label="Page details">/);
    const rail = text(html.split('<aside class="wk-rail"')[1]);
    for (const s of ["Edited by owner", "Views 3", "Words 2", "Read time 1 min"]) expect(rail).toContain(s);
  });

  it("the agent context toggle shows about N tokens within 10% of /wiki/context's tokens for that page", async () => {
    const content = "# Архитектура\nОчереди аренды идут первыми.";
    // GET /wiki/context with only this page flagged: tokens = ceil(77 bytes / 4); a count by characters would say 11.
    const context = { pages: [{ id: "p-arch", title: "Architecture", path: "architecture", content }], tokens: 20, truncated: false };
    api(undefined, { page: { ...row, content } });
    const n = Number(/about (\d+) tokens added to each plan/.exec(text(await render(new Request(`http://cinder.test${PAGE}`))))[1]);
    expect(Math.abs(n - context.tokens)).toBeLessThanOrEqual(context.tokens * 0.1);
  });

  it("agent-context pages carry the robot mark in the tree", async () => {
    api(undefined, { pages: [...tree, { ...tree[0], id: "p-ctx", title: "Context", slug: "context", agent_context: true }] });
    const nav = (await render(new Request(`http://cinder.test${PAGE}`))).split('<nav class="wk-nav"')[1].split("</nav>")[0];
    expect(nav.match(/class="wt-a"/g)).toHaveLength(1);
    expect(nav).toMatch(/<span>Context<\/span><i class="wt-a" title="Agent context"><svg/);
  });

  it("the tree marks the current page with aria-current and no self-link", async () => {
    api(undefined, { pages: [...tree, { ...tree[0], id: "p-ops", title: "Ops", slug: "ops" }] });
    const nav = (await render(new Request(`http://cinder.test${PAGE}`))).split('<nav class="wk-nav"')[1].split("</nav>")[0];
    expect(nav).toMatch(/<span class="wt-r"[^>]*aria-current="page"><svg[^>]*>.*?<span>Architecture<\/span><\/span>/);
    expect(nav).not.toContain('href="/wiki/acme%2Fweb/p-arch"');
    expect(nav).toMatch(/<a class="wt-r"[^>]*href="\/wiki\/acme%2Fweb\/p-ops"/);
  });

  it("the sidebar Wiki link opens /wiki", async () => {
    api();
    const nav = (await render(new Request(`http://cinder.test${PAGE}`))).split('<nav class="nav" aria-label="Git">')[1].split("</nav>")[0];
    expect(nav).toMatch(/<a [^>]*href="\/wiki"[^>]*>.*?<span>Wiki<\/span><\/a>/);
  });

  it("the tree shows folder rows with child counts that collapse", async () => {
    api(undefined, { pages: [{ ...tree[0], id: "p-guides", title: "Guides", slug: "guides", children: [{ ...tree[0], parent_id: "p-guides" }] }] });
    const nav = (await render(new Request(`http://cinder.test${PAGE}`))).split('<nav class="wk-nav"')[1].split("</nav>")[0];
    // A <details> row: the summary click collapses and expands its children; the chevron turns with it.
    expect(nav).toMatch(/<details open=""><summary class="wt-r wt-f"[^>]*><i class="wt-tw"><svg.*?<\/svg><\/i><svg.*?<\/svg><a href="\/wiki\/acme%2Fweb\/p-guides"[^>]*>Guides<\/a><small>1<\/small><\/summary><ul><li><span class="wt-r"[^>]*aria-current="page">/);
  });

  it("the empty wiki shows Write the first page", async () => {
    api(undefined, { pages: [] });
    const html = await render(new Request(`http://cinder.test/wiki/acme%2Fweb`));
    expect(text(html)).toContain("Write the first page");
    expect(html).toMatch(/name="intent" value="create"\/><input type="hidden" name="title" value="Untitled"\/><button type="submit" class="btn btn-primary">Write the first page/);
  });

  it("New page creates an untitled page under the current folder and opens the editor", async () => {
    const folder = { id: "f-guides", parent_id: null, title: "Guides", slug: "guides", type: "folder", sort_order: 1, agent_context: false, children: [{ ...tree[0], parent_id: "f-guides" }] };
    const fetch = api(undefined, { pages: [folder], page: { ...row, parent_id: "f-guides" } });
    const html = await render(new Request(`http://cinder.test${PAGE}`));
    expect(html).toContain('<input type="hidden" name="intent" value="create"/><input type="hidden" name="title" value="Untitled"/><input type="hidden" name="parent_id" value="f-guides"/><button type="submit" class="btn btn-secondary w">');
    const res = await createStaticHandler(routes).query(new Request(`http://cinder.test${PAGE}`, { method: "POST",
      body: new URLSearchParams({ intent: "create", title: "Untitled", parent_id: "f-guides" }) }));
    expect(fetch).toHaveBeenCalledWith(`${API}/pages`, expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "Untitled", content: "", parent_id: "f-guides" }) }));
    expect(res.headers.get("Location")).toBe("/wiki/acme%2Fweb/p-new?v=edit");
  });
});
