import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import changes from "../../worker/src/api/fixtures/changes.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

doc.oninput = null; // react-dom checks "oninput" in document once, at import; without it a text input's onChange never fires

const BRANCHES = [{ name: "main", kind: "branch", role: "integration", ahead: 0, behind: 0 }, { name: "feature/login", kind: "branch", role: "other", ahead: 2, behind: 1 },
  { name: "fix/typo", kind: "branch", role: "other", ahead: 1, behind: 0 }, { name: "release/1.2", kind: "branch", role: "other", ahead: 0, behind: 3 },
  { name: "v1.0.0", kind: "tag", role: "other", ahead: 0, behind: 0, head_sha: "aaaaaaa1" }, { name: "v1.1.0", kind: "tag", role: "other", ahead: 0, behind: 0, head_sha: "bbbbbbb2" }];
vi.mock("./client.js", async (real) => ({ ...(await real()), branchesFor: async () => BRANCHES }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Shell } = await import("./shell.jsx");
const { Branches } = await import("./branches.jsx");
const { codeLoader } = await import("./code.jsx");
Object.assign(El.prototype, { showModal() { this.attrs.open = ""; }, close() {} });

const repo = repos[0];
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const mount = async (routes, path) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return root;
};
const shell = (children) => [{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
  children: [{ path: ":repo", id: "repo", loader: () => repo, children }] }];

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("branch menu", () => {
  it("the branch menu's list container has a bounded max-height class and All branches renders outside the scrolling region", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    const root = await mount(shell([{ path: "changes" }]), `/${encodeURIComponent(repo.name)}/changes`);
    const menu = all(root).find((n) => n.attrs.id === "branch-menu");
    const scroll = all(menu).find((n) => n.attrs.class === "menu-scroll");
    expect(scroll.textContent).toContain("Integration");
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    expect(css).toContain(".menu-scroll{max-height:min(320px,50vh);overflow-y:auto}");
    const seeAll = all(menu).find((n) => n.nodeName === "BUTTON" && n.textContent.startsWith("All branches"));
    expect(seeAll).toBeTruthy();
    expect(all(scroll)).not.toContain(seeAll);
    expect(all(scroll).some((n) => n.textContent.startsWith("Every page in"))).toBe(false);
  });

  it("with changes in drafting, in_queue and needs_fix, Change workspaces lists only the drafting ones, each with its title", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
    const change = (id, state, title) => ({ ...changes[0], id, repo_id: repo.id, state, title, intent: title });
    const api = {
      [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: null, path: "", entries: [], empty: true },
      [`${base}/changes`]: [change("d-1", "draft", "Draft the login form"), change("q-1", "in_queue", "Queued work"), change("f-1", "needs_fix", "Broken work")],
    };
    vi.stubGlobal("fetch", async (url) => (api[url] ? Response.json(api[url]) : new Promise(() => {})));
    const root = await mount(shell([{ path: "code/:ref/*", loader: codeLoader }]), `/${encodeURIComponent(repo.name)}/code/main`);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const menu = all(root).find((n) => n.attrs.id === "branch-menu");
    expect(menu.textContent).toContain("Change workspaces");
    const rows = all(menu).filter((n) => n.nodeName === "A" && n.attrs.href.endsWith("-1")).map((n) => n.textContent);
    expect(rows).toEqual(["d-1Draft the login form"]);
  });
});

describe("branches modal", () => {
  it("typing in the Branches modal search hides non-matching branches", async () => {
    const root = await mount([{ path: "*", element: <Branches repo={repo} target="main" to={(b) => `/x/${b}`} onTarget={() => {}} onClose={() => {}} /> }], "/");
    await act(async () => {});
    const names = () => all(root).filter((n) => n.nodeName === "TD" && n.attrs["data-l"] === "Branch").map((n) => n.textContent);
    expect(names().join()).toContain("feature/login");
    const search = all(root).find((n) => n.attrs["aria-label"] === "Search branches");
    await act(async () => {
      Object.assign(search, { value: "login", type: "text" }); // React treats only typed inputs as text inputs
      for (let n = search; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f({ type: "input", target: search, bubbles: true, preventDefault() {}, stopPropagation() {} });
    });
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain("feature/login");
  });
});

it("the branch menu and Branches modal render every branch and tag the API returns, including slash-named ones", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  const root = await mount(shell([{ path: "changes" }]), `/${encodeURIComponent(repo.name)}/changes`);
  const menu = all(root).find((n) => n.attrs.id === "branch-menu");
  await act(async () => { for (const f of menu.listeners.toggle ?? []) f({ type: "toggle", target: menu, newState: "open", bubbles: false, preventDefault() {}, stopPropagation() {} }); });
  const rows = all(menu).filter((n) => n.nodeName === "A").map((n) => n.textContent);
  for (const b of BRANCHES) expect(rows.some((r) => r.startsWith(b.name)), b.name).toBe(true);
  expect(menu.textContent).toContain("Tags");
  const modal = await mount([{ path: "*", element: <Branches repo={repo} target="main" to={(b) => `/x/${b}`} onTarget={() => {}} onClose={() => {}} /> }], "/");
  await act(async () => {});
  const cells = (l) => all(modal).filter((n) => n.nodeName === "TD" && n.attrs["data-l"] === l).map((n) => n.textContent);
  expect(cells("Branch").map((c) => c.replace(/ ?default$/, ""))).toEqual(BRANCHES.filter((b) => b.kind === "branch").map((b) => b.name));
  expect(cells("Tag")).toEqual(["v1.0.0", "v1.1.0"]);
});

