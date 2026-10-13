import { afterEach, describe, expect, it, vi } from "vitest";
import byo from "../../worker/src/api/fixtures/byo-pools.json";
import poolTokens from "../../worker/src/api/fixtures/pool-tokens.json";
import pools from "../../worker/src/api/fixtures/pools.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

doc.oninput = null; // React wires onChange to input events only where document has oninput

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Workers, workersAction, workersLoader } = await import("./runners.jsx");

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); }); // not unstubAllGlobals: that drops fake-dom.js's window
// A native dialog: open, close (which fires close, as Esc does) and focus.
Object.assign(El.prototype, {
  showModal() { this.open = true; },
  close() { this.open = false; for (const f of this.listeners.close ?? []) f({ type: "close", target: this, bubbles: false }); },
  focus() { doc.activeElement = this; },
  querySelectorAll() { return []; }, // React looks up a clicked radio's group
});

// answer(url, init): the fetch stub's Response, or a pending Promise.
const mount = async (answer) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  const fetch = vi.fn(async (url, init) => answer(url, init));
  vi.stubGlobal("fetch", fetch);
  const router = createMemoryRouter([{ path: "/automation/workers", element: <Workers />, loader: workersLoader, action: workersAction }], { initialEntries: ["/automation/workers"] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return { root, fetch, find: (pred) => all(root).find(pred) };
};
const lists = (url) => Response.json(url.endsWith("/byo-pools") ? byo : url.endsWith("/tokens") ? poolTokens : url === "/api/repos" ? repos : pools);
const fire = (el, type, extra = {}) => act(async () => {
  const e = { type, target: el, bubbles: true, preventDefault() {}, stopPropagation() {}, ...extra };
  for (let n = el; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f(e);
});
const type = (el, value) => { Object.assign(el, { value, type: "text" }); return fire(el, "input"); }; // React treats only typed inputs as text inputs
const press = async (n) => act(async () => click(n));
const button = (root, text) => all(root).find((n) => n.nodeName === "BUTTON" && n.textContent === text);
const dialog = (root) => all(root).find((n) => n.nodeName === "DIALOG");
const field = (root, name) => all(dialog(root)).find((n) => n.nodeName === "INPUT" && n.name === name);
const labelInput = (root) => all(dialog(root)).find((n) => n.attrs["aria-label"] === "Add a label");
const chips = (root) => all(dialog(root)).filter((n) => n.attrs.class === "pill").map((n) => n.textContent);
const openAdd = async (m) => press(button(m.root, "Add worker pool"));
const radio = (root, name, value) => all(dialog(root)).find((n) => n.name === name && n.value === value);
const cards = (root) => all(root).filter((n) => n.attrs.class === "lc");

describe("automation workers", () => {
  it("a pool card shows its size as text with no select, and Edit changes it", async () => {
    const m = await mount((url, init) => (init?.method === "PUT" ? Response.json({}) : lists(url)));
    const [managed, gpu] = cards(m.root);
    const controls = (card) => all(card).filter((n) => ["BUTTON", "SELECT", "A"].includes(n.nodeName)).map((n) => n.attrs["aria-label"] ?? n.textContent);
    expect([controls(managed), controls(gpu)]).toEqual([["Edit"], ["Edit"]]);
    expect(all(managed).find((n) => n.attrs.class === "lc-f").textContent).toContain("Size basic");
    expect(all(managed).find((n) => /delete|remove/i.test(n.textContent) && n.nodeName === "BUTTON")).toBeUndefined();
    await press(button(managed, "Edit"));
    await fire(radio(m.root, "size", "lite"), "click");
    await fire(all(dialog(m.root)).find((n) => n.nodeName === "FORM"), "submit");
    const put = m.fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect([put[0], JSON.parse(put[1].body).size]).toEqual(["/api/workers/pools/p_build", "lite"]);
  });

  it("picking a new size for a pool with running workers warns they restart on it", async () => {
    const m = await mount(lists);
    await press(button(cards(m.root)[0], "Edit"));
    const note = () => all(dialog(m.root)).find((n) => n.attrs.role === "note");
    expect(note()).toBeUndefined();
    await fire(radio(m.root, "size", "lite"), "click");
    expect(note().textContent.replace(/\s+/g, " ")).toBe("1 running worker will finish its current job and restart on lite.");
  });

  it("Dummy data: client-only states, loading skeletons, the card error with Retry and a red pill for an offline pool", async () => {
    const loading = await mount(() => new Promise(() => {}));
    expect(loading.find((n) => n.attrs["aria-busy"] === "true").childNodes).toHaveLength(3);
    const error = await mount(() => new Response("", { status: 503 }));
    expect(error.find((n) => n.attrs.class === "card").textContent).toBe("Couldn't load runner pools: /api/workers/pools: HTTP 503Retry");
    const { root } = await mount(lists);
    expect(all(cards(root)[0]).find((n) => n.attrs.class === "pill").textContent).toBe("1 of 1 online");
    const arm = cards(root)[2];
    expect(all(arm).find((n) => n.attrs.class === "pill").textContent).toBe("offline");
    expect(all(arm).find((n) => n.attrs.class === "dot bad")).toBeDefined();
  });

  it("a draining pool offers Resume, which posts undrain; an empty pool shows idle", async () => {
    const two = [{ ...pools[0], draining: true }, { ...pools[0], id: "p_zero", name: "zero", default: false, workers: 0, online: 0 }];
    const { root, fetch, find } = await mount((url, init) => (init?.method === "POST" ? Response.json({}) : Response.json(url.endsWith("/byo-pools") ? [] : two)));
    expect(all(cards(root)[1]).find((n) => n.attrs.class === "pill").textContent).toBe("Idle, scales on demand");
    const resume = find((n) => n.nodeName === "BUTTON" && n.textContent === "Resume");
    await act(async () => {
      for (let n = resume; n; n = n.parentNode) for (const f of n.listeners.click ?? []) f({ type: "click", target: resume, bubbles: true, preventDefault() {}, stopPropagation() {} });
    });
    expect(fetch.mock.calls.find(([, init]) => init?.method === "POST")[0]).toBe("/api/workers/pools/p_build/undrain");
  });

  it("two managed pools render with their names and exactly one default tag", async () => {
    const two = [pools[0], { ...pools[0], id: "p_e2e", name: "e2e-pool", default: false }];
    const { root } = await mount((url) => Response.json(url.endsWith("/byo-pools") ? [] : two));
    expect(cards(root).map((c) => all(c).find((n) => n.attrs.class === "lc-t").textContent)).toEqual(["Managed · builddefault", "Managed · e2e-pool"]);
  });

  it("the footer renders the runs-per-hour and median-start values", async () => {
    const { root } = await mount(lists);
    expect(all(cards(root)[0]).find((n) => n.attrs.class === "lc-f").textContent).toContain("Runs per hour 12Median start 4s");
  });

  it("focus starts on Name when the modal opens", async () => {
    const m = await mount(lists);
    await openAdd(m);
    expect([dialog(m.root).open, doc.activeElement]).toEqual([true, field(m.root, "name")]);
  });

  it("Esc and Cancel discard the draft", async () => {
    const m = await mount(lists);
    await openAdd(m);
    await type(field(m.root, "name"), "draft-1");
    await act(async () => dialog(m.root).close()); // Esc closes a native dialog
    expect(dialog(m.root)).toBeUndefined();
    await openAdd(m);
    expect(field(m.root, "name").value).toBe("");
    await type(field(m.root, "name"), "draft-2");
    await press(button(dialog(m.root), "Cancel"));
    expect(dialog(m.root)).toBeUndefined();
    await openAdd(m);
    expect(field(m.root, "name").value).toBe("");
    expect(m.fetch.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  });

  it("switching kind keeps the name, labels, egress and repo scope", async () => {
    const m = await mount(lists);
    await openAdd(m);
    await type(field(m.root, "name"), "shared");
    labelInput(m.root).value = "gpu";
    await fire(labelInput(m.root), "keydown", { key: "Enter" });
    await fire(radio(m.root, "egress", "none"), "click");
    await press(button(dialog(m.root), "Selected"));
    const box = all(dialog(m.root)).find((n) => n.type === "checkbox" && n.parentNode.textContent === "acme/api");
    box.checked = true; // a browser toggles a checkbox before its click event
    await fire(box, "click");
    await fire(radio(m.root, "kind", "byo"), "click");
    expect(all(dialog(m.root)).some((n) => n.textContent === "Register workers")).toBe(true);
    expect([field(m.root, "name").value, chips(m.root), radio(m.root, "egress", "none").checked, button(dialog(m.root), "Selected").attrs["aria-selected"], box.checked])
      .toEqual(["shared", ["gpu"], true, "true", true]);
  });

  it("a 409 name_taken shows an inline error announced in the live region", async () => {
    const m = await mount((url, init) => (init?.method === "POST" ? Response.json({ error: { code: "name_taken", message: "a pool named eu-gpu already exists" } }, { status: 409 }) : lists(url)));
    await openAdd(m);
    await fire(radio(m.root, "kind", "byo"), "click");
    await type(field(m.root, "name"), "eu-gpu");
    await fire(all(dialog(m.root)).find((n) => n.nodeName === "FORM"), "submit");
    const err = all(dialog(m.root)).find((n) => n.attrs.id === "wm-nerr");
    expect([err.attrs.role, err.textContent, field(m.root, "name").attrs["aria-invalid"], dialog(m.root).open]).toEqual(["alert", "A pool named eu-gpu already exists.", "true", true]);
  });

  it("a refused managed-pool PUT followed by Create again sends one PUT and no second POST", async () => {
    let refuse = true;
    const m = await mount((url, init) => (init?.method === "POST" ? Response.json({ ...pools[0], id: "p_gpu", name: "gpu" }, { status: 201 })
      : init?.method === "PUT" ? (refuse ? Response.json({ error: { code: "invalid", message: "bad egress host" } }, { status: 400 }) : Response.json({})) : lists(url)));
    await openAdd(m);
    await type(field(m.root, "name"), "gpu");
    const submit = () => fire(all(dialog(m.root)).find((n) => n.nodeName === "FORM"), "submit");
    await submit();
    expect(dialog(m.root).open).toBe(true);
    refuse = false;
    await submit();
    const writes = m.fetch.mock.calls.filter(([, init]) => init?.method).map(([url, init]) => `${init.method} ${url}`);
    expect(writes).toEqual(["POST /api/workers/pools", "PUT /api/workers/pools/p_gpu", "PUT /api/workers/pools/p_gpu"]);
  });

  it("Enter or comma adds a label chip and × removes it", async () => {
    const m = await mount(lists);
    await openAdd(m);
    for (const [v, key] of [["gpu", "Enter"], ["large-disk", ","], ["gpu", "Enter"]]) {
      labelInput(m.root).value = v;
      await fire(labelInput(m.root), "keydown", { key });
    }
    expect([chips(m.root), labelInput(m.root).value]).toEqual([["gpu", "large-disk"], ""]);
    await press(all(dialog(m.root)).find((n) => n.attrs["aria-label"] === "Remove gpu"));
    expect(chips(m.root)).toEqual(["large-disk"]);
  });

  it("the minted token is shown once and gone after the modal closes", async () => {
    const m = await mount((url, init) => (init?.method === "POST" ? Response.json({ token: "pt-secret", expires_at: "2026-10-09T00:00:00Z" }, { status: 201 }) : lists(url)));
    await press(button(cards(m.root)[1], "Edit"));
    await press(button(dialog(m.root), "Mint token"));
    expect(m.fetch.mock.calls.find(([, init]) => init?.method === "POST")[0]).toBe(`/api/workers/byo-pools/${byo[0].id}/tokens`);
    expect([dialog(m.root).textContent.match(/pt-secret/g).length > 0, button(dialog(m.root), "Mint token")]).toEqual([true, undefined]);
    await press(button(dialog(m.root), "Cancel"));
    await press(button(cards(m.root)[1], "Edit"));
    expect([m.root.textContent.includes("pt-secret"), Boolean(button(dialog(m.root), "Mint token"))]).toEqual([false, true]);
  });

  it("the registration status flips from Waiting for the first heartbeat to 1 of 1 online when the pool reports a member", async () => {
    let fresh = { ...byo[0], members: 0, online: 0 };
    const m = await mount((url) => (url.endsWith("/byo-pools") ? Response.json([fresh]) : lists(url)));
    vi.useFakeTimers();
    await press(button(cards(m.root)[1], "Edit"));
    const status = () => all(dialog(m.root)).find((n) => n.attrs["aria-live"] === "polite").textContent;
    expect(status()).toBe("Waiting for the first heartbeat…");
    fresh = { ...fresh, members: 1, online: 1 };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(status()).toBe("1 of 1 online");
  });

  it("the managed pool's danger zone offers Drain and no Delete; a BYO Delete needs a second click", async () => {
    const m = await mount((url, init) => (init?.method ? new Response(null, { status: 204 }) : lists(url)));
    await press(button(cards(m.root)[0], "Edit"));
    const zone = () => all(dialog(m.root)).find((n) => n.attrs.class === "wm-s wm-dz");
    expect(["disabled" in field(m.root, "name").attrs, Boolean(button(zone(), "Drain")), all(zone()).some((n) => n.nodeName === "BUTTON" && /delete/i.test(n.textContent))]).toEqual([true, true, false]);
    await press(button(zone(), "Drain"));
    expect(m.fetch.mock.calls.find(([, init]) => init?.method === "POST")[0]).toBe("/api/workers/pools/p_build/drain");
    await press(button(cards(m.root)[1], "Edit"));
    await press(button(zone(), "Delete"));
    expect(m.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
    await press(button(zone(), "Click again to delete"));
    expect(m.fetch.mock.calls.find(([, init]) => init?.method === "DELETE")[0]).toBe(`/api/workers/byo-pools/${byo[0].id}`);
  });

  it("a BYO pool lists its issued tokens and Revoke needs a second click; with none it says No tokens issued", async () => {
    let issued = poolTokens;
    const m = await mount((url, init) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : url.endsWith("/tokens") ? Response.json(issued) : lists(url)));
    await press(button(cards(m.root)[1], "Edit"));
    const text = dialog(m.root).textContent;
    expect([text.includes("9f2c41ab ••••"), text.includes("maya@example.com"), text.includes("never")]).toEqual([true, true, true]);
    await press(all(dialog(m.root)).filter((n) => n.nodeName === "BUTTON" && n.textContent === "Revoke")[0]);
    expect(m.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
    issued = [];
    await press(button(dialog(m.root), "Click again to revoke"));
    expect(m.fetch.mock.calls.find(([, init]) => init?.method === "DELETE")[0]).toBe(`/api/workers/byo-pools/${byo[0].id}/tokens/9f2c41ab`);
    expect(dialog(m.root).textContent).toContain("No tokens issued for this pool.");
  });

  it("label chips centre their text in the bubble", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("styles/workers.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.chips \.pill\{[^}]*display:inline-flex;align-items:center;[^}]*line-height:1;/);
  });
});
