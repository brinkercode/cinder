import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import changes from "../../worker/src/api/fixtures/changes.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

// Monaco can't run on the fake DOM: whether its failed load reached the page before a test's clicks was down to timing.
vi.mock("./monaco.jsx", () => ({ default: () => null, colorize: () => Promise.reject(new Error("no monaco in tests")) }));

const { act, Profiler } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Code, codeLoader } = await import("./code.jsx");
const { forgetTrees } = await import("./client.js");

const repo = repos[0];
const REMOTE = "https://artifacts.example/cinder/web.git";
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const API = {
  [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", remote: REMOTE, entries: [
    { name: "README.md", path: "README.md", type: "blob" }, { name: "src", path: "src", type: "tree" }, { name: "app.js", path: "src/app.js", type: "blob" }] },
  [`${base}/changes`]: [],
  [`${base}/branches`]: [],
  [`${base}/file?ref=main&path=README.md`]: { ref: "main", sha: "m1", path: "README.md", size: 4, content: "# hi" },
  [`${base}/lease-map`]: { conflicts: { merges: 0, conflicted: 0, days: 7 }, changes: [], leases: [], edges: [] },
  [`${base}/log?ref=main&page=1`]: { ref: "main", sha: "m1", path: "", commits: [{ sha: "m1", message: "Add README", author: "ana" }], more: false, total: 1 },
};

// Globals stay stubbed: fake-dom.js stubs window and document once per file, and each test re-stubs fetch.
// Pages stay mounted, so the trees they keep are dropped here as leaving the page does.
afterEach(() => { vi.unstubAllEnvs(); forgetTrees(); });

