import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { ClonePop } = await import("./code.jsx");

const REPO = { name: "web", default_branch: "main", branch_policy: { integration: ["main", "develop"], release: ["release/*"] } };
const REMOTE = "https://artifacts.example/git/cinder/web.git";

const mount = async () => {
  const router = createMemoryRouter([{ path: "/", element: <ClonePop repo={REPO} remote={REMOTE} target="main" /> }]);
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return root;
};
const copyButton = (root) => all(root).find((n) => n.attrs["aria-label"] === "Copy clone URL");
const status = (root) => all(root).find((n) => n.attrs.role === "status");

afterEach(() => { vi.restoreAllMocks(); });

describe("clone popover", () => {
  it("shows the HTTPS URL, push and propose commands and the roll-back note", async () => {
    const root = await mount();
    for (const s of [REMOTE, "git push origin my-branch", "git push origin HEAD:refs/for/main",
      "Direct pushes to main, develop, release/* roll back"]) expect(root.textContent).toContain(s);
  });

  it("copying shows a toast; a denied clipboard leaves the text selectable", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const root = await mount();
    await act(async () => click(copyButton(root)));
    expect(writeText).toHaveBeenCalledWith(REMOTE);
    expect(status(root).textContent).toBe("Copied the clone URL");

    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } });
    const selectAllChildren = vi.fn();
    vi.stubGlobal("getSelection", () => ({ selectAllChildren }));
    const denied = await mount();
    await act(async () => click(copyButton(denied)));
    expect(status(denied)).toBeUndefined();
    const code = all(denied).find((n) => n.nodeName === "CODE");
    expect(selectAllChildren).toHaveBeenCalledWith(code);
    expect(code.textContent).toBe(REMOTE);
    expect(readFileSync(new URL("styles/clone-pop.css", import.meta.url), "utf8")).toMatch(/\.cl-url code\{[^}]*user-select:all/);
  });

  it("the browser never fetches a git token: the popover gives the cinder CLI command for one", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const root = await mount();
    expect(all(root).find((n) => n.nodeName === "PRE" && n.textContent === "cinder repo credentials web")).toBeDefined();
    expect(all(root).some((n) => n.nodeName === "BUTTON" && n.textContent === "Get git credentials")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the Clone popover stays closed until opened: its class doesn't collide with the code-line .cl rule", () => {
    const src = readFileSync(new URL("code.jsx", import.meta.url), "utf8");
    const cls = src.match(/id="clone-pop" className="([^"]+)"/)[1].split(" ");
    expect(cls).not.toContain("cl");
    expect(readFileSync(new URL("styles/clone-pop.css", import.meta.url), "utf8")).not.toMatch(/(^|[^-\w])\.cl[ .{]/m);
  });
});
