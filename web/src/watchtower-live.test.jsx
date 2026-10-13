import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Watchtower, watchtowerLoader, watchtowerRevalidate } = await import("./watchtower.jsx");

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("watchtower page (live)", () => {
  it("a scan moving from running to done updates the header without reload", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const day = new Date(Date.now() - 86400e3).toISOString();
    const wt = (status) => ({ findings: [], scans: [{ id: "s-1", ran_at: day, status, findings: 0 }], paused: false, scan_worker_online: true, fix_changes_open: 0 });
    let status = "running";
    vi.stubGlobal("fetch", async (url) => {
      const u = String(url);
      if (u.endsWith("/watchtower?state=all")) return Response.json(wt(status));
      if (u.includes("/egress")) return Response.json({ window: "24h", versions: [] });
      return Response.json([]);
    });
    const router = createMemoryRouter([{ path: "/:repo/watchtower", element: <Watchtower />, loader: watchtowerLoader, shouldRevalidate: watchtowerRevalidate }],
      { initialEntries: ["/acme%2Fapi/watchtower"] });
    const root = doc.body.appendChild(new El("div"));
    const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    await settle();
    const head = () => all(root).find((n) => n.attrs.class === "toolbar-end").textContent;
    expect(head()).toContain("Scanning…");

    status = "passed";
    await act(async () => vi.advanceTimersByTime(5000));
    await settle();
    expect(head()).toContain("Last scan");
    expect(head()).toContain("Scan again");
    expect(head()).not.toContain("Scanning…");
  });
});

describe("watchtower Network Allow and Deny (live)", () => {
  const VERSIONS = [{ version: 1, channel: null }, { version: 2, channel: "stable" }, { version: 3, channel: "canary", share: 30 }]
    .map((v) => ({ share: 0, released_at: null, outcomes: { merged: 0, n: 0, trusted: false }, web: { mode: "raw", converted: 0, saved_bytes: 0 }, ...v }));
  const EGRESS = { window: "24h", jobs: [], versions: [{ agent: "developer@v3", counts: { allowed: 5, denied: 1, would_deny: 0 },
    allowed: [{ host: "registry.npmjs.org", count: 5 }], denied: [{ host: "169.254.169.254", count: 1 }], would_deny: [] }] };
  // Mounts Network; returns the page, the writes sent, and a click on a row's button that opens the release dialog.
  const mount = async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const writes = [];
    vi.stubGlobal("fetch", async (url, init) => {
      const u = String(url);
      if (init?.method) { writes.push([init.method, u, JSON.parse(init.body)]); return Response.json({ version: 4, channel: "x", egress: [] }, { status: 202 }); }
      if (u.endsWith("/watchtower?state=all")) return Response.json({ findings: [], scans: [], paused: false, scan_worker_online: true, fix_changes_open: 0 });
      if (u.includes("/egress")) return Response.json(EGRESS);
      if (u === "/api/agents/developer/versions") return Response.json(VERSIONS);
      return Response.json([]);
    });
    const router = createMemoryRouter([{ path: "/:repo/watchtower", element: <Watchtower />, loader: watchtowerLoader }], { initialEntries: ["/acme%2Fapi/watchtower?tab=network"] });
    const root = doc.body.appendChild(new El("div"));
    const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    await settle();
    const find = (pred) => all(root).find(pred);
    const dialog = find((n) => n.nodeName === "DIALOG");
    dialog.showModal = vi.fn();
    const press = async (text) => { await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === text))); await settle(); };
    const close = async (value) => { await act(async () => { dialog.returnValue = value; for (const f of dialog.listeners.close) f({ type: "close", currentTarget: dialog, target: dialog }); }); await settle(); };
    return { root, find, dialog, writes, press, close };
  };

  it("Allow and Deny never edit a live version in place: Deny confirms a release of developer@v4 and sends only its POST", async () => {
    const { root, dialog, writes, press, close } = await mount();
    await press("Deny");
    expect(dialog.showModal).toHaveBeenCalled();
    expect(dialog.textContent).toContain("Deny registry.npmjs.org for developer?");
    expect(dialog.textContent).toContain("releases a new version: developer@v4, a copy of its canary version with registry.npmjs.org removed from its allowlist");
    expect(dialog.textContent).toContain("30% of changes. Stable stays on v2 until you promote v4.");
    expect(dialog.textContent).not.toContain("cloud metadata address");
    await close("cancel");
    expect(writes).toEqual([]);
    await press("Deny");
    await close("ok");
    expect(writes).toEqual([["POST", "/api/agents/developer/egress", { host: "registry.npmjs.org", verdict: "deny", channel: "canary" }]]);
    expect(root.textContent).toContain("Released developer@v4 to canary · registry.npmjs.org denied");
  });

  it("Both produce a release on the chosen channel: Allow on stable posts channel stable and warns about the metadata address", async () => {
    const { root, find, dialog, writes, press, close } = await mount();
    await press("Allow");
    expect(dialog.textContent).toContain("169.254.169.254 is the cloud metadata address. Allowing it lets the agent read worker credentials.");
    const stable = find((n) => n.nodeName === "INPUT" && n.value === "stable");
    await act(async () => stable[Object.keys(stable).find((k) => k.startsWith("__reactProps"))].onChange());
    expect(dialog.textContent).toContain("Release developer@v4 to stable");
    await close("ok");
    expect(writes).toEqual([["POST", "/api/agents/developer/egress", { host: "169.254.169.254", verdict: "allow", channel: "stable" }]]);
    expect(root.textContent).toContain("Released developer@v4 to stable · 169.254.169.254 allowed");
  });
});
