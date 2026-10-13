import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, doc, El } from "./fake-dom.js";

vi.mock("./monaco.jsx", () => ({ default: () => null, colorize: () => Promise.reject(new Error("no monaco in tests")) }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Code, codeLoader, codeRevalidate } = await import("./code.jsx");
const { forgetTrees, refreshCode } = await import("./client.js");

const repo = repos[0];
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const SHA = "c".repeat(40);
// Every request the page makes on main but /log: it stays pending, as does anything a test leaves out.
const API = {
  [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", entries: [{ name: "app.js", path: "app.js", type: "blob" }] },
  [`${base}/changes`]: [],
  [`${base}/branches`]: [],
  [`${base}/file?ref=main&path=app.js`]: { ref: "main", sha: "m1", path: "app.js", size: 9, content: "const app" },
  [`${base}/symbols?target=main`]: { sha: "m1", symbols: [] },
  [`${base}/lease-map`]: { conflicts: { merges: 0, conflicted: 0, days: 7 }, changes: [], leases: [], edges: [] },
  [`${base}/authorship?ref=main&path=app.js`]: { ref: "main", sha: "m1", path: "app.js", lines: null },
  [`${base}/commits/${SHA}?ref=main`]: { sha: SHA, parent: null, message: "Add app", author: "ana", files: [{ path: "app.js", status: "added", lines: ["+const app"] }] },
};

afterEach(() => { vi.unstubAllEnvs(); forgetTrees(); });

let router, urls;
async function open(at, api = API) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  urls = [];
  vi.stubGlobal("fetch", (url) => {
    urls.push(url);
    const r = api[url];
    return r instanceof Promise ? r : r ? Promise.resolve(Response.json(r)) : new Promise(() => {});
  });
  router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
    { path: "code/:ref/*", element: <Code />, loader: codeLoader, shouldRevalidate: codeRevalidate }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/code/main/${at}`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await settle();
  return root;
}
const settle = async () => { for (let i = 0; i < 3; i++) await act(() => new Promise((r) => setTimeout(r, 0))); };
const viewer = (root) => all(root).find((n) => n.attrs.class === "codev")?.textContent ?? "";

describe("code speed", () => {
  it("with /branches held pending, a deep link renders the file", async () => {
    const held = { ...API };
    delete held[`${base}/branches`];
    const root = await open("app.js", held);
    expect(viewer(root)).toContain("const app");
  });

  it("with /log held pending, the first load renders the file and a commit diff renders", async () => {
    const LOG = `${base}/log?ref=main&page=1`;
    const api = { ...API, [LOG]: { ref: "main", sha: "m1", path: "", commits: [{ sha: "m1", message: "First", author: "ana" }], more: false, total: 1 } };
    const root = await open("app.js", api);
    expect(viewer(root)).toContain("const app");
    expect(root.textContent).toContain("Latest: m1 First");
    // A commit lands: the page drops its kept tree and log, and the next log request stays pending.
    api[`${base}/tree?ref=main&path=&recursive=1`] = { ...API[`${base}/tree?ref=main&path=&recursive=1`], sha: "m2" };
    delete api[LOG];
    await act(() => refreshCode(repo.name));
    await act(() => router.navigate(`?v=commits&sha=${SHA}`));
    await settle();
    expect(router.state.location.search).toBe(`?v=commits&sha=${SHA}`);
    expect(all(root).some((n) => n.nodeName === "CODE" && n.textContent === SHA.slice(0, 7))).toBe(true);
  });

  it("opening a commit diff issues its request without waiting for the file request to resolve", async () => {
    await open(`app.js?v=commits&sha=${SHA}`, { ...API, [`${base}/file?ref=main&path=app.js`]: new Promise(() => {}) });
    expect(urls).toContain(`${base}/commits/${SHA}?ref=main`);
  });
});
