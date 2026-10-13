import { afterEach, describe, expect, it, vi } from "vitest";
import { repoAt } from "./fake-repos.js";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { routes } = await import("./routes.jsx");
// Pages load lazily: importing them here first lets a render resolve its route without waiting on a fresh import.
await import("./changes.jsx");

const at = new Date().toISOString();
const change = (id, state, extra) => ({ id, repo_id: "r", kind: "change", title: `${state} change`, intent: "x", target_branch: "main", state,
  fork: "f", stacked_on: null, risk: null, created_at: at, updated_at: at, ...extra });
const REPO = { id: "r", name: "web", default_branch: "main", strategy: "trunk", branch_policy: { integration: ["main"], release: [], check: "make check", stack: "code@v1" }, created_at: at };
const flat = (rs) => rs.flatMap((r) => [r, ...flat(r.children ?? [])]);
const route = flat(routes).find((r) => r.path === "changes");

afterEach(() => vi.unstubAllEnvs());

describe("changes board, closed changes", () => {
  it("A closed card is gone from the board and present in Table view", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
    vi.stubGlobal("WebSocket", class { close() {} });
    const work = { kind: "change", n: null, change_id: "c-open", title: "verifying change", lane: "verify", priority: null, labels: [], author: "owner", assignee: null, why: null, updated_at: at };
    const tiles = { intents: 0, in_flight: 1, review: 0, merged_24h: 0, needs_you: 0, verifier: { pass: 0, n: 0, trusted: false } };
    const cards = [change("c-open", "verifying"), change("c-gone", "closed", { closed_by: "maya", closed_at: at, close_reason: "Superseded" })];
    vi.stubGlobal("fetch", vi.fn(async (url) => Response.json(url === "/api/live-ticket" ? { ticket: "t" } : url.startsWith("/api/repos/web/changes") ? cards
      : url === "/api/repos/web/work" ? { items: [work], tiles, can_write: true } : repoAt(url, [REPO]) ?? [REPO])));
    const router = createMemoryRouter([{ ...route, path: "/:repo/changes" }], { initialEntries: ["/web/changes"] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const articles = () => all(root).filter((n) => n.nodeName === "ARTICLE").map((n) => n.textContent);
    expect(articles().some((t) => t.includes("c-gone"))).toBe(false);
    expect(articles().some((t) => t.includes("c-open"))).toBe(true);
    await act(async () => click(all(root).find((n) => n.nodeName === "BUTTON" && n.textContent === "Table")));
    const rows = all(root).filter((n) => n.nodeName === "TR").map((n) => n.textContent);
    expect(rows.find((t) => t.includes("c-gone"))).toContain("Closed");
  });
});
