import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import changes from "../../worker/src/api/fixtures/changes.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

// Monaco can't run on the fake DOM; a textarea stands in and reports typing as Monaco's onChange does.
vi.mock("./monaco.jsx", () => ({
  default: ({ value, onChange }) => <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />,
  colorize: () => Promise.reject(new Error("no monaco in tests")),
}));
doc.oninput = null;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, createStaticHandler, RouterProvider } = await import("react-router");
const { Code, codeLoader, codeRevalidate } = await import("./code.jsx");
const { forgetTrees } = await import("./client.js");
const { routes } = await import("./routes.jsx");

const repo = repos[0];
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const API = {
  "/api/repos": repos,
  [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", entries: [{ name: "app.js", path: "app.js", type: "blob" }] },
  [`${base}/file?ref=main&path=app.js`]: { ref: "main", sha: "m1", path: "app.js", size: 9, content: "const app" },
  [`${base}/symbols?target=main`]: { sha: "m1", symbols: [] },
  [`${base}/lease-map`]: { conflicts: { merges: 0, conflicted: 0, days: 7 }, changes: [], leases: [], edges: [] },
  [`${base}/log?ref=main&page=1`]: { ref: "main", sha: "m1", path: "", commits: [], more: false, total: 0 },
};
const live = (post, api = API) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("fetch", (url, init) => (init?.method === "POST" ? post(url, JSON.parse(init.body ?? "null"))
    : Promise.resolve(Response.json(api[url] ?? []))));
};
// The Code page editing app.js on main, with its nodes to find and fields to type into.
async function edit(over = {}, at = "app.js?v=edit") {
  live(() => new Promise(() => {}), { ...API, ...over });
  const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
    { path: "code/:ref/*", element: <Code />, loader: codeLoader, shouldRevalidate: codeRevalidate }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/code/main/${at}`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  for (let i = 0; i < 2; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  const find = (pred) => all(root).find(pred);
  const type = (value, label) => {
    const el = find((n) => n.attrs["aria-label"] === label);
    Object.assign(el, { value, type: el.nodeName === "INPUT" ? "text" : "textarea" });
    const e = { type: "input", target: el, bubbles: true, preventDefault() {}, stopPropagation() {} };
    for (let n = el; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f(e);
  };
  // The file line: the header of the file card.
  const head = () => find((n) => n.attrs.class === "panel fcard editing").childNodes[0];
  return { root, find, type, head };
}
const css = readFileSync(new URL("./styles/code.css", import.meta.url), "utf8");
const rule = (sel) => css.match(new RegExp(`(^|\\})${sel.replace(/[.()[\]:]/g, "\\$&")}\\{([^}]*)\\}`, "m"))?.[2];

afterEach(() => { vi.unstubAllEnvs(); forgetTrees(); });

describe("code editor footer", () => {
  it("Spacing is on the 4px grid; footer sections are 16px apart; the bottom bar has a top border", () => {
    const footer = css.split("\n").filter((l) => /\.(ed-|opt|stg)/.test(l)).join("\n");
    expect(footer).not.toBe("");
    expect([...footer.matchAll(/(\d+)px/g)].every((m) => Number(m[1]) % 4 === 0)).toBe(true);
    expect(readFileSync(new URL("./styles/tokens.css", import.meta.url), "utf8")).toContain("--s-4:16px");
    expect(rule(".ed-foot")).toContain("gap:var(--s-4)");
    expect(rule(".ed-bar")).toMatch(/border-top:var\(--bw\) solid var\(--line\)/);
  });

  it("The radio cards show checked state with --interactive border and tint; the disabled card is visibly disabled and can't be focused", async () => {
    const { root, find } = await edit();
    const radio = (v) => find((n) => n.name === "op" && n.value === v);
    expect(radio("propose").checked).toBe(true);
    // main is the integration branch: the commit card's radio is disabled (so out of the tab order) and says why.
    expect(radio("commit").attrs.disabled).toBe("");
    expect(root.textContent).toContain("Unavailable: the verifier owns every merge into integration branches.");
    expect(rule(".opt:has(input:checked)")).toBe("border-color:var(--interactive);background:var(--interactive-tint)");
    expect(rule(".opt:has(input:disabled)")).toMatch(/cursor:not-allowed;opacity:/);
  });

  it("Staging keeps one entry per path: staging again replaces it, and a rename replaces the entry at its old path", async () => {
    const { root, find, type } = await edit();
    const stage = () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Stage"));
    const rows = () => all(root).filter((n) => n.attrs.class === "stg-r").map((n) => n.textContent);
    await act(async () => type("const app = 1", "editor"));
    await act(async () => stage());
    await act(async () => type("const app = 2", "editor"));
    await act(async () => stage());
    expect(rows()).toEqual(["app.jseditUnstage"]);
    await act(async () => type("a.js", "Rename or move to"));
    await act(async () => stage());
    await act(async () => type("b.js", "Rename or move to"));
    await act(async () => stage());
    expect(rows()).toEqual(["b.js← app.jsrenameUnstage"]);
    expect(find((n) => n.attrs.class === "tr-s")?.textContent).toBe("M");
  });

  it("Edit keeps line 1 at the same offset as View", async () => {
    // View's header holds the Seg (3px padding around 30px buttons); Edit's has only the pill and Cancel, so the toolbar keeps the Seg's height.
    const app = readFileSync(new URL("./styles/app.css", import.meta.url), "utf8");
    const seg = 2 * Number(app.match(/\.seg\{[^}]*padding:(\d+)px/)[1]) + Number(app.match(/\.seg button\{[^}]*height:(\d+)px/)[1]);
    expect(rule(".fcard>.panel-head .toolbar")).toBe(`min-height:${seg}px`);
    for (const at of ["app.js", "app.js?v=edit"]) {
      const { find } = await edit({}, at);
      expect(find((n) => n.attrs.class === "panel-head" && n.parentNode.attrs.class?.includes("fcard")).childNodes.some((n) => n.attrs.class === "toolbar")).toBe(true);
    }
    // View's box is its top padding plus the lines, as Monaco's height is: no bottom padding.
    expect(app).toContain(".codev-in{min-width:max-content}");
  });

  it("Cancel restores the scroll position", async () => {
    const main = new El("main");
    main.scrollTop = 300;
    const was = doc.querySelector;
    doc.querySelector = (s) => (s === ".main" ? main : null);
    onTestFinished(() => { doc.querySelector = was; });
    const { find } = await edit({}, "app.js");
    await act(async () => click(find((n) => n.nodeName === "A" && n.textContent === "Edit")));
    expect(find((n) => n.attrs["aria-label"] === "editor")).toBeTruthy();
    main.scrollTop = 0; // the editor stops at 560 px, so the page's scroll clamps
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Cancel")));
    expect(find((n) => n.attrs["aria-label"] === "editor")).toBeUndefined();
    expect(main.scrollTop).toBe(300);
  });

  it("Submitting creates the change with the right author kind (person or agent) and opens its change detail", async () => {
    const sent = [];
    live(async (url, body) => { sent.push([url, body]); return Response.json({ id: "c-9", fork: "acme/web--cc-9", target_branch: "main" }, { status: 201 }); });
    const submit = (fields) => createStaticHandler(routes).query(new Request(`http://cinder.test/${encodeURIComponent(repo.name)}/code/main/app.js`,
      { method: "POST", body: new URLSearchParams({ base_sha: "m1", content: "const app = 2", intent: "Two", changes: JSON.stringify([{ path: "app.js", content: "const app = 2" }]), ...fields }) }));
    const commit = [`/api/repos/${encodeURIComponent("acme/web--cc-9")}/commits`, { branch: "main", base_sha: "m1", message: "Two", changes: [{ path: "app.js", content: "const app = 2" }] }];

    // Open a change · you drive: the person's edit.
    let res = await submit({ op: "propose" });
    expect(sent).toEqual([[`${base}/changes/edit`, { target: "main", path: "app.js", base_sha: "m1", content: "const app = 2", intent: "Two" }]]);
    expect(res.headers.get("Location")).toBe(`/${encodeURIComponent(repo.name)}/changes/c-9`);

    // A rename opened as a change: created, then taken over so the person drives it.
    sent.length = 0;
    const moved = [{ path: "app.js", delete: true }, { path: "b.js", content: "const app = 2" }];
    res = await submit({ op: "propose", changes: JSON.stringify(moved) });
    expect(sent).toEqual([[`${base}/changes`, { intent: "Two", target_branch: "main" }], ["/api/changes/c-9/takeover", null], [commit[0], { ...commit[1], changes: moved }]]);
    expect(res.headers.get("Location")).toBe(`/${encodeURIComponent(repo.name)}/changes/c-9`);

    // Hand to an agent: created and left to its agent (no take over), the edit committed as its starting point.
    sent.length = 0;
    res = await submit({ op: "agent" });
    expect(sent).toEqual([[`${base}/changes`, { intent: "Two", target_branch: "main" }], commit]);
    expect(res.headers.get("Location")).toBe(`/${encodeURIComponent(repo.name)}/changes/c-9`);
  });

  it("renaming by editing the path on the file line stages a rename", async () => {
    const tree = { ref: "main", sha: "m1", path: "", entries: [{ name: "app.js", path: "app.js", type: "blob" }, { name: "x.js", path: "lib/util/x.js", type: "blob" }] };
    const { root, find, type, head } = await edit({ [`${base}/tree?ref=main&path=&recursive=1`]: tree });
    const field = all(head()).find((n) => n.attrs["aria-label"] === "Rename or move to");
    expect(field.value).toBe("app.js");
    // Directory autocomplete comes from the tree.
    const list = find((n) => n.nodeName === "DATALIST" && n.attrs.id === field.attrs.list);
    expect(all(list).filter((n) => n.nodeName === "OPTION").map((n) => n.attrs.value)).toEqual(["lib/", "lib/util/"]);
    await act(async () => type("lib/a.js", "Rename or move to"));
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Stage")));
    expect(all(root).filter((n) => n.attrs.class === "stg-r").map((n) => n.textContent)).toEqual(["lib/a.js← app.jsrenameUnstage"]);
  });

  it("delete on the file line stages a delete and asks when the file is leased", async () => {
    const { root, find, head } = await edit({
      [`${base}/changes`]: [{ ...changes[0], id: "c_01", state: "draft", intent: "Speed up app", agent_version: "patch@3.3.0" }],
      [`${base}/lease-map`]: { conflicts: { merges: 0, conflicted: 0, days: 7 }, changes: [{ id: "c_01", state: "draft", intent: "Speed up app", seam: false, stacked_on: null }], edges: [],
        leases: [{ symbol: "app.js", file: "app.js", holder: "c_01", expires_at: "2099-01-01T00:30:00.000Z", mode: "exclusive", waiting: [] }] },
    });
    await act(async () => click(all(head()).find((n) => n.nodeName === "BUTTON" && n.textContent === "Stage delete")));
    expect(all(root).filter((n) => n.attrs.class === "stg-r").map((n) => n.textContent)).toEqual(["app.jsdeleteUnstage"]);
    const form = find((n) => n.nodeName === "FORM" && n.attrs.class === "stg-f");
    // The fake form has no fields for FormData to read; the stub answers the typed message.
    const Real = FormData;
    globalThis.FormData = class { get = (k) => (k === "intent" ? "Drop app" : null); };
    const e = { type: "submit", target: form, currentTarget: form, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    await act(async () => { for (let n = form; n; n = n.parentNode) for (const f of n.listeners.submit ?? []) f(e); });
    globalThis.FormData = Real;
    expect(e.defaultPrevented).toBe(true);
    expect(find((n) => n.attrs["aria-label"] === "Lease held")?.textContent).toContain("app.js lines 1–1 is leased by c_01");
  });

  it("there is no separate rename box under the code", async () => {
    const { root, find } = await edit();
    const foot = find((n) => n.attrs.class === "ed-foot");
    expect(foot).toBeTruthy();
    expect(all(foot).some((n) => n.attrs["aria-label"] === "Rename or move to" || n.textContent === "Stage delete")).toBe(false);
    expect(all(root).some((n) => n.attrs.class === "ed-more")).toBe(false);
    expect(root.textContent).not.toContain("Rename, move or delete");
  });

  it("hand to an agent is disabled until the message is filled", async () => {
    const { root, find, type } = await edit();
    const button = () => find((n) => n.nodeName === "BUTTON" && n.attrs.type === "submit");
    const why = "Add a message: it becomes the agent's intent";
    await act(async () => type("const app = 2", "editor"));
    El.prototype.querySelectorAll = () => [];
    const agent = find((n) => n.name === "op" && n.value === "agent");
    await act(async () => { agent.checked = true; click(agent); });
    expect(button().textContent).toBe("Hand to agent");
    expect(button().attrs.disabled).toBe("");
    expect(root.textContent).toContain(why);
    await act(async () => type("Two", "Change message"));
    expect(button().attrs.disabled).toBeUndefined();
    expect(root.textContent).not.toContain(why);
  });

  it("handing an edit to an agent creates the change with the message as its intent and opens it", async () => {
    // The footer hands over in place: no detour through the New change page.
    const { find } = await edit();
    expect(all(find((n) => n.attrs.class === "ed-foot")).filter((n) => n.nodeName === "A")).toEqual([]);
    const sent = [];
    live(async (url, body) => { sent.push([url, body]); return Response.json({ id: "c-9", fork: "acme/web--cc-9", target_branch: "main" }, { status: 201 }); });
    const res = await createStaticHandler(routes).query(new Request(`http://cinder.test/${encodeURIComponent(repo.name)}/code/main/app.js`,
      { method: "POST", body: new URLSearchParams({ op: "agent", base_sha: "m1", intent: "Two", changes: JSON.stringify([{ path: "app.js", content: "const app = 2" }]) }) }));
    expect(sent[0]).toEqual([`${base}/changes`, { intent: "Two", target_branch: "main" }]);
    expect(res.headers.get("Location")).toBe(`/${encodeURIComponent(repo.name)}/changes/c-9`);
  });
});
