import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EGRESS } from "../../worker/src/api/contract.js";
import { all, click, doc, El } from "../src/fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Watchtower, watchtowerLoader } = await import("../src/watchtower.jsx");

afterEach(() => { vi.unstubAllEnvs(); });

const LONG = "a-very-long-internal-artifact-mirror.build-cache.eu-west-1.example-corp.internal";
const EGRESS = { window: "24h", jobs: [], versions: [{ agent: "cinder-agent@v0", counts: { allowed: 7, denied: 2, would_deny: 0 },
  allowed: [{ host: LONG, count: 7 }], denied: [{ host: "pastebin.com", count: 2 }], would_deny: [] }] };
const pool = (id, name, repos, egress_allow) => ({ id, name, size: "basic", min: 0, max: 4, repo: null, kinds: ["develop"], draining: false, workers: 0, online: 0,
  created_at: "2026-10-01T08:00:00Z", default: false, runs_per_hour: 0, median_start_s: null, labels: [], max_concurrent: 8, keep_warm_s: 60, placement: "nearest", egress: "allowlist", egress_allow, repos });
const POOLS = [pool("p1", "build", "*", []), pool("p2", "other", ["acme/web"], ["x.dev"])];

// Mounts the Network tab against a stubbed API; returns the page, its writes and a button press.
const mount = async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  const writes = [];
  vi.stubGlobal("fetch", async (url, init) => {
    const u = String(url);
    if (init?.method) { writes.push([init.method, u, JSON.parse(init.body)]); return Response.json(POOLS[0]); }
    if (u.endsWith("/watchtower?state=all")) return Response.json({ findings: [], scans: [], paused: false, scan_worker_online: true, fix_changes_open: 0 });
    if (u.includes("/egress")) return Response.json(EGRESS);
    if (u === "/api/workers/pools") return Response.json(POOLS);
    return Response.json([]);
  });
  const router = createMemoryRouter([{ path: "/:repo/watchtower", element: <Watchtower />, loader: watchtowerLoader }], { initialEntries: ["/acme%2Fapi/watchtower?tab=network"] });
  const root = doc.body.appendChild(new El("div"));
  const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await settle();
  const find = (pred) => all(root).find(pred);
  const press = async (text) => { await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === text))); await settle(); };
  return { root, find, writes, press, settle };
};

describe("watchtower Network host rows", () => {
  it("a refused egress host has an allow action that adds it to the allowlist", async () => {
    const { root, find, writes, press, settle } = await mount();
    const dialogs = all(root).filter((n) => n.nodeName === "DIALOG");
    for (const d of dialogs) d.showModal = vi.fn();
    expect(find((n) => n.nodeName === "BUTTON" && n.textContent === "Allow").parentNode.textContent).toContain("pastebin.com");
    await press("Allow");
    const dialog = dialogs.find((d) => d.showModal.mock.calls.length);
    expect(dialog.textContent).toContain("Adds pastebin.com to the egress allowlist of build");
    expect(dialog.textContent).not.toContain("other");
    await act(async () => { dialog.returnValue = "ok"; for (const f of dialog.listeners.close) f({ type: "close", currentTarget: dialog, target: dialog }); });
    await settle();
    expect(writes).toEqual([["PUT", "/api/workers/pools/p1", { egress_allow: [...DEFAULT_EGRESS, "pastebin.com"] }]]);
    expect(find((n) => n.getAttribute?.("role") === "status").textContent).toBe("pastebin.com allowed on build");
  });

  it("a long host name is truncated with its full name in the title", async () => {
    const { find } = await mount();
    const span = find((n) => n.nodeName === "SPAN" && n.textContent === LONG);
    expect(span.getAttribute("title")).toBe(LONG);
    expect(span.getAttribute("class") ?? span.className).toBe("mono host");
    const css = readFileSync(new URL("../src/styles/watchtower.css", import.meta.url), "utf8");
    expect(css).toContain(".wt .hbar .host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
  });
});
