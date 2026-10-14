import { readFileSync } from "node:fs";
import { repoAt } from "./fake-repos.js";
import { prerender } from "react-dom/static";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import branches from "../../worker/src/api/fixtures/branches.json";
import lm from "../../worker/src/api/fixtures/lease-map.json";
import board from "../../worker/src/api/fixtures/board.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import changes from "../../worker/src/api/fixtures/changes.json";
import { forgetTrees } from "./client.js";
import { leaveGuard } from "./code.jsx";
import { editorOptions } from "./lib/code-metrics.js";
import { routes } from "./routes.jsx";

const page = async (path, render) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  return render(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
};
const settled = (el) => prerender(el).then(({ prelude }) => new Response(prelude).text());
const text = (html) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
const api = (status, body) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (url) => (repoAt(url) ? Response.json(repoAt(url)) : new Response(JSON.stringify(body), { status })));
};
const FILE = "/acme%2Fweb/code/c-1042/src/headers/normalize.rs";
// What every live Code page reads besides its tree and file: no leases and main's one-commit log.
const noLeases = { conflicts: { merges: 0, conflicted: 0, days: 7 }, changes: [], leases: [], edges: [] };
const card = (repo, head) => ({ [`${repo}/lease-map`]: noLeases, [`${repo}/log?ref=main&page=1`]: { ref: "main", sha: head, path: "", commits: [], more: false, total: 0 } });
// Monaco needs a browser; the fake renders the props the page hands it.
// The last editor's onChange is globalThis.monacoChange, for a client test to type with.
vi.mock("./monaco.jsx", () => ({ default: ({ path, value, options, onChange, leases = [] }) => <>{void (globalThis.monacoChange = onChange)}<pre data-monaco={options.readOnly ? "view" : "edit"} data-path={path} aria-label={options.ariaLabel}>{value}</pre>{leases.map((l) => l.strip)}</> }));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); forgetTrees(); });

