import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

// Monaco can't run on the fake DOM; a textarea stands in and reports typing as Monaco's onChange does.
vi.mock("./monaco.jsx", () => ({
  default: ({ value, onChange }) => <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />,
  colorize: () => Promise.reject(new Error("no monaco in tests")),
}));
// React probes `"oninput" in document` at import; without it, typing goes through an old-IE polyfill the fake DOM can't drive.
doc.oninput = null;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Code, codeLoader, codeRevalidate } = await import("./code.jsx");
const { forgetTrees } = await import("./client.js");

const repo = repos[0];
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const API = {
  [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", entries: [{ name: "app.js", path: "app.js", type: "blob" }, { name: "README.md", path: "README.md", type: "blob" }] },
  [`${base}/changes`]: [],
  [`${base}/branches`]: [],
  [`${base}/file?ref=main&path=app.js`]: { ref: "main", sha: "m1", path: "app.js", size: 9, content: "const app" },
  [`${base}/file?ref=main&path=README.md`]: { ref: "main", sha: "m1", path: "README.md", size: 4, content: "# hi" },
  [`${base}/symbols?target=main`]: { sha: "m1", symbols: [] },
  [`${base}/lease-map`]: { conflicts: { merges: 0, conflicted: 0, days: 7 }, changes: [], leases: [], edges: [] },
  [`${base}/log?ref=main&page=1`]: { ref: "main", sha: "m1", path: "", commits: [{ sha: "m1", message: "Add app", author: "ana" }], more: false, total: 1 },
};

afterEach(() => { vi.unstubAllEnvs(); forgetTrees(); });

let router;
async function edit(at = "app.js?v=edit") {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("fetch", (url) => (API[url] ? Promise.resolve(Response.json(API[url])) : new Promise(() => {})));
  router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
    { path: "code/:ref/*", element: <Code />, loader: codeLoader, shouldRevalidate: codeRevalidate }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/code/main/${at}`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  for (let i = 0; i < 2; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  const find = (pred) => all(root).find(pred);
  const button = (t) => find((n) => n.nodeName === "BUTTON" && n.textContent === t);
  const type = (value, label = "editor") => {
    const el = find((n) => n.attrs["aria-label"] === label);
    Object.assign(el, { value, type: el.nodeName === "INPUT" ? "text" : "textarea" });
    const e = { type: "input", target: el, bubbles: true, preventDefault() {}, stopPropagation() {} };
    for (let n = el; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f(e);
  };
  const viewer = () => find((n) => n.attrs.class === "codev");
  return { find, button, type, viewer };
}
const mode = () => new URLSearchParams(router.state.location.search).get("v");

describe("code edit cancel", () => {
  it("clicking Cancel in Edit returns to View with the original content", async () => {
    const { button, viewer } = await edit();
    expect(mode()).toBe("edit");
    await act(async () => click(button("Cancel")));
    expect(mode()).toBe(null);
    expect(router.state.location.pathname).toBe(`/${encodeURIComponent(repo.name)}/code/main/app.js`);
    expect(viewer().textContent).toContain("const app");
  });

  it("Cancel with unsaved edits asks to discard; confirming discards, declining stays in Edit", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { button, type, find, viewer } = await edit();
    await act(async () => type("const changed"));
    await act(async () => click(button("Cancel")));
    expect(mode()).toBe("edit");
    expect(find((n) => n.attrs.role === "alert").textContent).toContain("Discard your edits to app.js?");

    await act(async () => click(button("Keep editing")));
    expect(mode()).toBe("edit");
    expect(find((n) => n.attrs.role === "alert")).toBeUndefined();
    expect(find((n) => n.attrs["aria-label"] === "editor").value).toBe("const changed");

    await act(async () => click(button("Cancel")));
    await act(async () => click(button("Discard")));
    expect(mode()).toBe(null);
    expect(viewer().textContent).toContain("const app");
    expect(confirm).not.toHaveBeenCalled();
    // Editing again starts from the original, not the discarded text.
    await act(() => router.navigate("?v=edit"));
    // A freshly mounted textarea carries its text as defaultValue on the fake DOM; a browser reads it back as value.
    const ed = find((n) => n.attrs["aria-label"] === "editor");
    expect(ed.value ?? ed.defaultValue).toBe("const app");
  });

  it("Escape in Edit cancels", async () => {
    const { viewer } = await edit();
    expect(mode()).toBe("edit");
    const e = { type: "keydown", key: "Escape", target: doc.body, defaultPrevented: false };
    await act(async () => { for (const f of doc.listeners.keydown ?? []) f(e); });
    expect(mode()).toBe(null);
    expect(viewer().textContent).toContain("const app");
  });

  it("Edit and Cancel are never shown together", async () => {
    const { find, button } = await edit("app.js");
    const editLink = () => find((n) => n.nodeName === "A" && n.textContent === "Edit");
    expect(editLink()).toBeDefined();
    expect(button("Cancel")).toBeUndefined();
    await act(() => router.navigate("?v=edit"));
    expect(button("Cancel")).toBeDefined();
    expect(editLink()).toBeUndefined();
    expect(find((n) => n.attrs.class === "pill brand").textContent).toBe("Editing");
    expect(find((n) => n.attrs.class === "panel fcard editing")).toBeDefined();
  });

  it("Esc cancels only when focus isn't inside a dialog or popover", async () => {
    await edit();
    const esc = () => act(async () => { for (const f of doc.listeners.keydown ?? []) f({ type: "keydown", key: "Escape", target: doc.body, defaultPrevented: false }); });
    const focusIn = (container) => { doc.activeElement = { closest: (sel) => (sel.split(", ").includes(container) ? {} : null) }; };
    try {
      focusIn("[popover]");
      await esc();
      expect(mode()).toBe("edit");
      focusIn("dialog");
      await esc();
      expect(mode()).toBe("edit");
    } finally { delete doc.activeElement; }
    await esc();
    expect(mode()).toBe(null);
  });

  it("Switching modes doesn't reload the page's data; the view is read from ?v=", async () => {
    const { find, button, viewer } = await edit("README.md");
    expect(["Preview", "Source", "History"].map((t) => button(t)?.textContent)).toEqual(["Preview", "Source", "History"]);
    expect(button("Blame")).toBeUndefined();
    expect(viewer()).toBeUndefined();
    expect(find((n) => n.attrs.class === "md").textContent).toContain("hi");
    const fetches = vi.spyOn(globalThis, "fetch");
    await act(async () => click(button("Source")));
    expect(mode()).toBe("source");
    expect(viewer().textContent).toContain("# hi");
    await act(async () => click(button("Preview")));
    expect(mode()).toBe("code");
    expect(viewer()).toBeUndefined();
    expect(fetches).not.toHaveBeenCalled();
  });

  it("Leaving the page with dirty edits or staged files asks first (useBlocker and beforeunload)", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const listens = vi.spyOn(globalThis, "addEventListener");
    const { type } = await edit();
    await act(async () => type("moved.js", "Rename or move to"));
    await act(() => router.navigate(`/${encodeURIComponent(repo.name)}/changes`));
    expect(confirm).toHaveBeenCalledWith("Leave without proposing? Your edits will be lost.");
    expect(mode()).toBe("edit");
    const unload = listens.mock.calls.filter(([t]) => t === "beforeunload").at(-1)[1];
    const e = { preventDefault: vi.fn() };
    unload(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});
