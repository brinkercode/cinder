import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Access, accessLoader } = await import("./access.jsx");

const GROUPS = [{ name: "eng-payments", source: "Access group", role: "maintainer", repos: ["billing-api", "ledger-ui"] }];
const PEOPLE = [{ email: "maya@nimbusedge.dev", owner: false, role: "owner", created_at: "2026-10-01T00:00:00Z", last_seen: null }];

// answer(url, init): each request's Response, or a pending Promise.
const mount = async (answer) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  const fetch = vi.fn(async (url, init) => answer(url, init));
  vi.stubGlobal("fetch", fetch);
  const router = createMemoryRouter([{ path: "/settings/access", element: <Access />, loader: accessLoader }], { initialEntries: ["/settings/access"] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return { root, fetch, find: (pred) => all(root).find(pred) };
};
const TOKENS = [{ client_id: "abc.access", name: "ci-bot" }];
const lists = (groups, people = PEOPLE) => (url) => Response.json(url === "/api/groups" ? groups : url === "/api/service-tokens" ? TOKENS : people);

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("access & people", () => {
  it("access loading shows skeletons, then the mapping and people tables", async () => {
    const loading = await mount(() => new Promise(() => {}));
    expect(loading.find((n) => n.attrs["aria-busy"] === "true").childNodes).toHaveLength(4);
    const { root } = await mount(lists(GROUPS));
    expect(root.textContent).toContain("Access groupeng-paymentsOwnerMaintainerContributorbilling-api, ledger-ui");
    expect(root.textContent).toContain("mayamaya@nimbusedge.devOwnerMaintainerContributorneverRemove maya");
    expect(root.textContent).toContain("ci-bot@service-tokenabc.accessRemove");
  });

  it("the People card invites from its own button, and someone invited in Cloudflare Access lists with a role control", async () => {
    const dash = { email: "dash@example.com", owner: false, role: null, created_at: "2026-10-12T09:00:00Z", last_seen: null, invited: "access" };
    const { root, find } = await mount(lists(GROUPS, [...PEOPLE, dash]));
    expect(root.textContent).toContain("dashdash@example.comNo roleOwnerMaintainerContributorInvited in Cloudflare Access · not signed in");
    const people = find((n) => n.tagName === "H3" && n.textContent === "People").parentNode;
    const invite = all(people).find((n) => n.tagName === "BUTTON" && n.textContent === "Invite");
    expect(invite).toBeTruthy();
    const dialog = find((n) => n.tagName === "DIALOG" && n.textContent.includes("Invite people"));
    dialog.showModal = vi.fn();
    await act(async () => click(invite));
    expect(dialog.showModal).toHaveBeenCalled();
  });

  it("loaded cards keep the skeleton's heights", async () => {
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    // [title, table rows] per card: the loaded page records its shape, the next skeleton draws the same cards and rows.
    const cards = (root) => all(root).filter((n) => n.attrs.class === "card").map((c) => [all(c).find((n) => n.nodeName === "H3").textContent,
      all(c).filter((n) => n.nodeName === "TR" && n.parentNode.nodeName === "TBODY").length]);
    const loaded = cards((await mount(lists(GROUPS))).root);
    expect(cards((await mount(() => new Promise(() => {}))).root)).toEqual(loaded);
    expect(loaded.map(([t]) => t)).toEqual(["Group → role mapping", "People", "Service tokens", "Cinder roles"]);
    // A skeleton row is 44px; loaded rows hold the same height, their selects and buttons inside it.
    expect(readFileSync(new URL("./styles/access.css", import.meta.url), "utf8")).toContain(".access .tbl tbody tr{height:44px}.access .tbl td{padding-block:0}");
    delete globalThis.localStorage;
  });

  it("access error shows the card error with Retry", async () => {
    const { find } = await mount(() => new Response("", { status: 503 }));
    expect(find((n) => n.attrs.role === "alert").textContent).toBe("Couldn't load access: /api/groups: HTTP 503Retry");
  });

  it("access with no mappings shows the hint", async () => {
    const { root } = await mount(lists([]));
    expect(root.textContent).toContain("No mappings yet. Map an Access group, IdP group or Cloudflare User Group to a cinder role.");
  });

  it("policy editing links out to Zero Trust; the page has no policy controls", async () => {
    const { find, root } = await mount(lists(GROUPS));
    const link = find((n) => n.nodeName === "A" && n.textContent === "Zero Trust › Access");
    expect([link.attrs.href, link.attrs.target]).toEqual(["https://one.dash.cloudflare.com/", "_blank"]);
    expect(root.textContent).not.toMatch(/policy (rule|include|exclude)/i);
  });

  it("the role select saves inline and goes back if the save fails", async () => {
    let fail = false;
    const { fetch, find } = await mount((url, init) => (init?.method === "PUT" ? (fail ? Response.json({ error: { message: "nope" } }, { status: 500 }) : Response.json({})) : lists(GROUPS)(url)));
    const select = find((n) => n.attrs["aria-label"] === "Cinder role of eng-payments");
    const change = (value) => act(async () => { select.value = value; for (let n = select; n; n = n.parentNode) for (const f of n.listeners.change ?? []) f({ type: "change", target: select, bubbles: true, preventDefault() {}, stopPropagation() {} }); });
    await change("owner");
    expect(fetch).toHaveBeenCalledWith("/api/groups/eng-payments", expect.objectContaining({ method: "PUT", body: JSON.stringify({ ...GROUPS[0], role: "owner" }) }));
    fail = true;
    await change("contributor");
    expect([select.value, find((n) => n.attrs.role === "alert").textContent]).toEqual(["maintainer", "PUT /api/groups/eng-payments → 500 nope"]);
  });

  it("removing or demoting the last owner is blocked on the client", async () => {
    El.prototype.showModal = function () { this.open = true; };
    const { fetch, find } = await mount(lists(GROUPS));
    const select = find((n) => n.attrs["aria-label"] === "Role of maya@nimbusedge.dev");
    await act(async () => { select.value = "maintainer"; for (let n = select; n; n = n.parentNode) for (const f of n.listeners.change ?? []) f({ type: "change", target: select, bubbles: true, preventDefault() {}, stopPropagation() {} }); });
    const guard = () => find((n) => n.nodeName === "DIALOG" && n.open && n.textContent.startsWith("Can't"));
    expect(select.value).toBe("owner");
    expect(guard().textContent).toContain("Can't change maya's rolemaya is the only owner.");
    guard().open = false;
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Remove maya")));
    expect(guard().textContent).toContain("Can't remove mayamaya is the only owner.");
    expect(fetch.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
    delete El.prototype.showModal;
  });

  it("map a group opens with Contributor and sends role contributor with only a group name", async () => {
    // fake-dom has no option list or FormData: give selects their options (React marks the defaultValue one selected) and read named fields.
    const create = El.prototype.createElement;
    vi.spyOn(El.prototype, "createElement").mockImplementation(function (t) {
      const el = create.call(this, t);
      if (t === "select") Object.defineProperty(el, "options", { get: () => el.childNodes });
      if (t === "option") Object.defineProperty(el, "value", { get: () => el.attrs.value ?? el.textContent, set: (v) => { el.attrs.value = v; } });
      return el;
    });
    vi.stubGlobal("FormData", function (form) {
      return all(form).filter((n) => n.attrs.name ?? n.name).map((n) => [n.attrs.name ?? n.name, n.nodeName === "SELECT" ? (n.options.find((o) => o.selected) ?? n.options[0]).value : n.value ?? ""]);
    });
    const { fetch, find } = await mount((url, init) => (init?.method === "POST" ? Response.json({}) : lists(GROUPS)(url)));
    vi.restoreAllMocks();
    const dialog = find((n) => n.nodeName === "DIALOG" && n.textContent.startsWith("Map a group"));
    const role = all(dialog).find((n) => n.attrs.name === "role");
    expect(role.options.find((o) => o.selected).textContent).toBe("Contributor");
    all(dialog).find((n) => n.name === "name").value = "eng-all";
    dialog.querySelector = () => all(dialog).find((n) => n.nodeName === "FORM");
    dialog.returnValue = "ok";
    await act(async () => { for (const f of dialog.listeners.close) f({ type: "close", target: dialog, bubbles: false, preventDefault() {}, stopPropagation() {} }); });
    expect(fetch).toHaveBeenCalledWith("/api/groups", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "eng-all", source: "Access group", role: "contributor", repos: [] }) }));
  });

  it("add account sends name, slug and organization to POST /api/accounts", async () => {
    vi.stubGlobal("FormData", function (form) { return all(form).filter((n) => n.name).map((n) => [n.name, n.value ?? ""]); });
    const { fetch, find } = await mount((url, init) => (init?.method === "POST" ? Response.json({}, { status: 201 }) : lists(GROUPS)(url)));
    const dialog = find((n) => n.nodeName === "DIALOG" && n.textContent.startsWith("Add account"));
    for (const [k, v] of [["name", "Acme Labs"], ["slug", "acme-labs"], ["organization", "Acme"]]) all(dialog).find((n) => n.name === k).value = v;
    dialog.querySelector = () => all(dialog).find((n) => n.nodeName === "FORM");
    dialog.returnValue = "ok";
    await act(async () => { for (const f of dialog.listeners.close) f({ type: "close", target: dialog, bubbles: false, preventDefault() {}, stopPropagation() {} }); });
    expect(fetch).toHaveBeenCalledWith("/api/accounts", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Acme Labs", slug: "acme-labs", organization: "Acme" }) }));
  });

  it("the Demo data card starts a reseed and shows its progress", async () => {
    El.prototype.showModal = function () { this.open = true; };
    (await import("./client.js")).invalidate(); // an earlier test's /api/me answer
    let polls = 0;
    const { fetch, find } = await mount((url, init) => {
      if (url === "/api/me") return Response.json({ email: null, owner: true, nonprod: true });
      if (url === "/api/admin/seed") return Response.json({ id: "s1" }, { status: 202 });
      if (url === "/api/admin/seed/s1") return Response.json({ id: "s1", status: polls++ ? "done" : "running", step: polls > 1 ? "seed" : "reset", error: null });
      return lists(GROUPS)(url, init);
    });
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Reset and reseed…")));
    const dialog = find((n) => n.nodeName === "DIALOG" && n.open);
    expect(dialog.textContent).toContain("Erases every repo and its history");
    dialog.returnValue = "ok";
    await act(async () => { for (const f of dialog.listeners.close) f({ type: "close", currentTarget: dialog, target: dialog, bubbles: false, preventDefault() {}, stopPropagation() {} }); });
    expect(fetch).toHaveBeenCalledWith("/api/admin/seed", expect.objectContaining({ method: "POST" }));
    const status = () => find((n) => n.attrs.role === "status").textContent;
    expect(status()).toBe("Running: reset…");
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    expect(status()).toBe("Reseeded: the demo repos, people, agents and pools are back.");
    delete El.prototype.showModal;
  });
});