describe("code page", () => {
  it("the Code toolbar links Releases with the latest tag chip, and no chip when the repo has no tags", async () => {
    // A client render (fake-dom), first in the file: the tag is read in an effect once the browser is idle, and a server
    // render's leftover router context would make this one a nested router.
    const { all, doc, El } = await import("./fake-dom.js");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { RouterProvider } = await import("react-router");
    const { Code, codeLoader } = await import("./code.jsx");
    const roots = [];
    const bar = async (tags) => {
      live();
      const inner = globalThis.fetch;
      vi.stubGlobal("fetch", async (url, init) => (url === "/api/repos/acme%2Fweb/tags?limit=1" ? Response.json(tags) : inner(url, init)));
      const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repos.find((r) => r.name === "acme/web"), children: [
        { path: "code/:ref/*", element: <Code />, loader: codeLoader }] }], { initialEntries: ["/acme%2Fweb/code/main"] });
      const root = doc.body.appendChild(new El("div"));
      roots.push(createRoot(root));
      await act(async () => roots.at(-1).render(<RouterProvider router={router} />));
      await act(() => new Promise((r) => setTimeout(r, 0)));
      const toolbar = all(root).find((n) => n.attrs.class === "toolbar code-bar");
      return toolbar.childNodes.filter((n) => n.nodeName === "A").map((a) => [a.attrs.href, a.textContent, all(a).find((c) => c.attrs.class === "bcount mono")?.textContent]);
    };
    const newest = { name: "v2.14.0", sha: "a".repeat(40), message: "v2.14.0", tagger: "owner", created_at: "2026-10-04T09:00:00Z" };
    expect((await bar([newest])).slice(0, 2)).toEqual([["/acme%2Fweb/releases", "Releasesv2.14.0", "v2.14.0"], ["/acme%2Fweb/code/main?v=new", "Add file", undefined]]);
    expect((await bar([]))[0]).toEqual(["/acme%2Fweb/releases", "Releases", undefined]);
    await act(async () => roots.forEach((r) => r.unmount()));
  });

  it("a staged submit that hits a lease offers the choice", async () => {
    // Client render, before any server render (see above). c_01 holds `run` in app.js; deleting app.js touches it.
    const { all, click, doc, El } = await import("./fake-dom.js");
    // fake-dom stubs these once, on import; the first test's afterEach removed them.
    for (const [k, v] of [["IS_REACT_ACT_ENVIRONMENT", true], ["document", doc], ["window", globalThis]]) vi.stubGlobal(k, v);
    El.prototype.querySelectorAll = () => []; // React restores a clicked radio's group through it
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { RouterProvider } = await import("react-router");
    const { Code, codeAction, codeLoader } = await import("./code.jsx");
    // acme/kv: the first test kept acme/web's lease map.
    const repo = repos.find((r) => r.name === "acme/kv"), base = "/api/repos/acme%2Fkv", posts = [];
    const api = {
      "/api/repos": repos,
      [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", entries: [{ name: "app.js", path: "app.js", type: "blob" }] },
      [`${base}/file?ref=main&path=app.js`]: { ref: "main", sha: "m1", path: "app.js", size: 11, content: "l1\nl2\nl3" },
      [`${base}/symbols?target=main`]: { sha: "m1", symbols: [{ path: "app.js", name: "run", kind: "function", start: 2, end: 3 }] },
      [`${base}/changes`]: [{ ...changes[0], id: "c_01", state: "draft", intent: "Run faster" }],
      [`${base}/lease-map`]: { ...noLeases, changes: [{ id: "c_01", state: "draft", intent: "Run faster", seam: false, stacked_on: null }],
        leases: [{ symbol: "app.js#run", file: "app.js", holder: "c_01", expires_at: "2099-01-01T00:30:00.000Z", mode: "exclusive", waiting: [] }] },
      [`${base}/log?ref=main&page=1`]: { ref: "main", sha: "m1", path: "", commits: [], more: false, total: 0 },
    };
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("fetch", async (url, init) => {
      if (init?.method !== "POST") return Response.json(api[url] ?? []);
      if (url !== "/api/live-ticket") posts.push([url, JSON.parse(init.body ?? "null")]);
      return Response.json({ id: "c-9", fork: "f", target_branch: "main" }, { status: 201 });
    });
    const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
      { path: "code/:ref/*", element: <Code />, loader: codeLoader, action: codeAction }] }], { initialEntries: ["/acme%2Fkv/code/main/app.js?v=edit"] });
    const root = doc.body.appendChild(new El("div")), r = createRoot(root);
    await act(async () => r.render(<RouterProvider router={router} />));
    for (let i = 0; i < 3; i++) await act(() => new Promise((res) => setTimeout(res, 0)));
    const find = (pred) => all(root).find(pred);
    const button = (t) => find((n) => n.nodeName === "BUTTON" && n.textContent === t);
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Stage delete")));
    const form = find((n) => n.nodeName === "FORM" && n.attrs.class === "stg-f");
    // The fake form has no fields for FormData to read; the stub answers the typed message.
    const Real = FormData;
    vi.stubGlobal("FormData", class { get = (k) => (k === "intent" ? "Move app" : null); });
    const e = { type: "submit", target: form, currentTarget: form, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    await act(async () => { for (let n = form; n; n = n.parentNode) for (const f of n.listeners.submit ?? []) f(e); });
    vi.stubGlobal("FormData", Real);
    expect(find((n) => n.attrs["aria-label"] === "Lease held").textContent).toContain("run lines 2–3 is leased by c_01");
    expect(posts).toEqual([]);
    await act(async () => click(all(root).find((n) => n.nodeName === "LABEL" && n.textContent.startsWith("Run in parallel")).childNodes[0]));
    await act(async () => click(button("Continue")));
    for (let i = 0; i < 3; i++) await act(() => new Promise((res) => setTimeout(res, 0)));
    expect(posts[0]).toEqual([`${base}/changes`, { intent: "Move app", target_branch: "main", choice: "parallel" }]);
    await act(async () => r.unmount());
  });

  it("a file switch marks the tree and heading at once and sets aria-busy until the file lands", async () => {
    // Client render under the shell (before any server render, see above): the shell's branch trigger awaits the page too.
    const { all, click, doc, El } = await import("./fake-dom.js");
    for (const [k, v] of [["IS_REACT_ACT_ENVIRONMENT", true], ["document", doc], ["window", globalThis]]) vi.stubGlobal(k, v);
    Object.assign(El.prototype, { showModal() {}, close() {} });
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { RouterProvider } = await import("react-router");
    const { Code, codeLoader } = await import("./code.jsx");
    const { Shell } = await import("./shell.jsx");
    const repo = repos.find((r) => r.name === "acme/kv"), base = "/api/repos/acme%2Fkv";
    const api = {
      [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", entries: [{ name: "a.js", path: "a.js", type: "blob" }, { name: "b.js", path: "b.js", type: "blob" }] },
      [`${base}/file?ref=main&path=a.js`]: { ref: "main", sha: "m1", path: "a.js", size: 1, content: "a" },
      [`${base}/changes`]: [], [`${base}/lease-map`]: noLeases, [`${base}/symbols?target=main`]: { sha: "m1", symbols: [] },
    };
    let land;
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("fetch", (url) => (url === `${base}/file?ref=main&path=b.js` ? new Promise((r) => { land = () => r(Response.json({ ...api[`${base}/file?ref=main&path=a.js`], path: "b.js", content: "b" })); })
      : api[url] ? Promise.resolve(Response.json(api[url])) : new Promise(() => {})));
    const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }), children: [
      { path: ":repo", id: "repo", loader: () => repo, children: [{ path: "code/:ref/*", element: <Code />, loader: codeLoader }] }] }], { initialEntries: ["/acme%2Fkv/code/main/a.js"] });
    const root = doc.body.appendChild(new El("div")), r = createRoot(root);
    await act(async () => r.render(<RouterProvider router={router} />));
    for (let i = 0; i < 3; i++) await act(() => new Promise((res) => setTimeout(res, 0)));
    const files = () => all(root).find((n) => n.attrs["aria-label"] === "Files");
    const card = () => all(root).find((n) => n.nodeName === "SECTION" && n.attrs.class?.includes("fcard"));
    await act(async () => click(all(files()).find((n) => n.nodeName === "A" && n.textContent === "b.js")));
    expect(all(files()).find((n) => n.attrs["aria-current"] === "page")?.textContent).toBe("b.js");
    expect(all(card()).find((n) => n.nodeName === "H2").textContent).toBe("b.js");
    expect(card().attrs["aria-busy"]).toBe("true");
    await act(async () => land());
    for (let i = 0; i < 3; i++) await act(() => new Promise((res) => setTimeout(res, 0)));
    expect(card().attrs["aria-busy"]).toBeUndefined();
    await act(async () => r.unmount());
  });

  // Client render (before any server render, see above) of acme/kv's orders.go on main in Edit, where c_01 holds leases; posts collects every POST.
  const editLeased = async (leases, symbols) => {
    const { all, doc, El } = await import("./fake-dom.js");
    for (const [k, v] of [["IS_REACT_ACT_ENVIRONMENT", true], ["document", doc], ["window", globalThis]]) vi.stubGlobal(k, v);
    El.prototype.querySelectorAll = () => [];
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { RouterProvider } = await import("react-router");
    const { Code, codeAction, codeLoader } = await import("./code.jsx");
    const repo = repos.find((r) => r.name === "acme/kv"), base = "/api/repos/acme%2Fkv", posts = [];
    const api = {
      "/api/repos": repos,
      [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", entries: [{ name: "orders.go", path: "orders.go", type: "blob" }] },
      [`${base}/file?ref=main&path=orders.go`]: { ref: "main", sha: "m1", path: "orders.go", size: 40, content: "package kv\nfunc (o *Order) Place() {\n}\n" },
      [`${base}/symbols?target=main`]: { sha: "m1", symbols },
      [`${base}/changes`]: [{ ...changes[0], id: "c_01", state: "draft", intent: "Place faster", agent_version: "patch@3.3.0" }],
      [`${base}/lease-map`]: { ...noLeases, changes: [{ id: "c_01", state: "draft", intent: "Place faster", seam: false, stacked_on: null }],
        leases: leases.map((symbol) => ({ symbol, file: "orders.go", holder: "c_01", expires_at: "2099-01-01T00:30:00.000Z", mode: "exclusive", waiting: [] })) },
      [`${base}/log?ref=main&page=1`]: { ref: "main", sha: "m1", path: "", commits: [], more: false, total: 0 },
    };
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("fetch", async (url, init) => {
      if (init?.method !== "POST") return Response.json(api[url] ?? []);
      if (url !== "/api/live-ticket") posts.push(url);
      return Response.json({ id: "c-9", fork: "f", target_branch: "main" }, { status: 201 });
    });
    const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
      { path: "code/:ref/*", element: <Code />, loader: codeLoader, action: codeAction }] }], { initialEntries: ["/acme%2Fkv/code/main/orders.go?v=edit"] });
    const root = doc.body.appendChild(new El("div")), r = createRoot(root);
    await act(async () => r.render(<RouterProvider router={router} />));
    for (let i = 0; i < 3; i++) await act(() => new Promise((res) => setTimeout(res, 0)));
    const find = (pred) => all(root).find(pred);
    // Fires a form's submit listeners up to the root, as a submit button would.
    const submit = (form) => act(async () => {
      const e = { type: "submit", target: form, currentTarget: form, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
      for (let n = form; n; n = n.parentNode) for (const f of n.listeners.submit ?? []) f(e);
    });
    const prompt = () => find((n) => n.attrs["aria-label"] === "Lease held")?.textContent ?? "";
    return { act, find, submit, prompt, posts, editForm: () => find((n) => n.nodeName === "FORM" && n.textContent.includes("Open a change")), unmount: () => act(async () => r.unmount()) };
  };

  it("an edit inside a leased symbol shows the lease prompt before Open change", async () => {
    // The lease names the method scoped (Order.Place); the index names it Place.
    const { act, find, submit, prompt, posts, editForm, unmount } = await editLeased(["orders.go#Order.Place"], [{ path: "orders.go", name: "Place", kind: "method", start: 2, end: 3 }]);
    expect(find((n) => n.attrs.class === "lrow").textContent).toBe("Placeleased by c_01 · patch@3.3.0 · exclusive");
    await act(async () => globalThis.monacoChange("package kv\nfunc (o *Order) Place() { o.n++ }\n}\n"));
    await submit(editForm());
    expect(prompt()).toContain("Place lines 2–3 is leased by c_01");
    expect(posts).toEqual([]);
    await unmount();
  });

  it("deleting or renaming a leased file shows the lease prompt", async () => {
    // A file lease (symbol is the path) on a file the index has no symbols for.
    let s = await editLeased(["orders.go"], []);
    const path = s.find((n) => n.attrs["aria-label"] === "Rename or move to");
    Object.assign(path, { type: "text", value: "order.go" }); // a real input without a type attribute is text
    await s.act(async () => { for (let n = path; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f({ type: "input", target: path, bubbles: true, stopPropagation() {} }); });
    await s.submit(s.editForm());
    expect(s.prompt()).toContain("orders.go lines 1–4 is leased by c_01");
    await s.unmount();
    forgetTrees();
    s = await editLeased(["orders.go"], []);
    const { click } = await import("./fake-dom.js");
    await s.act(async () => click(s.find((n) => n.nodeName === "BUTTON" && n.textContent === "Stage delete")));
    const Real = FormData;
    vi.stubGlobal("FormData", class { get = (k) => (k === "intent" ? "Drop orders" : null); });
    await s.submit(s.find((n) => n.nodeName === "FORM" && n.attrs.class === "stg-f"));
    vi.stubGlobal("FormData", Real);
    expect(s.prompt()).toContain("orders.go lines 1–4 is leased by c_01");
    expect(s.posts).toEqual([]);
    await s.unmount();
  });
  it("the Clone popover names no cinder subcommand the CLI lacks", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const cli = readFileSync(new URL("../../runner/cmd/cinder/main.go", import.meta.url), "utf8");
    const known = new Set([...cli.matchAll(/cmd == "([a-z-]+)|args\[0\] == "([a-z-]+)"/g)].map((m) => m[1] ?? m[2]));
    expect(known).toContain("change");
    // A workspace page: the popover once offered a command for it.
    const pop = (await page(FILE, settled)).split('id="clone-pop"')[1];
    expect(text(pop)).toContain("Clone over HTTPS");
    for (const [, sub] of text(pop).matchAll(/\bcinder ([a-z-]+)/g)) expect(known).toContain(sub);
  });

  it("code page: renders every element the page doc lists from fixtures", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
    const html = await page(FILE, settled);
    const t = text(html);
    for (const s of ["Clone", "New change", "https://git.nimbus.dev/acme/web.git", "cinder repo credentials", "Push a branch",
      "git push origin my-branch", "Propose straight from git",
      "Workspace of c-1042 · patch@3.2.1 · conflict", "The agent is driving. Take over to edit here, or message it.", "Take over",
      "Files c-1042", "src headers normalize.rs", "src/ headers/ normalize.rs 29 lines", "Code Blame History",
      "continue; // keep original case on h1 hops",
      "Live on this file", "Preserve case of X-Forwarded-* headers during normalization fn normalize_headers · patch@3.2.1"]) expect(t).toContain(s);
    // Toolbar: full-width search, then Clone and New change; no ref select, no path breadcrumb, no Two ways in.
    expect(html).toMatch(/<div class="toolbar code-bar"><form[^>]*role="search"[^>]*><input class="input w" type="search"/);
    expect(t).toMatch(/Clone New change Clone over HTTPS https/);
    for (const gone of ["<select", 'aria-label="Path"', "Two ways in"]) expect(html).not.toContain(gone);
    expect(html).toContain('<details class="ft-d" open="">');
    expect(html).toMatch(/aria-current="page"[^>]*>.*normalize\.rs<\/span><span class="tr-l agent" title="Leased by c-\d+" aria-hidden="true">/);
    expect(html).toContain('<div class="codev" role="region" aria-label="src/headers/normalize.rs" tabindex="0">');
    expect(html).toContain('<div class="cl leased exclusive agent"><span class="ln">5</span>');

    const blame = await page("/acme%2Fweb/code/develop/src/headers/normalize.rs?v=blame", settled);
    expect(blame).toContain('class="codev blame"');
    expect(text(blame)).toContain("fn normalize_headers leased by c-1042 · patch@3.2.1 · exclusive · 1 waiting");
    expect(blame).toContain('<div class="cl leased exclusive agent"><span class="ln">5</span>');
    expect(blame).toContain('<span class="c-kw">pub</span> <span class="c-kw">fn</span>');
    expect(text(blame)).toContain("4 c-1039 patch@3.2.1");
    expect(text(blame)).toContain("15 c-0987 ren · person");
    expect(text(blame)).toContain("Propose straight from git git push origin HEAD:refs/for/develop");

    const history = text(await page("/acme%2Fweb/code/develop/src/headers/normalize.rs?v=history", settled));
    expect(history).toContain("5d1e0b2 c-0987 ren · person 9d Move hop-by-hop list to a const verified · risk was 4% Jev");

    const readme = await page("/acme%2Fweb/code/develop", settled);
    expect(readme).toContain('<div class="md"><h2>edge-router</h2>');
    expect(readme).toContain("<h3>How changes land here</h3><ul><li>");
    expect(readme).toContain("<code>cinder.toml</code>");
    expect(readme).toContain('<pre class="code md-pre">cargo test --workspace');
    expect(text(readme)).toContain("Active in acme/web live Preserve case of X-Forwarded-* headers during normalization patch@3.2.1 · src/headers/normalize.rs · fn normalize_headers Introduce RouteMatcher");
    // Four leases from three changes: one row per change, all within the cap.
    expect(text(readme)).not.toMatch(/See all \d/);
    expect(text(await page("/acme%2Fweb/code/develop/cinder.toml", settled))).toContain("Live on this file live No one holds a lease here. Edit freely; your change takes the leases it needs.");
    expect(text(await page("/acme%2Fweb/code/develop/Cargo.toml", settled))).toContain("File Cargo.toml not found It may have been merged and archived, or the link is wrong. Back to files");
  });

  it("code page: empty, loading and error states render as the doc describes", async () => {
    // A ref with no commits: the tree is 404 and the repo has no changes.
    api(200, []);
    const fetch404 = globalThis.fetch;
    vi.stubGlobal("fetch", async (url) => (url.includes("/tree?") ? new Response("{}", { status: 404 }) : fetch404(url)));
    const empty = await page("/acme%2Fweb/code/develop", settled);
    expect(text(empty)).toContain("Quick setup acme/web is empty. Push an existing project, or create the first file here.");
    expect(empty).toMatch(/<a class="btn btn-primary" href="\/acme%2Fweb\/code\/develop\?v=new"[^>]*>.*Create a README<\/a>/);

    vi.stubEnv("VITE_FIXTURES", "1");
    const loading = await page("/acme%2Fweb/code/develop", renderToString);
    expect(loading).toContain('aria-busy="true"');
    expect(text(loading)).toContain("Loading code");

    api(503, { error: "unavailable" });
    const error = await page("/acme%2Fweb/code/develop", settled);
    expect(text(error)).toContain("Couldn't load code The API didn't answer.");
    expect(error).toContain("<pre>GET /api/repos/acme%2Fweb/tree?ref=develop&amp;path=&amp;recursive=1: HTTP 503</pre>");
    expect(error).toMatch(/<button[^>]*>.*Retry<\/button>/);
  });

  it("Take over posts and the banner switches to \"you are driving\"", async () => {
    // A fixtures build posts nothing, so the action's write runs live; the page then reloads from fixtures.
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const fetch = vi.fn(async () => { vi.stubEnv("VITE_FIXTURES", "1"); return Response.json({ id: "c-1042", driver: "owner" }); });
    vi.stubGlobal("fetch", fetch);
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request(`http://cinder.test${FILE}`, { method: "POST", body: new URLSearchParams({ op: "takeover" }) }));
    const t = text(await settled(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />));
    expect(fetch).toHaveBeenCalledWith("/api/changes/c-1042/takeover", expect.objectContaining({ method: "POST" }));
    expect(t).toContain("You are driving; the agent is paused.");
    expect(t).not.toContain("Take over");
  });

  it("edit and commit a file, and the commit appears in history after a reload", async () => {
    // An in-memory Worker: a commit moves main's head, changes the file and joins its log.
    let [head, content] = ["a".repeat(40), "one\n"];
    const commits = [{ sha: head, message: "Add a", author: "ana" }];
    const sent = [];
    const repo = `/api/repos/${encodeURIComponent("acme/web")}`;
    const at = (path) => `?ref=main&path=${encodeURIComponent(path)}`;
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url, init) => {
      if (init?.method === "POST" && url === `${repo}/commits`) {
        const body = JSON.parse(init.body);
        sent.push(body);
        [head, content] = ["b".repeat(40), body.changes[0].content];
        commits.unshift({ sha: head, message: body.message, author: "owner" });
        return Response.json({ branch: "main", sha: head, tree: "c".repeat(40) }, { status: 201 });
      }
      const routes = {
        [`${repo}/tree${at("")}&recursive=1`]: { ref: "main", sha: head, path: "", entries: [{ name: "src", path: "src", type: "tree" }, { name: "a.js", path: "src/a.js", type: "blob" }] },
        [`${repo}/file${at("src/a.js")}`]: { ref: "main", sha: head, path: "src/a.js", size: content.length, content },
        [`${repo}/authorship${at("src/a.js")}`]: { ref: "main", sha: head, path: "src/a.js", lines: null },
        [`${repo}/log${at("src/a.js")}`]: { ref: "main", sha: head, path: "src/a.js", commits, more: false },
        ...card(repo, head),
      };
      return Response.json(routes[url] ?? repoAt(url) ?? []);
    });
    const FILE_ON_MAIN = "/acme%2Fweb/code/main/src/a.js";
    expect(text(await page(`${FILE_ON_MAIN}?v=edit`, settled))).toContain("No edits yet Cancel Stage Open change");
    const res = await createStaticHandler(routes).query(new Request(`http://cinder.test${FILE_ON_MAIN}`,
      { method: "POST", body: new URLSearchParams({ op: "commit", base_sha: head, content: "two\n", intent: "Make a two" }) }));
    expect(sent).toEqual([{ branch: "main", base_sha: "a".repeat(40), message: "Make a two", changes: [{ path: "src/a.js", content: "two\n" }] }]);
    expect(res.headers.get("Location")).toBe(`${FILE_ON_MAIN}?v=history`);
    const history = text(await page(res.headers.get("Location"), settled));
    expect(history).toContain("bbbbbbb owner · person Make a two aaaaaaa ana · person Add a");
  });

  it("Add file on main shows the integration_branch error and main gains no commit", async () => {
    // An in-memory Worker that refuses commits onto main, as the commit API does for an integration branch.
    const head = "a".repeat(40);
    const commits = [{ sha: head, message: "Add a", author: "ana" }];
    const repo = `/api/repos/${encodeURIComponent("acme/web")}`;
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url, init) => {
      if (init?.method === "POST" && url === `${repo}/commits`) {
        return Response.json({ error: { code: "integration_branch", message: "main is an integration branch; open a change to land on it", hint: "open a change" } }, { status: 422 });
      }
      const routes = {
        [`${repo}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: head, path: "", entries: [{ name: "a.js", path: "a.js", type: "blob" }] },
        [`${repo}/log?ref=main&path=`]: { ref: "main", sha: head, path: "", commits, more: false },
        ...card(repo, head),
      };
      return Response.json(routes[url] ?? repoAt(url) ?? []);
    });
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request("http://cinder.test/acme%2Fweb/code/main?v=new",
      { method: "POST", body: new URLSearchParams({ op: "commit", base_sha: head, path: "b.js", content: "b\n", intent: "Add b" }) }));
    const t = text(await settled(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />));
    expect(t).toContain("422 main is an integration branch; open a change to land on it");
    // The refusal stays on the New file form instead of opening main's history.
    expect(context).not.toBeInstanceOf(Response);
    expect(t).toContain("Commit new file");
  });

  // A live repo on main holding README (no extension) and src/a.js; edits answer as change c-9.
  const live = () => {
    const sent = [];
    const repo = `/api/repos/${encodeURIComponent("acme/web")}`;
    const at = (path) => `?ref=main&path=${encodeURIComponent(path)}`;
    const file = (path, content) => ({ ref: "main", sha: "a".repeat(40), path, size: content.length, content });
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url, init) => {
      if (init?.method === "POST") {
        sent.push([url, JSON.parse(init.body)]);
        return Response.json({ id: "c-9" }, { status: 201 });
      }
      return Response.json({
        [`${repo}/tree${at("")}&recursive=1`]: { ref: "main", sha: "a".repeat(40), path: "", entries: [{ name: "README", path: "README", type: "blob" }, { name: "src", path: "src", type: "tree" },
          { name: "a.js", path: "src/a.js", type: "blob" }] },
        [`${repo}/file${at("README")}`]: file("README", "hello\n"),
        [`${repo}/file${at("src/a.js")}`]: file("src/a.js", "one\n"),
        [`${repo}/authorship${at("src/a.js")}`]: { ref: "main", sha: "a".repeat(40), path: "src/a.js", lines: null },
        [`${repo}/log${at("src/a.js")}`]: { ref: "main", sha: "a".repeat(40), path: "src/a.js", commits: [], more: false },
        ...card(repo, "a".repeat(40)),
      }[url] ?? repoAt(url) ?? []);
    });
    return sent;
  };

  it("Open a file, Edit in Monaco, Submit: a change is created with the edit", async () => {
    const sent = live();
    const FILE_ON_MAIN = "/acme%2Fweb/code/main/src/a.js";
    const html = await page(`${FILE_ON_MAIN}?v=edit`, settled);
    expect(html).toContain('<pre data-monaco="edit" data-path="src/a.js" aria-label="Edit src/a.js">one\n</pre>');
    expect(html).toContain('<input type="hidden" name="content" value="one\n"/>');
    const res = await createStaticHandler(routes).query(new Request(`http://cinder.test${FILE_ON_MAIN}`,
      { method: "POST", body: new URLSearchParams({ base_sha: "a".repeat(40), content: "two\n", intent: "Make a two" }) }));
    expect(sent).toEqual([["/api/repos/acme%2Fweb/changes/edit", { target: "main", path: "src/a.js", base_sha: "a".repeat(40), content: "two\n", intent: "Make a two" }]]);
    expect(res.headers.get("Location")).toBe("/acme%2Fweb/changes/c-9");
  });

  it("on a leased file, the lease strip renders in both View and Edit", async () => {
    const repo = `/api/repos/${encodeURIComponent("acme/web")}`;
    const at = (path) => `?ref=main&path=${encodeURIComponent(path)}`;
    const change = board.find((c) => c.id === "c-1042");
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url) => Response.json({
      [`${repo}/tree${at("")}&recursive=1`]: { ref: "main", sha: "a".repeat(40), path: "", entries: [{ name: "a.js", path: "a.js", type: "blob" }] },
      [`${repo}/file${at("a.js")}`]: { ref: "main", sha: "a".repeat(40), path: "a.js", size: 30, content: "// a\nfunction f() {\n  return 1;\n}\n" },
      [`${repo}/changes`]: [change],
      [`${repo}/symbols?target=main`]: { symbols: [{ path: "a.js", name: "f", start: 2, end: 4 }] },
      ...card(repo, "a".repeat(40)),
      [`${repo}/lease-map`]: { ...noLeases, changes: [{ ...lm.changes.find((c) => c.id === "c-1042"), stacked_on: null }], leases: [{ symbol: "f", file: "a.js", holder: "c-1042", mode: "exclusive", waiting: [] }] },
    }[url] ?? repoAt(url) ?? []));
    for (const v of ["", "?v=edit"]) {
      const html = await page(`/acme%2Fweb/code/main/a.js${v}`, settled);
      expect(text(html), v).toContain("f leased by c-1042 · patch@3.2.1 · exclusive");
      expect(html, v).toContain('<div class="lrow">');
    }
  });

  it("the loading fallback renders highlighted lines, not a bare pre", async () => {
    // A fresh code.jsx whose lazy editor hasn't loaded yet; renderToString doesn't wait for it, so it renders the fallback.
    // A query makes it a separate module: resetModules would also give later route loads a second client.js.
    const { CodeEditor } = await import("./code.jsx?fresh");
    const html = renderToString(<CodeEditor path="src/a.js" text={"const a = 1;\n"} setText={() => {}} />);
    expect(html).toMatch(/^<div class="mon">.*<div class="codev"><div class="codev-in" style="[^"]*"><div class="cl"><span class="ln">1<\/span><span class="src"><span class="c-kw">const<\/span> a = 1;<\/span><\/div>/s);
    expect(html).not.toContain("<pre");
  });

  it("a Dockerfile is highlighted as Dockerfile", async () => {
    const { CodeEditor } = await import("./code.jsx?dockerfile");
    const html = renderToString(<CodeEditor path="deploy/Dockerfile" text={"# build\nFROM node:22 AS build\n"} setText={() => {}} />);
    expect(html).toContain('<span class="c-cm"># build</span>');
    expect(html).toContain('<span class="c-kw">FROM</span> node:22 <span class="c-kw">AS</span> build');
  });

  it("extension-less files like Makefile and go.mod get their language", async () => {
    const { CodeEditor } = await import("./code.jsx?named");
    const make = renderToString(<CodeEditor path="Makefile" text={"# Build everything\n"} setText={() => {}} />);
    expect(make).toContain('<span class="c-cm"># Build everything</span>');
    const mod = renderToString(<CodeEditor path="runner/go.mod" text={"go 1.27\n"} setText={() => {}} />);
    expect(mod).toContain('<span class="c-kw">go</span> <span class="c-nm">1.27</span>');
  });

  it("stage 3 edits across 2 files plus a rename, submit: one change whose diff shows all of them", async () => {
    const sent = [];
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url, init) => {
      sent.push([url, JSON.parse(init.body ?? "null")]);
      return Response.json({ id: "c-9", fork: "acme/web--cc-9", target_branch: "main" }, { status: 201 });
    });
    // What the Staged files list posts: a.js edited twice (its entry holds the last edit), b.js edited, c.js renamed.
    const changes = [{ path: "src/a.js", content: "three\n" }, { path: "src/b.js", content: "two\n" }, { path: "src/c.js", delete: true }, { path: "lib/c.js", content: "c\n" }];
    const res = await createStaticHandler(routes).query(new Request("http://cinder.test/acme%2Fweb/code/main/src/a.js",
      { method: "POST", body: new URLSearchParams({ op: "submit", base_sha: "a".repeat(40), intent: "Edit a and b, move c", changes: JSON.stringify(changes) }) }));
    expect(sent).toEqual([
      ["/api/repos/acme%2Fweb/changes", { intent: "Edit a and b, move c", target_branch: "main" }],
      ["/api/changes/c-9/takeover", null],
      ["/api/repos/acme%2Fweb--cc-9/commits", { branch: "main", base_sha: "a".repeat(40), message: "Edit a and b, move c", changes }],
    ]);
    expect(res.headers.get("Location")).toBe("/acme%2Fweb/changes/c-9");
  });

  it("README at the repo root has an Edit button", async () => {
    live();
    const html = await page("/acme%2Fweb/code/main", settled);
    expect(html).toMatch(/<h2 class="mono"><span class="cur">README<\/span><\/h2><a class="btn btn-secondary btn-sm" href="\/acme%2Fweb\/code\/main\/README\?v=edit"[^>]*>Edit<\/a>/);
    expect(html).toContain('<div class="md"><p>hello</p>');
  });

  // A live acme/web holding develop, release/1.2 and feature/x (an integration branch, so the branch menu lists it); other refs are unknown.
  const slashRefs = () => {
    const urls = [];
    const sha = "a".repeat(40);
    forgetTrees();
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url) => {
      urls.push(url);
      const listed = repoAt(url, repos.map((r) => (r.name === "acme/web" ? { ...r, branch_policy: { ...r.branch_policy, integration: ["develop", "feature/x"] } } : r)));
      if (listed) return Response.json(listed);
      const u = new URL(url, "http://cinder.test");
      const [ref, path] = [u.searchParams.get("ref"), u.searchParams.get("path")];
      const kind = u.pathname.split("/").at(-1);
      if (kind === "tree" && !["release/1.2", "feature/x", "develop"].includes(ref)) return Response.json({ error: { code: "ref_not_found", message: `unknown ref ${ref}` } }, { status: 404 });
      return Response.json({
        tree: { ref, sha, path, entries: [{ name: "README.md", path: "README.md", type: "blob" }, { name: "src", path: "src", type: "tree" }, { name: "a.ts", path: "src/a.ts", type: "blob" }] },
        file: { ref, sha, path, size: 1, content: `${path} on ${ref}\n` },
        authorship: { ref, sha, path, lines: null },
        log: { ref, sha, path: path ?? "", commits: [], more: false, ...(path === null && { total: 0 }) },
        "lease-map": noLeases,
        branches: ["main", "release/1.2", "feature/x"].map((name) => ({ ...branches[0], name })),
      }[kind] ?? []);
    });
    return urls;
  };
  // Static asset serving answers a %2F in the path with a redirect to the same path with a plain "/".
  const follow = async (path) => {
    const handler = createStaticHandler(routes);
    let context = await handler.query(new Request(`http://cinder.test${path}`));
    if (context instanceof Response) context = await handler.query(new Request(`http://cinder.test${context.headers.get("Location")}`));
    return settled(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  };

  it("rendering /web-store/code/release%2F1.2 loads tree?ref=release/1.2 (encoded) and shows the root, not \"File 1.2 not found\"", async () => {
    for (const path of ["/acme%2Fweb/code/release%2F1.2", "/acme%2Fweb/code/release/1.2"]) {
      const urls = slashRefs();
      const t = text(await follow(path));
      expect(urls, path).toContain("/api/repos/acme%2Fweb/tree?ref=release%2F1.2&path=&recursive=1");
      expect(t, path).toContain("README.md on release/1.2");
      expect(t, path).not.toContain("not found");
    }
  });

  it("/web-store/code/release%2F1.2/src/a.ts opens file src/a.ts on release/1.2; links from the branch menu to feature/x round-trip to the same ref", async () => {
    for (const path of ["/acme%2Fweb/code/release%2F1.2/src/a.ts", "/acme%2Fweb/code/release/1.2/src/a.ts"]) {
      slashRefs();
      const html = await follow(path);
      expect(text(html), path).toContain("src/a.ts on release/1.2");
      const href = html.match(/href="([^"]*)"[^>]*>(?:(?!<\/a>).)*<span class="bm-n mono">feature\/x<\/span>/)[1];
      expect(href).toBe("/acme%2Fweb/code/feature%2Fx/src/a.ts");
      for (const to of [href, "/acme%2Fweb/code/feature/x/src/a.ts"]) {
        const urls = slashRefs();
        expect(text(await follow(to)), to).toContain("src/a.ts on feature/x");
        expect(urls, to).toContain("/api/repos/acme%2Fweb/file?ref=feature%2Fx&path=src%2Fa.ts");
      }
    }
  });

  it("the Commits card, lease strip, workspace note and branch menu render an 8-character change id with the full id in the tooltip", async () => {
    const id = "26ac977f-de5f-4c1a-9b9f-09dc970ce64e";
    const sha = "a".repeat(40);
    forgetTrees();
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url) => {
      if (repoAt(url)) return Response.json(repoAt(url));
      const u = new URL(url, "http://cinder.test");
      const [ref, path] = [u.searchParams.get("ref"), u.searchParams.get("path")];
      return Response.json({
        tree: { ref, sha, path, entries: [{ name: "a.ts", path: "a.ts", type: "blob" }] },
        file: { ref, sha, path, size: 1, content: "f\n" },
        authorship: { ref, sha, path, lines: null },
        log: { ref, sha, path: path ?? "", commits: [{ sha, message: `Edit\n\nCinder-Change: ${id}`, author: "ren" }], more: false, ...(path === null && { total: 1 }) },
        changes: [{ ...changes[0], id, repo_id: repos[0].id, state: "draft" }],
        symbols: { symbols: [{ path: "a.ts", name: "f", start: 1, end: 1 }] },
        "lease-map": { ...noLeases, changes: [{ id, state: "draft", intent: "Edit", seam: false, stacked_on: null }], leases: [{ symbol: "a.ts#f", file: "a.ts", holder: id, mode: "exclusive", waiting: [] }] },
      }[u.pathname.split("/").at(-1)] ?? []);
    });
    // The file arrives alongside the tree, before the repo-wide parts; with those loaded first the page renders once.
    await page(`/acme%2Fweb/code/${id}`, settled);
    const html = await page(`/acme%2Fweb/code/${id}/a.ts`, settled);
    const t = text(html);
    for (const s of ["Edit ren 26ac977f Showing", "leased by 26ac977f ·", "Workspace of 26ac977f ·", "Files 26ac977f a.ts", `Change workspaces 26ac977f ${changes[0].title}`]) expect(t).toContain(s);
    // Card header, commit row, Live on this file, lease strip, workspace strip, workspace note, Files header, branch menu.
    expect(html.split(`<span class="mono" title="${id}">26ac977f</span>`).length - 1).toBe(8);
  });

  it("loading a release/1.2 URL 404s only the direct read of its first segment", async () => {
    for (const path of ["/acme%2Fweb/code/release/1.2", "/acme%2Fweb/code/release/1.2/src/a.ts"]) {
      slashRefs();
      const inner = globalThis.fetch, missed = [];
      vi.stubGlobal("fetch", async (url) => { const r = await inner(url); if (r.status === 404) missed.push(url); return r; });
      expect(text(await follow(path)), path).toContain("on release/1.2");
      expect(missed, path).toEqual(["/api/repos/acme%2Fweb/tree?ref=release&path=&recursive=1"]);
    }
  });

  it("a 409 stale-base commit shows \"Someone committed first; reload to rebase your edit\"", async () => {
    live();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url, init) => (init?.method === "POST"
      ? Response.json({ error: { code: "conflict", message: `refs/heads/main is at ${"b".repeat(40)}, not ${"a".repeat(40)}` } }, { status: 409 })
      : inner(url, init)));
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request("http://cinder.test/acme%2Fweb/code/main/src/a.js?v=edit",
      { method: "POST", body: new URLSearchParams({ op: "commit", base_sha: "a".repeat(40), content: "two\n", intent: "Make a two" }) }));
    const t = text(await settled(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />));
    expect(t).toContain("Someone committed first; reload to rebase your edit");
    expect(t).not.toContain("409");
  });

  it("after falling back from a missing branch, the branch trigger shows the default branch", async () => {
    slashRefs();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url) => (url === "/api/repos/acme%2Fweb" ? Response.json({ ...repos.find((r) => r.name === "acme/web"), default_branch: "feature/x" }) : inner(url)));
    const html = await follow("/acme%2Fweb/code/no-such-branch");
    expect(text(html)).toContain("Branch not found: no-such-branch . Showing feature/x");
    expect(text(html.match(/title="Target branch">.*?<\/button>/)[0])).toContain("target feature/x");
  });

  it("a failed request's error line shows the request URL", async () => {
    api(200, []);
    vi.stubGlobal("fetch", async (url) => { if (url.includes("/tree?")) throw new TypeError("Failed to fetch"); return Response.json(repoAt(url) ?? []); });
    const html = await page("/acme%2Fweb/code/develop", settled);
    expect(html).toContain("<pre>GET /api/repos/acme%2Fweb/tree?ref=develop&amp;path=&amp;recursive=1: Failed to fetch</pre>");
  });


  it("leaving with unsaved edits asks for confirmation", async () => {
    const router = createMemoryRouter([{ path: "*", element: null }], { initialEntries: ["/r/code/main/a.js?v=edit"] });
    let dirty = "edits";
    router.getBlocker("edit", leaveGuard(() => dirty));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await router.navigate("/r/changes");
    expect(confirm).toHaveBeenCalledWith("Leave without proposing? Your edits will be lost.");
    expect(router.state.location.pathname).toBe("/r/code/main/a.js");
    confirm.mockReturnValue(true);
    await router.navigate("/r/changes");
    expect(router.state.location.pathname).toBe("/r/changes");
    dirty = false;
    confirm.mockClear();
    await router.navigate("/r/leases");
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/r/leases");
    router.dispose();
  });

  it("the line-number gutter keeps the spacing token's gap from the code in View and Edit", async () => {
    const tokens = readFileSync(new URL("styles/tokens.css", import.meta.url), "utf8");
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    const step = tokens.match(/--code-gap:var\((--s-\d+)\);/)?.[1];
    const px = Number(tokens.match(new RegExp(`${step}:(\\d+)px;`))?.[1]);
    expect(px).toBeGreaterThan(14);
    expect(tokens).toContain(`--code-gutter:calc(${editorOptions.lineNumbersMinChars}ch + var(--code-gap));`);
    expect(editorOptions.lineDecorationsWidth).toBe(px);
    expect(css).toContain(".cl{display:grid;grid-template-columns:var(--code-gutter) minmax(0,1fr)}");
    expect(css).toContain(".cl .ln{color:var(--text-subtle);text-align:right;padding-right:var(--code-gap);");
    vi.stubEnv("VITE_FIXTURES", "1");
    const html = await page(FILE, settled);
    expect(html).toContain('<span class="ln">1</span>');
    expect(html).not.toMatch(/--code-(gap|gutter):/);
  });

  it("code page: no color literal or font-family outside tokens.css", () => {
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    const tokens = readFileSync(new URL("styles/tokens.css", import.meta.url), "utf8");
    const defined = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
    const rules = css.slice(css.indexOf("/* Code. */"));
    expect(rules).toContain(".code-wrap{");
    for (const [name, src] of [["app.css code rules", rules], ["code.jsx", readFileSync(new URL("code.jsx", import.meta.url), "utf8")]]) {
      expect(src, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/);
      expect(src, name).not.toMatch(/font-family:\s*(?!var\(--font-)|fontFamily/);
      for (const [, v] of src.matchAll(/var\((--[\w-]+)/g)) expect(defined, `${name} ${v}`).toContain(v);
    }
  });

  it("a change holding a symbol lease and a file lease on the same file appears once in Live on this file", async () => {
    const change = { ...changes[4], agent: "developer", ver: "v7" };
    const lease = (symbol) => ({ symbol, file: "src/a.ts", holder: change.id, mode: "exclusive", waiting: [] });
    const live = { changes: [change], "lease-map": { ...noLeases, changes: [{ id: change.id, state: change.state, intent: change.intent, seam: false, stacked_on: null }],
      leases: [lease("src/a.ts"), lease("src/a.ts#applyDiscount")] } };
    slashRefs();
    const others = globalThis.fetch;
    vi.stubGlobal("fetch", async (url) => {
      const body = live[new URL(url, "http://cinder.test").pathname.split("/").at(-1)];
      return body ? Response.json(body) : others(url);
    });
    const t = text(await follow("/acme%2Fweb/code/release%2F1.2/src/a.ts"));
    expect(t).toContain(`Live on this file live ${change.id} developing ${change.intent} applyDiscount · developer@v7 `);
    expect(t.split(`${change.intent} `).length).toBe(2);
  });
});