describe("branch menu redesign", () => {
  const css = readFileSync(new URL("styles/branch-menu.css", import.meta.url), "utf8");
  const rule = (sel) => css.match(new RegExp(`(?:^|\\})${sel.replace(/[.*+?^$()[\]]/g, "\\$&")}\\{([^}]*)\\}`, "m"))?.[1];
  const open = async () => {
    const store = new Map();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("sessionStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
    const router = createMemoryRouter(shell([{ path: "changes" }]), { initialEntries: [`/${encodeURIComponent(repo.name)}/changes`] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const menu = all(root).find((n) => n.attrs.id === "branch-menu");
    await act(async () => { for (const f of menu.listeners.toggle ?? []) f({ type: "toggle", target: menu, newState: "open", bubbles: false, preventDefault() {}, stopPropagation() {} }); });
    const rows = () => all(menu).filter((n) => n.attrs.class?.split(" ").includes("bm-r"));
    return { root, menu, rows, router, store };
  };

  it("all rows share one grid; names truncate without moving the role chip or the counts", async () => {
    const { rows } = await open();
    expect(rows()).toHaveLength(BRANCHES.length);
    for (const r of rows()) expect(r.childNodes.map((n) => n.attrs.class), r.textContent).toEqual(["ic", "bm-n mono", "bm-role", "bm-ab mono", "chkw"]);
    expect(rows().find((r) => r.textContent.startsWith("feature/login")).textContent).toBe("feature/login↑2 ↓1");
    expect(rule(".bm .bm-r")).toMatch(/grid-template-columns:16px minmax\(0,1fr\) auto 56px 16px;.*height:34px/);
    expect(rule(".bm .bm-r.ws")).toMatch(/grid-template-columns:16px minmax\(0,1fr\) 16px;height:44px/);
    expect(rule(".bm-n")).toContain("min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
    expect(rule(".bm-ab")).toContain("text-align:right");
  });

  it("the current branch has the --sb-active background, aria-checked=\"true\" and a check mark", async () => {
    const { rows } = await open();
    const [main, ...rest] = rows();
    expect(main.textContent).toBe("maindefault");
    expect(main.attrs.class).toBe("bm-r on");
    expect(main.attrs["aria-checked"]).toBe("true");
    expect(main.childNodes.at(-1).childNodes).toHaveLength(1);
    for (const r of rest) expect([r.attrs["aria-checked"], r.childNodes.at(-1).childNodes.length]).toEqual(["false", 0]);
    expect(rule(".bm .bm-r.on")).toBe("background:var(--sb-active)");
  });

  it("arrow keys move through rows; Enter sets the target; Esc closes and returns focus to the trigger", async () => {
    Object.assign(El.prototype, { focus() { doc.activeElement = this; }, closest() { return this; } });
    const { root, menu, rows, router, store } = await open();
    menu.querySelectorAll = () => rows();
    menu.hidePopover = vi.fn();
    const key = async (el, k) => act(async () => { for (let n = el; n; n = n.parentNode) for (const f of n.listeners.keydown ?? []) f({ type: "keydown", key: k, target: el, bubbles: true, preventDefault() {}, stopPropagation() {} }); });
    const input = all(menu).find((n) => n.attrs["aria-label"] === "Find a branch");
    await key(input, "ArrowDown");
    expect(doc.activeElement.textContent).toBe("maindefault");
    await key(doc.activeElement, "ArrowDown");
    await key(doc.activeElement, "ArrowDown");
    await key(doc.activeElement, "ArrowUp");
    expect(doc.activeElement.textContent).toMatch(/^feature\/login/);
    // Enter on a focused link is the browser's click.
    await act(async () => click(doc.activeElement));
    expect(store.get(`cinder.target.${repo.name}`)).toBe("feature/login");
    expect(router.state.location.search).toBe("?target=feature%2Flogin");
    await key(input, "Escape");
    expect(menu.hidePopover).toHaveBeenCalled();
    expect(doc.activeElement).toBe(all(root).find((n) => n.attrs.title === "Target branch"));
  });
});
