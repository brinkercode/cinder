import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, Outlet, RouterProvider } = await import("react-router");
const { routes } = await import("./routes.jsx");
// Pages load lazily: importing them here first lets a render resolve its route without waiting on a fresh import.
await import("./repos.jsx");

El.prototype.hidePopover = function hidePopover() {};
Object.defineProperty(El.prototype, "parentElement", { get() { return this.parentNode; } });

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

const at = "2026-10-01T00:00:00Z";
const REPOS = [{ id: "r1", name: "billing" }, { id: "r2", name: "handbook" }]
  .map((r) => ({ ...r, default_branch: "main", strategy: "trunk", created_at: at, status: "ready",
    branch_policy: { integration: ["main"], release: [], promote: [], check: "make check", stack: "code@v1" } }));
const OVERVIEW = { account: { id: null, name: "cinder", git_host: "cinder.test" }, budget: { tokens: null, spent: 0, resets_at: "2026-11-01T00:00:00Z", alerts: [] },
  repos: REPOS.map((r) => ({ repo_id: r.id, description: "", language: null, pushed_at: at, agents: 0, spent: 0 })), archived: [] };

describe("Repositories filters", () => {
  it("switching Show from Show all to Archived renders the archived list without calling the overview or per-repo changes fetches", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    // The live-ticket request never answers, so no event socket opens.
    const answers = { "/api/repos": REPOS, "/api/overview": OVERVIEW, "/api/needs": [], "/api/me": { email: "o@x.dev", owner: true } };
    const fetch = vi.fn((url) => (answers[url] ? Promise.resolve(Response.json(answers[url])) : url.endsWith("/changes") ? Promise.resolve(Response.json([])) : new Promise(() => {})));
    vi.stubGlobal("fetch", fetch);
    // The real root and home routes; the shell is left out.
    const home = routes[0].children.find((r) => r.path === "/");
    const router = createMemoryRouter([{ ...routes[0], element: <Outlet />, children: [home] }], { initialEntries: ["/?show=all"] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const cards = () => all(root).filter((n) => n.attrs.class === "card-link").map((n) => n.textContent);
    expect(cards()).toEqual(["billing", "handbook"]);

    fetch.mockClear();
    await act(async () => click(all(root).find((n) => n.nodeName === "BUTTON" && n.textContent === "Archived")));
    expect(router.state.location.search).toBe("?show=archived");
    expect(cards()).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => url).filter((u) => u === "/api/overview" || u === "/api/needs" || u.endsWith("/changes"))).toEqual([]);
  });

  it("Archive asks to confirm naming the repo and submits intent=archive for that repo only on OK", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const answers = { "/api/repos": REPOS, "/api/overview": OVERVIEW, "/api/needs": [], "/api/me": { email: "o@x.dev", owner: true } };
    const fetch = vi.fn((url) => (answers[url] ? Promise.resolve(Response.json(answers[url])) : url.endsWith("/archive") ? Promise.resolve(Response.json({})) : url.endsWith("/changes") ? Promise.resolve(Response.json([])) : new Promise(() => {})));
    vi.stubGlobal("fetch", fetch);
    const home = routes[0].children.find((r) => r.path === "/");
    const router = createMemoryRouter([{ ...routes[0], element: <Outlet />, children: [home] }], { initialEntries: ["/?show=all"] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const archive = () => all(root).find((n) => n.nodeName === "BUTTON" && n.textContent === "Archive");
    const archives = () => fetch.mock.calls.filter(([url]) => url.endsWith("/archive"));

    window.confirm = vi.fn(() => false);
    await act(async () => click(archive()));
    expect(window.confirm).toHaveBeenCalledWith("Archive billing? Pushes will be refused until it is unarchived.");
    expect(archives()).toEqual([]);

    window.confirm = vi.fn(() => true);
    await act(async () => click(archive()));
    expect(archives().map(([url, init]) => [url, init.method])).toEqual([["/api/repos/billing/archive", "POST"]]);
    delete window.confirm;
  });
});