describe("code page (live)", () => {
  it("the Code page renders the live tree and the clone popover copies the URL", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    // The live-ticket request never answers, so the page's event socket never opens.
    vi.stubGlobal("fetch", (url) => (API[url] ? Promise.resolve(Response.json(API[url])) : new Promise(() => {})));
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
      { path: "code/:ref/*", element: <Code />, loader: codeLoader }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/code/main`] });
    const root = doc.body.appendChild(new El("div"));
    const r = createRoot(root);
    onTestFinished(() => act(() => r.unmount())); // stops its live listeners, as leaving the page does
    await act(async () => r.render(<RouterProvider router={router} />));

    const files = all(root).find((n) => n.attrs["aria-label"] === "Files");
    expect(files.textContent).toContain("README.md");
    expect(files.textContent).toContain("app.js");
    expect(all(root).filter((n) => n.nodeName === "CODE").map((n) => n.textContent)).toContain(REMOTE);

    await act(async () => click(all(root).find((n) => n.attrs["aria-label"] === "Copy clone URL")));
    expect(writeText).toHaveBeenCalledWith(REMOTE);
  });

  // Renders /code/:ref against api, with fetch answering only the listed paths (404 bodies given as [404, body]).
  let router;
  let onCommit = () => {}; // runs after every React commit of the page
  const render = async (ref, api) => {
    forgetTrees(); // a new mount starts with nothing kept, as after leaving the page
    vi.stubEnv("VITE_FIXTURES", "0");
    const store = new Map();
    vi.stubGlobal("sessionStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) });
    vi.stubGlobal("fetch", (url) => {
      const r = api[url];
      if (!r) return new Promise(() => {});
      return Promise.resolve(r[0] === 404 ? Response.json(r[1], { status: 404 }) : Response.json(r));
    });
    router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
      { path: "code/:ref/*", element: <Code />, loader: codeLoader }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/code/${ref}`] });
    const root = doc.body.appendChild(new El("div"));
    const r = createRoot(root);
    onTestFinished(() => act(() => r.unmount())); // stops its live listeners, as leaving the page does
    await act(async () => r.render(<Profiler id="code" onRender={() => onCommit()}><RouterProvider router={router} /></Profiler>));
    return root;
  };
  const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
  const byClass = (root, c) => all(root).filter((n) => n.attrs.class === c);
  const log = (ref, commits, total = commits.length) => ({ [`${base}/log?ref=${ref}&page=1`]: { ref, sha: commits[0].sha, path: "", commits, more: false, total } });

  it("Commits rows stay on one line at every width", async () => {
    const commits = Array.from({ length: 12 }, (_, i) => ({ sha: `${i}`.padEnd(40, "c"), message: `Commit ${i} with a long message\n\nCinder-Change: c-${i}`, author: "ana" }));
    const root = await render("main", { ...API, ...log("main", commits) });
    const card = all(root).find((n) => n.attrs.class === "panel cmd");
    expect(card.textContent).toContain("Latest: 0cccccc Commit 0 with a long message12 commits");
    const rows = () => all(card).filter((n) => n.nodeName === "TR");
    expect(rows()).toHaveLength(10);
    // One line per row: every cell is nowrap, the message ellipsizes, and a narrow card hides author and change instead of wrapping.
    expect(rows()[0].childNodes.map((td) => td.attrs.class ?? "")).toEqual(["mono", "msg", "", ""]);
    expect(rows()[0].textContent).toBe("0ccccccCommit 0 with a long messageanac-0");
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    expect(css).toContain(".tbl.cm td{padding:7px var(--s-4);white-space:nowrap}.tbl.cm td.msg{max-width:0;width:100%;overflow:hidden;text-overflow:ellipsis}");
    expect(css).toContain("@container (max-width:760px){.tbl.cm td:nth-child(3),.tbl.cm td:nth-child(4){display:none}}");
    // The pager moves to page 2, and the page persists for the session.
    await act(async () => click(all(card).find((n) => n.nodeName === "BUTTON" && n.textContent === "2")));
    await settle();
    expect(rows().map((r) => r.childNodes[0].textContent)).toEqual(["10ccccc", "11ccccc"]);
    expect(sessionStorage.getItem(`cinder.code.commits.page.${repo.name}`)).toBe("2");
  });

  it("Lease bands match the lease map in real time", async () => {
    const map = (symbol) => ({ conflicts: { merges: 0, conflicted: 0, days: 7 }, edges: [],
      changes: [{ id: "c_01", state: "draft", intent: "Run faster", seam: false, stacked_on: null }],
      leases: [{ symbol: `src/app.js#${symbol}`, file: "src/app.js", holder: "c_01", mode: "exclusive", waiting: [] }] });
    const api = { ...API, ...log("main", [{ sha: "m1", message: "Add app", author: "ana" }]),
      [`${base}/changes`]: changes.filter((c) => c.id === "c_01"),
      [`${base}/lease-map`]: map("run"),
      [`${base}/file?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", size: 12, content: "a\nb\nc\nd\ne\nf" },
      [`${base}/symbols?target=main`]: { sha: "m1", symbols: [{ path: "src/app.js", name: "run", kind: "function", start: 2, end: 3 }, { path: "src/app.js", name: "stop", kind: "function", start: 5, end: 6 }] },
      [`${base}/authorship?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", lines: null },
      [`${base}/log?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", commits: [], more: false },
      "/api/live-ticket": { ticket: "t1" },
    };
    const sockets = [];
    vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("WebSocket", class { constructor() { sockets.push(this); } close() {} });
    const root = await render("main/src/app.js", api);
    await settle();
    const banded = () => byClass(root, "cl leased exclusive agent").map((n) => n.childNodes[0].textContent);
    expect(banded()).toEqual(["2", "3"]);
    expect(byClass(root, "tr-l agent").map((n) => n.attrs.title)).toEqual(["Leased by c_01"]);
    // The lease moves to stop: the next live event refetches and the band follows.
    api[`${base}/lease-map`] = map("stop");
    await act(async () => sockets[0].onmessage({ data: "{}" }));
    await settle();
    expect(banded()).toEqual(["5", "6"]);
  });

  it("Blame with lines null renders the not computed yet note", async () => {
    const api = { ...API, ...log("main", [{ sha: "m1", message: "Add app", author: "ana" }]),
      [`${base}/file?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", size: 3, content: "a\nb" },
      [`${base}/symbols?target=main`]: { sha: "m1", symbols: [] },
      [`${base}/authorship?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", lines: null },
      [`${base}/log?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", commits: [], more: false },
    };
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main/src/app.js?v=blame", api);
    expect(all(root).find((n) => n.attrs.role === "status" && n.nodeName === "P").textContent).toContain("Blame not computed yet. It is queued");
    expect(byClass(root, "codev")).toHaveLength(1);
    expect(byClass(root, "bl")).toHaveLength(0);
  });

  it("Active in repo with 100 changes renders at most the cap, a See all link and titles not UUIDs", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `0b5c2e1a-1111-4222-8333-${String(i).padStart(12, "0")}`);
    const api = { ...API, ...log("main", [{ sha: "m1", message: "Add README", author: "ana" }]),
      [`${base}/changes`]: ids.map((id, i) => ({ ...changes[0], id, state: "draft", intent: `Title ${i}` })),
      [`${base}/lease-map`]: { conflicts: { merges: 0, conflicted: 0, days: 7 }, edges: [],
        changes: ids.map((id, i) => ({ id, state: "draft", intent: `Title ${i}`, seam: false, stacked_on: null })),
        leases: ids.map((id) => ({ symbol: "src/app.js#run", file: "src/app.js", holder: id, mode: "shared", waiting: [] })) },
    };
    const root = await render("main", api);
    const rail = all(root).find((n) => n.nodeName === "ASIDE");
    const rows = all(rail).filter((n) => n.nodeName === "LI");
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(rows.slice(0, 3).map((r) => r.childNodes[0].textContent)).toEqual(["Title 0", "Title 1", "Title 2"]);
    expect(rail.textContent).not.toContain(ids[0]);
    expect(rail.textContent).toContain("src/app.js · run");
    const all100 = all(rail).find((n) => n.nodeName === "A" && n.textContent === "See all 100");
    expect(all100.attrs.href).toBe(`/${encodeURIComponent(repo.name)}/changes`);
  });

  it("the Commits card reads 1 commit for one commit and 2 commits for two", async () => {
    const one = await render("main", { ...API, ...log("main", [{ sha: "m1", message: "Add README", author: "ana" }]) });
    expect(byClass(one, "end").find((n) => n.nodeName === "SPAN").textContent).toBe("1 commit");
    const two = await render("main", { ...API, ...log("main", [{ sha: "m2", message: "Edit", author: "ana" }, { sha: "m1", message: "Add README", author: "ana" }]) });
    expect(byClass(two, "end").find((n) => n.nodeName === "SPAN").textContent).toBe("2 commits");
  });

  it("Switching the branch dropdown to a change workspace shows that tree", async () => {
    const ws = "0b5c2e1a-1111-4222-8333-444455556666";
    const root = await render("main", { ...API, ...log("main", [{ sha: "m1", message: "Add README", author: "ana" }]),
      [`${base}/tree?ref=${ws}&path=&recursive=1`]: { ref: ws, sha: "w1", path: "", entries: [{ name: "ws.js", path: "ws.js", type: "blob" }] },
      ...log(ws, [{ sha: "w1", message: "Workspace edit", author: "dev@v3" }]) });
    // The dropdown's workspace item is a link to /code/<change id>.
    await act(() => router.navigate(`/${encodeURIComponent(repo.name)}/code/${ws}`));
    await settle();
    const files = all(root).find((n) => n.attrs["aria-label"] === "Files");
    expect(files.textContent).toContain("ws.js");
    expect(files.textContent).not.toContain("app.js");
    expect(all(root).find((n) => n.attrs.class === "panel cmd").textContent).toContain(`${ws.slice(0, 8)}Latest: w1 Workspace edit1 commit`);
  });

  it("opening a file URL asks for the whole tree in one request and the file alongside it", async () => {
    // The tree never answers; every URL the page asks for is recorded.
    const urls = [], rest = { ...API, [`${base}/tree?ref=main&path=&recursive=1`]: undefined };
    await render("main/README.md", new Proxy(rest, { get: (api, url) => { urls.push(url); return api[url]; } }));
    expect(urls.filter((u) => u.includes("/tree?"))).toEqual([`${base}/tree?ref=main&path=&recursive=1`]);
    expect(urls).toContain(`${base}/file?ref=main&path=README.md`);
  });

  it("clicking a file in Code does not refetch tree levels already loaded, and the viewer keeps the previous file, aria-busy, while the file fetch is pending", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main", API);
    const fetches = vi.spyOn(globalThis, "fetch");
    await act(async () => click(all(root).find((n) => n.nodeName === "A" && n.textContent === "app.js")));
    expect(fetches.mock.calls.map(([url]) => url)).toContain(`${base}/file?ref=main&path=src%2Fapp.js`); // never answers
    expect(fetches.mock.calls.filter(([url]) => url.includes("/tree?"))).toEqual([]);
    expect(all(root).find((n) => n.attrs["aria-label"] === "Files").textContent).toContain("README.md");
    const viewer = all(root).find((n) => n.nodeName === "SECTION" && n.attrs["aria-busy"] === "true");
    expect(viewer.textContent).toContain("src/app.js");
    expect(viewer.textContent).toContain("hi");
    expect(all(viewer).filter((n) => n.attrs.class === "bone")).toEqual([]);
  });

  // app.js's file and symbols answer; its history (log?path=) and authorship never do.
  const appFile = { [`${base}/file?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", size: 9, content: "const app" },
    [`${base}/symbols?target=main`]: { sha: "m1", symbols: [] } };
  const viewer = (root) => all(root).find((n) => n.attrs.class === "codev");

  it("with the history and authorship fetches held pending, switching files renders the new file's content", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main", { ...API, ...appFile });
    await act(async () => click(all(root).find((n) => n.nodeName === "A" && n.textContent === "app.js")));
    await settle();
    expect(viewer(root).textContent).toContain("const app");
  });

  it("a file switch issues no tree request and no log?page=1 request; switching back to a seen file issues no file request", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main/src/app.js", { ...API, ...appFile,
      [`${base}/file?ref=main&path=README.md`]: { ref: "main", sha: "m1", path: "README.md", size: 4, content: "# hi" } });
    await settle();
    const fetches = vi.spyOn(globalThis, "fetch");
    await act(() => router.navigate(`/${encodeURIComponent(repo.name)}/code/main/README.md?v=source`));
    await settle();
    expect(viewer(root).textContent).toContain("# hi");
    await act(async () => click(all(root).find((n) => n.nodeName === "A" && n.textContent === "app.js")));
    await settle();
    expect(viewer(root).textContent).toContain("const app");
    const urls = fetches.mock.calls.map(([url]) => url);
    expect(urls.filter((u) => u.includes("/tree?") || u.includes("page=1"))).toEqual([]);
    expect(urls).not.toContain(`${base}/file?ref=main&path=src%2Fapp.js`);
  });

  it("switching between two cached files never renders the skeleton or an empty viewer", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main/src/app.js", { ...API, ...appFile });
    await act(() => router.navigate(`/${encodeURIComponent(repo.name)}/code/main/README.md?v=source`));
    await settle();
    // Both files are cached now: every commit of the next two switches is checked.
    const seen = [];
    // The file body: the file card past its header.
    const body = () => all(root).find((n) => n.attrs.class === "panel fcard")?.childNodes.slice(1).map((n) => n.textContent).join("");
    const check = () => seen.push(all(root).some((n) => n.attrs.class === "bone") ? "skeleton" : !body() ? "empty" : "ok");
    onCommit = check;
    try {
      await act(async () => click(all(root).find((n) => n.nodeName === "A" && n.textContent === "app.js")));
      await settle();
      expect(viewer(root).textContent).toContain("const app");
      await act(async () => click(all(root).find((n) => n.nodeName === "A" && n.textContent === "README.md")));
      await settle();
      expect(body()).toContain("hi");
    } finally {
      onCommit = () => {};
    }
    expect(new Set(seen)).toEqual(new Set(["ok"]));
  });

  it("the tree and file header elements are the same DOM nodes before and after a file switch", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main", { ...API, ...appFile });
    const tree = () => all(root).find((n) => n.attrs["aria-label"] === "Files");
    const header = () => all(root).find((n) => n.attrs.class === "panel fcard").childNodes[0];
    const [t, h] = [tree(), header()];
    await act(async () => click(all(root).find((n) => n.nodeName === "A" && n.textContent === "app.js")));
    await settle();
    expect(viewer(root).textContent).toContain("const app");
    expect(tree()).toBe(t);
    expect(header()).toBe(h);
    expect(h.textContent).toContain("src/app.js");
  });

  it("a lease/change live event doesn't clear the file or tree cache; a head-sha change reloads the tree", async () => {
    const api = { ...API, ...appFile, "/api/live-ticket": { ticket: "t1" } };
    const sockets = [];
    vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("WebSocket", class { constructor() { sockets.push(this); } close() {} });
    const root = await render("main/src/app.js", api);
    await settle();
    const fetches = vi.spyOn(globalThis, "fetch");
    for (const kind of ["lease", "created"]) await act(async () => sockets[0].onmessage({ data: JSON.stringify({ kind }) }));
    await settle();
    const urls = () => fetches.mock.calls.map(([url]) => url);
    // Only the head check: the whole tree, never the file.
    expect(urls().filter((u) => u.includes("/tree?") || u.includes("/file?"))).toEqual([`${base}/tree?ref=main&path=&recursive=1`, `${base}/tree?ref=main&path=&recursive=1`]);
    expect(viewer(root).textContent).toContain("const app");
    // main moves to m2 and gains src/new.js: the next event reads the tree again.
    const was = API[`${base}/tree?ref=main&path=&recursive=1`];
    api[`${base}/tree?ref=main&path=&recursive=1`] = { ...was, sha: "m2", entries: [...was.entries, { name: "new.js", path: "src/new.js", type: "blob" }] };
    await act(async () => sockets[0].onmessage({ data: JSON.stringify({ kind: "pushed" }) }));
    await settle();
    expect(all(root).find((n) => n.attrs["aria-label"] === "Files").textContent).toContain("new.js");
  });

  it("with the commits log request held pending, the file content renders", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const api = { ...API, ...appFile };
    delete api[`${base}/log?ref=main&page=1`]; // never answers
    const root = await render("main/src/app.js", api);
    await settle();
    expect(viewer(root).textContent).toContain("const app");
  });

  it("switching files with lease-map held unresolved still renders the new file's content", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const api = { ...API, ...appFile };
    delete api[`${base}/lease-map`]; // never answers
    const root = await render("main", api);
    await act(() => router.navigate(`/${encodeURIComponent(repo.name)}/code/main/src/app.js`));
    await settle();
    expect(viewer(root).textContent).toContain("const app");
  });

  it("switching between two files of the same repo and ref requests changes, lease-map and symbols once, not twice", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main/src/app.js", { ...API, ...appFile });
    await settle();
    const fetches = vi.spyOn(globalThis, "fetch");
    await act(() => router.navigate(`/${encodeURIComponent(repo.name)}/code/main/README.md?v=source`));
    await settle();
    expect(viewer(root).textContent).toContain("# hi");
    const urls = fetches.mock.calls.map(([url]) => url);
    expect(urls.filter((u) => /\/(changes|lease-map|symbols)/.test(u))).toEqual([]);
  });

  it("while the file request is pending, the viewer has aria-busy=\"true\"", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const api = { ...API, ...appFile };
    const root = await render("main/src/app.js", api);
    await settle();
    // A live event drops the kept trees; on a slow connection the tree and file requests then hang.
    forgetTrees();
    for (const k of Object.keys(api)) if (k.includes("/tree?") || k.includes("/file?")) delete api[k];
    await act(async () => click(all(root).find((n) => n.nodeName === "A" && n.textContent === "README.md")));
    expect(router.state.location.pathname).toBe(`/${encodeURIComponent(repo.name)}/code/main/README.md`);
    const files = all(root).find((n) => n.attrs["aria-label"] === "Files");
    expect(all(files).find((n) => n.attrs["aria-current"] === "page").textContent).toBe("README.md");
    expect(all(root).find((n) => n.nodeName === "SECTION" && n.attrs["aria-busy"] === "true").textContent).toContain("README.md");
  });

  it("an empty repo's tree returns 200 with empty:true and the Code tab shows Quick setup with no console error", async () => {
    const consoleError = vi.spyOn(console, "error");
    const root = await render("develop", {
      [`${base}/tree?ref=develop&path=&recursive=1`]: { ref: "develop", sha: null, path: "", entries: [], empty: true },
      [`${base}/changes`]: [],
    });
    expect(root.textContent).toContain("Quick setup");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("an unknown ref returns 404 ref_not_found and the Code tab falls back to the default branch", async () => {
    const root = await render("develop", {
      ...API,
      [`${base}/tree?ref=develop&path=&recursive=1`]: [404, { error: { code: "ref_not_found", message: "unknown ref develop" } }],
      [base]: repo,
    });
    expect(all(root).find((n) => n.attrs["aria-label"] === "Files").textContent).toContain("app.js");
    expect(all(root).find((n) => n.attrs.role === "status").textContent).toContain("Branch not found: develop. Showing main");
  });

  // One change c_01 holding a file lease and a symbol lease on src/app.js; card is merged over its fixture.
  const leased = (card) => ({ ...API, ...log("main", [{ sha: "m1", message: "Add app", author: "ana" }]),
    [`${base}/changes`]: [{ ...changes[0], ...card }],
    [`${base}/lease-map`]: { conflicts: { merges: 0, conflicted: 0, days: 7 }, edges: [], changes: [{ id: "c_01", state: "draft", intent: "Run faster", seam: false, stacked_on: null }],
      leases: ["src/app.js", "src/app.js#run"].map((symbol) => ({ symbol, file: "src/app.js", holder: "c_01", mode: "exclusive", waiting: [] })) },
    [`${base}/file?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", size: 3, content: "a\nb" },
    [`${base}/symbols?target=main`]: { sha: "m1", symbols: [{ path: "src/app.js", name: "run", kind: "function", start: 1, end: 2 }] },
    [`${base}/authorship?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", lines: null },
    [`${base}/log?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", more: false,
      commits: [{ sha: "m1".padEnd(40, "0"), message: "Add app", author: "ana", date: new Date(Date.now() - 2 * 86400e3 - 1000).toISOString() }] },
  });

  it("a change holding a symbol lease and a file lease renders one Active row", async () => {
    const root = await render("main", leased({ intent: "Run faster" }));
    const rows = all(all(root).find((n) => n.nodeName === "ASIDE")).filter((n) => n.nodeName === "LI");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Run faster")]);
    expect(rows[0].textContent).toContain("src/app.js · run");
  });

  it("an agent-driven change renders its agent as holder with the agent lease class", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main/src/app.js", leased({ agent: "dev", ver: "v3" }));
    expect(all(root).find((n) => n.nodeName === "ASIDE").textContent).toContain("run · dev@v3");
    expect(byClass(root, "cl leased exclusive agent").map((n) => n.childNodes[0].textContent)).toEqual(["1", "2"]);
    // Once a person takes over, they hold it with the human lease class.
    const person = await render("main/src/app.js", leased({ agent: "dev", ver: "v3", driver: "ana@example.com" }));
    expect(all(person).find((n) => n.nodeName === "ASIDE").textContent).toContain("run · ana@example.com · person");
    expect(byClass(person, "cl leased exclusive human")).toHaveLength(2);
  });

  it("?v=commits with no sha renders a commit list", async () => {
    const commits = Array.from({ length: 12 }, (_, i) => ({ sha: `${i}`.padEnd(40, "c"), message: `Commit ${i}`, author: "ana" }));
    const root = await render("main?v=commits", { ...API, ...log("main", commits) });
    const view = all(root).find((n) => n.nodeName === "SECTION");
    expect(view.textContent).toContain("Commits on main");
    expect(all(view).filter((n) => n.nodeName === "TR")).toHaveLength(10);
    expect(view.textContent).toContain("Showing 1–10 of 12");
  });

  it("History rows render an age from the log date", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main/src/app.js?v=history", leased({}));
    const row = all(all(root).find((n) => n.nodeName === "SECTION")).find((n) => n.nodeName === "LI");
    expect(byClass(row, "meta end").map((n) => n.textContent)).toEqual(["2d"]);
  });

  it("leaving with staged files asks about staged files", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const root = await render("main/README.md?v=edit", { ...API, [`${base}/symbols?target=main`]: { sha: "m1", symbols: [] } });
    await act(async () => click(all(root).find((n) => n.nodeName === "BUTTON" && n.textContent === "Stage delete")));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await act(async () => router.navigate(`/${encodeURIComponent(repo.name)}/code/develop`));
    expect(confirm).toHaveBeenCalledWith("Leave without proposing? Your staged files will be lost.");
  });
});
