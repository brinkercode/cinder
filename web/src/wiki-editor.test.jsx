import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import history from "../../worker/src/api/fixtures/wiki-history.json";
import { all, click, doc, El } from "./fake-dom.js";

// React probes `"oninput" in document` at import; without it, typing goes through an old-IE polyfill the fake DOM can't drive.
doc.oninput = null;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Wiki, wikiAction, wikiLoader } = await import("./wiki.jsx");

const PAGE = "/wiki/acme%2Fweb/p-arch";
const API = "/api/repos/acme%2Fweb/wiki";
const tree = [{ id: "p-arch", parent_id: null, title: "Architecture", slug: "architecture", type: "page", sort_order: 1, agent_context: false, children: [] }];
const row = { id: "p-arch", repo_id: "r-web", parent_id: null, title: "Architecture", slug: "architecture", type: "page", content: "# Architecture\nLeases first.",
  sort_order: 1, view_count: 4, created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-04T16:20:00.000Z",
  agent_context: false, words: 2, read_minutes: 1, views: 3, toc: [] };

afterEach(() => vi.unstubAllEnvs()); // not the globals: fake-dom's document and window stay for every test

let router;
async function open(at, patch = Response.json(row)) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  const fetch = vi.fn(async (url, init) => {
    if (url === "/api/repos") return Response.json(repos);
    if (init?.method === "PATCH") return patch;
    if (init?.method === "POST") return Response.json(row);
    if (url === `${API}/tree`) return Response.json(tree);
    if (url === `${API}/pages/p-arch/history`) return Response.json(history);
    if (url === `${API}/pages/p-arch/comments`) return Response.json([]);
    if (url.startsWith(`${API}/pages/p-arch/diff?`)) return Response.json({ from: 1, to: 2, lines: [" # Architecture", "-Leases.", "+Leases first.", "+Queues next."] });
    if (url === `${API}/pages/p-arch`) return Response.json(row);
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  router = createMemoryRouter([{ path: "/wiki/:repo/:id?", element: <Wiki />, loader: wikiLoader, action: wikiAction }], { initialEntries: [at] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await settle();
  const find = (pred) => all(root).find(pred), area = () => find((n) => n.attrs["aria-label"] === "Content, Markdown");
  const button = (t) => find((n) => n.nodeName === "BUTTON" && (n.textContent === t || n.attrs["aria-label"] === t));
  const type = (value) => {
    const el = Object.assign(area(), { value, type: "textarea" });
    const e = { type: "input", target: el, bubbles: true, preventDefault() {}, stopPropagation() {} };
    for (let n = el; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f(e);
  };
  const key = (k, ctrlKey = false) => {
    const e = { type: "keydown", key: k, ctrlKey, target: area(), bubbles: true, preventDefault: vi.fn(), stopPropagation() {} };
    for (let n = area(); n; n = n.parentNode) for (const f of n.listeners.keydown ?? []) f(e);
    return e;
  };
  return { fetch, find, button, area, type, key, text: () => root.textContent };
}
const settle = async () => { for (let i = 0; i < 3; i++) await act(() => new Promise((r) => setTimeout(r, 0))); };
const where = () => router.state.location.pathname + router.state.location.search;
const patches = (fetch) => fetch.mock.calls.filter(([, init]) => init?.method === "PATCH");

describe("wiki editor", () => {
  it("each toolbar button wraps the selection in its markdown", async () => {
    const { button, area, type } = await open(`${PAGE}?v=edit`);
    const wraps = { Bold: "a **word** b", Italic: "a _word_ b", Heading: "a ## word b", List: "a - word b", Quote: "a > word b",
      Code: "a `word` b", Link: "a [word](https://) b", Table: "a | A | B |\n|---|---|\n| word |  | b" };
    for (const [name, want] of Object.entries(wraps)) {
      await act(async () => type("a word b"));
      Object.assign(area(), { selectionStart: 2, selectionEnd: 6 });
      await act(async () => click(button(name)));
      expect(area().value, name).toBe(want);
    }
  });

  it("Ctrl B, Ctrl I and Ctrl K wrap the selection as their toolbar buttons do", async () => {
    const { area, type, key } = await open(`${PAGE}?v=edit`);
    for (const [k, want] of [["b", "a **word** b"], ["i", "a _word_ b"], ["k", "a [word](https://) b"]]) {
      await act(async () => type("a word b"));
      Object.assign(area(), { selectionStart: 2, selectionEnd: 6 });
      const e = await act(async () => key(k, true));
      expect(area().value, k).toBe(want);
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it("Ctrl S saves and Esc cancels", async () => {
    const { fetch, type, key } = await open(`${PAGE}?v=edit`);
    await act(async () => type("# Architecture\nMine."));
    const e = await act(async () => key("s", true));
    await settle();
    expect(e.preventDefault).toHaveBeenCalled(); // the browser's own save dialog stays shut
    expect(JSON.parse(patches(fetch)[0][1].body)).toEqual({ title: "Architecture", content: "# Architecture\nMine.", message: "", base_version: 3 });
    expect(where()).toBe(PAGE);

    await act(() => router.navigate(`${PAGE}?v=edit`));
    await act(async () => type("Unsaved."));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await act(async () => key("Escape"));
    expect(confirm).toHaveBeenCalledOnce();
    expect(where()).toBe(`${PAGE}?v=edit`); // declined: the draft stays
    confirm.mockReturnValue(true);
    await act(async () => key("Escape"));
    await settle();
    expect(where()).toBe(PAGE);
    expect(patches(fetch)).toHaveLength(1);
  });

  it("a save without changes sends no request", async () => {
    const { fetch, button, key } = await open(`${PAGE}?v=edit`);
    await act(async () => click(button("Save page")));
    await settle();
    expect(where()).toBe(PAGE);
    await act(() => router.navigate(`${PAGE}?v=edit`));
    await act(async () => key("s", true));
    await settle();
    expect(where()).toBe(PAGE);
    expect(patches(fetch)).toHaveLength(0);
  });

  it("a 409 shows the conflict message and keeps the draft", async () => {
    const { fetch, find, button, area, type } = await open(`${PAGE}?v=edit`, Response.json({ error: { code: "stale", message: "page is at version 4, not 3" } }, { status: 409 }));
    await act(async () => type("# Architecture\nMine."));
    await act(async () => click(button("Save page")));
    await settle();
    expect(JSON.parse(patches(fetch)[0][1].body).base_version).toBe(3); // the newest version in history
    expect(find((n) => n.attrs.role === "alert").textContent).toContain("Conflict: someone saved this page since you opened it.");
    expect(where()).toBe(`${PAGE}?v=edit`);
    expect(area().value).toBe("# Architecture\nMine.");
  });

  it("Split shows the editor and a live preview side by side", async () => {
    const { find, button, type } = await open(`${PAGE}?v=edit`);
    const pane = () => find((n) => n.attrs.class?.startsWith("wk-pane"));
    await act(async () => click(button("Write")));
    expect(pane().attrs.class).toBe("wk-pane t-write");
    await act(async () => click(button("Split")));
    expect(pane().attrs.class).toBe("wk-pane t-split");
    await act(async () => type("## Lease queue\nLive text."));
    const [editor, preview] = pane().childNodes;
    expect(editor.nodeName).toBe("TEXTAREA");
    expect(preview.attrs.class).toBe("wk-prev");
    expect(all(preview).find((n) => n.nodeName === "H3").textContent).toBe("Lease queue");
    expect(preview.textContent).toContain("Live text.");
  });

  it("history shows + and − counts, and Restore vN saves a new version", async () => {
    const { fetch, find, button, text } = await open(`${PAGE}?v=history&at=2`);
    expect(fetch).toHaveBeenCalledWith(`${API}/pages/p-arch/diff?from=1&to=2`);
    expect(text()).toContain("v1 → v2+2−1");
    expect(find((n) => n.nodeName === "A" && n.attrs["aria-current"] === "true").textContent).toContain("v2");
    expect(find((n) => n.attrs.class === "tag t-info").textContent).toBe("current");
    const form = button("Restore v2").parentNode;
    const fields = all(form).filter((n) => n.nodeName === "INPUT").map((n) => [n.name ?? n.attrs.name, n.value ?? n.attrs.value]);
    expect(fields).toEqual([["intent", "restore"], ["v", "2"]]);
    // The fake DOM can't build FormData from a form, so the button's fields go through the router as its Form would send them.
    await act(() => router.navigate(PAGE, { formMethod: "post", formData: new URLSearchParams(fields) }));
    await settle();
    expect(fetch).toHaveBeenCalledWith(`${API}/pages/p-arch/restore/2`, expect.objectContaining({ method: "POST" }));
    expect(where()).toBe(PAGE);
  });
});
