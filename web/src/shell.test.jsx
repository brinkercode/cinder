import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import accounts from "../../worker/src/api/fixtures/account-list.json";
import branches from "../../worker/src/api/fixtures/branches.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, doc, El } from "./fake-dom.js";

// fake-dom's globals must exist before React loads.
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { prerender } = await import("react-dom/static");
const { createMemoryRouter, createStaticHandler, createStaticRouter, RouterProvider, StaticRouterProvider } = await import("react-router");
const { Shell } = await import("./shell.jsx");

// Every rule in app.css, @media bodies included (the 390px drawer), as [selector, declarations].
const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [sel.trim(), body.split(";")]);
const decl = (sel) => rules.filter(([s]) => s.split(",").includes(sel)).flatMap(([, body]) => body);

describe("shell", () => {
  // Runs before the prerender test: a client render after react-dom/static in the same module trips a nested-Router check.
  it("pressing R does not move focus to the repo row", async () => {
    const keys = [];
    vi.stubGlobal("window", Object.assign(globalThis, { addEventListener: (type, f) => type === "keydown" && keys.push(f), removeEventListener() {} }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
      children: [{ path: ":repo/*", id: "repo", loader: () => repos[1] }] }], { initialEntries: ["/acme%2Fweb/changes"] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const nodes = all(root);
    const row = nodes.find((n) => n.attrs.id === "sec-repo-row");
    let focused = false;
    row.focus = () => { focused = true; };
    doc.getElementById = (id) => nodes.find((n) => n.attrs?.id === id) ?? null;
    doc.querySelector = () => null;
    keys.forEach((f) => f({ key: "r", target: { closest: () => null }, preventDefault() {} }));
    expect(focused).toBe(false);
    vi.unstubAllGlobals();
  });

  it("Ctrl+K opens nothing and the top bar has no search field", async () => {
    const keys = [];
    vi.stubGlobal("window", Object.assign(globalThis, { addEventListener: (type, f) => type === "keydown" && keys.push(f), removeEventListener() {} }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
      children: [{ path: ":repo/*", id: "repo", loader: () => repos[1] }] }], { initialEntries: ["/acme%2Fweb/changes"] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const opened = [];
    for (const n of all(root)) if (n.nodeName === "DIALOG") n.showModal = () => opened.push(n.attrs.id);
    const ev = { key: "k", ctrlKey: true, defaultPrevented: false, target: { closest: () => null }, preventDefault() { ev.defaultPrevented = true; } };
    keys.forEach((f) => f(ev));
    expect(opened).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    // The branch menu's own "Find a branch" filter stays.
    expect(all(root).filter((n) => n.attrs?.["aria-label"] === "Search" || /qsearch/.test(n.attrs?.class ?? "") || n.attrs?.commandfor === "palette").map((n) => n.nodeName)).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("an open dialog survives the repo list loading", async () => {
    vi.stubGlobal("window", Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    let land;
    let open;
    // A page whose dialog is open while the root loader's repo list is still on its way.
    const Page = () => { const [o, setO] = useState(false); open = () => setO(true); return o && <dialog open>Edit pool</dialog>; };
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos: new Promise((r) => { land = r; }), needs: Promise.resolve([]) }),
      children: [{ index: true, element: <Page /> }] }]);
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    await act(async () => open());
    await act(async () => land(repos));
    expect(all(root).some((n) => n.nodeName === "DIALOG" && n.textContent === "Edit pool")).toBe(true);
    expect(all(root).some((n) => n.attrs?.id === "sec-repo-row")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("a repo page load fetches me/accounts, repos and branches once each", async () => {
    vi.stubGlobal("window", Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubEnv("VITE_FIXTURES", "0");
    const repo = repos[0], base = `/api/repos/${encodeURIComponent(repo.name)}`;
    const answers = { "/api/repos": repos, [base]: repo, "/api/me/accounts": accounts, [`${base}/branches`]: branches, "/api/keystore": { secrets: [], wanted: [] }, "/api/me": { email: null, owner: true } };
    const seen = [];
    vi.stubGlobal("fetch", async (url) => { seen.push(url); return url in answers ? Response.json(answers[url]) : Response.json([]); });
    const { routes } = await import("./routes.jsx");
    const router = createMemoryRouter(routes, { initialEntries: [`/${encodeURIComponent(repo.name)}/flows`] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    // The branch menu fetches once the browser is idle.
    await act(() => vi.waitFor(() => expect(seen).toContain(`${base}/branches`)));
    for (const url of ["/api/me/accounts", "/api/repos", `${base}/branches`]) expect(seen.filter((u) => u === url), url).toHaveLength(1);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("hovering a sidebar link prefetches that page's chunk", async () => {
    vi.stubGlobal("window", Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    const lazy = vi.fn(async () => ({ element: null }));
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
      children: [{ index: true }, { path: "needs", lazy }] }]);
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const side = all(root).find((n) => n.nodeName === "ASIDE");
    const link = all(side).find((n) => n.nodeName === "A" && n.attrs.href === "/needs");
    link.closest = () => link;
    expect(lazy).not.toHaveBeenCalled();
    const e = { type: "mouseover", target: link, bubbles: true, preventDefault() {}, stopPropagation() {} };
    await act(async () => { for (let n = link; n; n = n.parentNode) for (const f of n.listeners.mouseover ?? []) f(e); });
    expect(lazy).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("the sidebar has no disabled stub entries", async () => {
    const handler = createStaticHandler([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]), me: Promise.resolve({}) }) }]);
    const context = await handler.query(new Request("http://cinder.test/"));
    const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
    const html = await new Response(prelude).text();
    const menu = html.match(/<div class="sb-menu">.*?(?=<div class="sb-footer")/)[0];
    expect(menu.match(/class="stub"/g)).toHaveLength(6);
    expect(menu.match(/<a class="stub" href="https:\/\/dash\.cloudflare\.com\//g)).toHaveLength(6);
    expect(menu).not.toContain("aria-disabled");
    for (const l of ["Recents", "Domains", "Images &amp; Stream", "Realtime", "Application security", "Networking", "Monetize", "Delivery &amp; performance", "Manage account"]) {
      expect(html, l).not.toContain(`<span>${l}</span>`);
    }
  });

  it("sidebar items set no background on hover or when selected", () => {
    const side = rules.filter(([sel]) => /\.(stub|sec-head|nav a|ctx)\b/.test(sel));
    expect(side.length).toBeGreaterThan(0);
    const fills = side.flatMap(([sel, body]) => body.filter((d) => /^background/.test(d) && !/:(none|transparent)$/.test(d)).map((d) => `${sel} ${d}`));
    expect(fills).toEqual([]);
  });

  it("a selected sidebar item's icon and arrow use the white token and an unselected one's the grey", () => {
    for (const sel of [".stub>.ico", ".sec-head>.ico", ".nav a>.ico", ".ctx .ico"]) expect(decl(sel), sel).toContain("color:var(--sb-muted)");
    for (const sel of ['.nav a[aria-current="page"]>.ico', '.sec:has([aria-current="page"])>.sec-head>.ico', ".nav a:hover>.ico", ".sec-head:hover>.ico", ".stub:hover>.ico", ".ctx-r:hover .ico", ".ctx-b:hover .ico"]) {
      expect(decl(sel), sel).toContain("color:var(--sb-icon-on)");
    }
    // An opacity on the icon would keep a "white" icon grey.
    expect(rules.filter(([sel, body]) => /\.(stub|sec-head|nav a|ctx)\b.*\.ico/.test(sel) && body.some((d) => d.startsWith("opacity")))).toEqual([]);
    const tokens = readFileSync(new URL("styles/tokens.css", import.meta.url), "utf8");
    expect(tokens.match(/\.dark\{[^}]*\}/)[0]).toContain("--sb-icon-on:oklch(100% 0 0)");
  });

  it("the target switcher keeps the last 12 characters at 390 px", () => {
    // Only the Mid head may shrink: a cap or clip on the switch cuts the tail, and the repo name gives way first.
    const sw = decl(".switch");
    expect(sw.filter((d) => /^(max-width|overflow|text-overflow):/.test(d))).toEqual([]);
    expect(decl(".mid .t")).toContain("flex:none");
    expect(decl(".crumb .cur")).toEqual(expect.arrayContaining(["min-width:0", "flex-shrink:99"]));
  });

  it("the mobile drawer's sidebar is the drawer's full 280 px", () => {
    // The sidebar draws its own border; one on the dialog too leaves the sidebar 279 px.
    const drawer = decl("dialog.drawer");
    expect(drawer).toContain("width:280px");
    expect(drawer.filter((d) => /^border-(right|left):/.test(d))).toEqual([]);
  });

});
