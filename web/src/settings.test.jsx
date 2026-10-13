import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

// Browsers have oninput; react-dom checks for it once, at import, to pick its text-input change events.
doc.oninput = null;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Settings, settingsLoader } = await import("./settings.jsx");

Object.assign(El.prototype, { showModal() { this.attrs.open = ""; }, close() {} });
// The section nav's observer: spy.cb takes entries, spy.els holds what it watches.
const spy = { cb: null, els: [] };
vi.stubGlobal("IntersectionObserver", class { constructor(cb) { Object.assign(spy, { cb, els: [] }); } observe(el) { spy.els.push(el); } disconnect() {} });
doc.getElementById = (id) => all(doc).find((n) => n.attrs?.id === id) ?? null;
Object.defineProperty(El.prototype, "id", { get() { return this.attrs.id ?? ""; } });

const T = "2026-10-01T00:00:00Z";
const API = "/api/repos/web";
const REPO = { id: "r", name: "web", default_branch: "main", strategy: "trunk", created_at: T,
  branch_policy: { integration: ["main"], release: [], check: "make check", stack: "code@stable" } };
const SOURCES = { integration: "repo", release: "repo", check: "repo", rules: "repo" };
const POLICY = { integration: ["main"], release: [], check: "make check", stack: "code@stable", sources: SOURCES, defaulted: false,
  rules: [{ branch: "main", queue: true, judges: 1, risk: 10, route: [] }] };
const ROLES = ["owner", "maintainer", "contributor"].map((name) => ({ name, capabilities: [], built_in: true }));
const person = (email) => ({ email, owner: false, role: null, created_at: T, last_seen: null });
const hook = (last_delivery) => ({ id: "h1", url: "https://hooks.example/in", events: ["change"], created_at: T, last_delivery });
const GET = {
  [`${API}/settings`]: { description: "Edge", language: "Go", visibility: "private", default_branch: "main", strategy: "trunk", flake_quarantine: 0.2,
    mirror_url: null, scans_paused: false, auto_quarantine: true, can_reimport: true, created_at: T },
  [`${API}/branches`]: [{ name: "main", kind: "branch", default: true, head_sha: null, ahead: 0, behind: 0, open_changes: 0, last_commit: null, role: "integration" }],
  [`${API}/policy`]: POLICY,
  "/api/groups": [{ name: "eng-all", source: "Access group", role: "contributor", repos: [] }],
  [`${API}/people`]: [{ email: "a@x.dev", role: "maintainer", set_by: null, at: null }],
  "/api/people": [person("a@x.dev"), person("b@x.dev")],
  "/api/roles": ROLES,
  [`${API}/webhooks`]: [],
  [`${API}/environments`]: [],
  "/api/me": { email: "o@x.dev", owner: true },
  [`${API}/branch-deploys`]: [{ branch: "main", environment: "production" }, { branch: "develop", environment: "staging" }],
  [`${API}/flakes`]: [],
  [`${API}/routing`]: { rules: [{ label: "docs", agent: "docs@v2" }] },
};

// over: GET bodies by path, or "METHOD path" answers; a function gets the request init and returns the Response.
const mount = async (over = {}, { repo = REPO, storage = {} } = {}) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("localStorage", { getItem: (k) => storage[k] ?? null, setItem() {} });
  const api = { ...GET, ...over };
  const fetch = vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    const v = key in api ? api[key] : init.method ? {} : api[url];
    return typeof v === "function" ? v(init) : Response.json(v ?? {});
  });
  vi.stubGlobal("fetch", fetch);
  const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [{ path: "settings", element: <Settings />, loader: settingsLoader }] },
    { path: "/", element: <p>home</p> }], { initialEntries: ["/web/settings"] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await settle();
  const sent = (method, path) => fetch.mock.calls.filter(([u, i = {}]) => u === path && (i.method ?? "GET") === method).map(([, i]) => i?.body && JSON.parse(i.body));
  return { root, fetch, sent, router };
};
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const fire = (el, type) => { for (let n = el; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f({ type, target: el, bubbles: true, preventDefault() {}, stopPropagation() {} }); };
const press = async (el) => { await act(async () => click(el)); await settle(); };
// React reads an input's type property, which fake-dom only has as an attribute.
const type = async (el, value) => { await act(async () => { el.type = el.attrs.type ?? "text"; el.value = value; fire(el, "input"); }); await settle(); };
const named = (scope, name, tag = "BUTTON") => all(scope).find((n) => n.nodeName === tag && (n.textContent === name || n.attrs["aria-label"] === name));
const card = (root, title) => all(root).find((n) => n.attrs.class?.split(" ").includes("card") && n.childNodes[0]?.attrs.class === "card-h" && n.childNodes[0].childNodes[0].textContent === title);
const dialog = (root) => all(root).find((n) => n.nodeName === "DIALOG");
const field = (scope, label) => all(scope).find((n) => n.nodeName === "LABEL" && n.childNodes[0].textContent.startsWith(label)).childNodes[1];
const options = (select) => select.childNodes.map((o) => o.textContent);

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("repo settings", () => {
  it("Label routing lists rules, adds one after them and removes one, each saved as the whole list", async () => {
    const { root, sent } = await mount({ [`PUT ${API}/routing`]: (init) => Response.json(JSON.parse(init.body)) });
    const c = card(root, "Label routing");
    expect(c.textContent).toContain("docsAgentdocs@v2");
    expect(c.textContent).toContain("First matching rule wins.");
    await type(named(c, "Rule label", "INPUT"), "pay");
    await act(async () => { const sel = named(c, "Route to", "SELECT"); sel.value = "driver"; fire(sel, "change"); });
    await type(named(c, "Who", "INPUT"), "ann@x.dev");
    await press(named(c, "Add rule"));
    await press(named(c, "Remove rule 1"));
    expect(sent("PUT", `${API}/routing`)).toEqual([{ rules: [{ label: "docs", agent: "docs@v2" }, { label: "pay", driver: "ann@x.dev" }] }, { rules: [] }]);
  });

  it("settings places Branch policy, Flaky checks, Mirror and Import in the section order, each card id matching its nav anchor", async () => {
    const { root } = await mount();
    const titles = all(root).filter((n) => n.attrs.class?.split(" ").includes("card-h")).map((n) => n.childNodes[0].textContent);
    const order = ["About", "Repository", "Branch policy", "Repo roles", "Label routing", "Flaky checks", "Webhooks", "Environments", "Mirror", "Import", "Danger zone"];
    expect(titles.filter((t) => order.includes(t))).toEqual(order);
    const nav = all(root).find((n) => n.nodeName === "NAV" && n.attrs["aria-label"] === "Settings sections");
    expect(nav.childNodes.map((a) => a.attrs.href)).toEqual(order.map((t) => `#${card(root, t).attrs.id}`));
    expect(root.textContent).toContain("Configuration for web. Branch policy and judges also live in .cinder.yml.");
    expect(all(root).some((n) => n.nodeName === "H2" && n.attrs.class === "sec-h")).toBe(false);
  });

  it("Settings' section nav highlights the section in view; at 390px it becomes a horizontal scroller", async () => {
    const { root } = await mount();
    const nav = all(root).find((n) => n.nodeName === "NAV" && n.attrs["aria-label"] === "Settings sections");
    const current = () => nav.childNodes.filter((a) => a.attrs["aria-current"]).map((a) => a.textContent);
    expect(nav.childNodes.map((a) => a.textContent)).toEqual(["About", "Repository", "Branch policy", "Repo roles", "Label routing", "Flaky checks", "Webhooks", "Environments", "Mirror", "Import", "Danger zone"]);
    expect(current()).toEqual(["About"]);
    const webhooks = spy.els.find((el) => el.attrs.id === "webhooks");
    expect(card(root, "Webhooks").attrs.id).toBe("webhooks");
    await act(async () => spy.cb([{ target: spy.els[0], isIntersecting: false }, { target: webhooks, isIntersecting: true }]));
    expect(current()).toEqual(["Webhooks"]);

    const css = readFileSync(new URL("styles/settings.css", import.meta.url), "utf8");
    const narrow = /@media \(max-width:900px\)\{.*\.set-nav\{([^}]*)\}/.exec(css)?.[1].split(";");
    expect(narrow).toEqual(expect.arrayContaining(["position:static", "flex-direction:row", "overflow-x:auto"]));
  });

  it("Save about sends exactly {description, language} and a blank language sends null", async () => {
    const { root, sent } = await mount();
    await type(field(card(root, "About"), "Language"), "  ");
    await press(named(root, "Save about"));
    expect(sent("PUT", `${API}/settings`)).toEqual([{ description: "Edge", language: null }]);
    expect(named(card(root, "About"), "Saved.", "SPAN").attrs.role).toBe("status");
  });

  it("Save repository sends {default_branch, strategy} and the policy card re-fetches", async () => {
    const { root, sent } = await mount();
    expect(sent("GET", `${API}/policy`)).toHaveLength(1);
    await press(named(card(root, "Repository"), "gitflow"));
    await press(named(root, "Save repository"));
    expect(sent("PUT", `${API}/settings`)).toEqual([{ default_branch: "main", strategy: "gitflow" }]);
    expect(sent("GET", `${API}/policy`)).toHaveLength(2);
  });

  it("the Repository card states that the verifier owns every merge without a checkbox", async () => {
    const { root } = await mount();
    const repo = card(root, "Repository");
    expect(all(repo).some((n) => n.nodeName === "P" && n.textContent === "Verifier owns every merge on integration branches.")).toBe(true);
    expect(all(root).some((n) => n.nodeName === "INPUT" && n.attrs["aria-label"] === "Verifier owns every merge")).toBe(false);
  });

  it("settings shows no Visibility row and no Topics card", async () => {
    const { root } = await mount();
    expect(root.textContent).not.toMatch(/Visibility|Topics|Instance/);
    expect(card(root, "Topics")).toBeUndefined();
  });

  it("a defaulted policy renders the hint card and default tags", async () => {
    const defaults = { integration: "default", release: "default", check: "default", rules: "default" };
    const { root } = await mount({ [`${API}/policy`]: { ...POLICY, defaulted: true, sources: defaults } });
    expect(root.textContent).toContain("No .cinder.yml yet. These are the defaults; saving commits one to main.");
    const policyCard = card(root, "Branch policy");
    const tags = all(policyCard).filter((n) => n.attrs.class === "tag").map((n) => n.textContent);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((t) => t === "default")).toBe(true);
    expect(all(policyCard).find((n) => n.attrs.class === "pill").textContent).toBe("defaults");
  });

  it("Save policy is disabled until the draft changes, then sends integration, release, check and rules", async () => {
    const { root, sent } = await mount({ [`PUT ${API}/policy`]: () => Response.json({ sha: "abcdef1234" }, { status: 201 }) });
    const save = named(root, "Save policy");
    expect("disabled" in save.attrs).toBe(true);
    await type(field(card(root, "Branch policy"), "Check command"), "npm test");
    expect("disabled" in save.attrs).toBe(false);
    await press(save);
    expect(sent("PUT", `${API}/policy`)).toEqual([{ integration: ["main"], release: [], check: "npm test",
      rules: [{ branch: "main", queue: true, judges: 1, risk: 10, route: [] }] }]);
    expect(root.textContent).toContain("Committed .cinder.yml · abcdef1");
  });

  it("Branch policy still saves in its place between Repository and Repo roles", async () => {
    const { root, sent } = await mount({ [`PUT ${API}/policy`]: () => Response.json({ sha: "abcdef1234" }, { status: 201 }) });
    const nodes = all(root), at = (t) => nodes.indexOf(card(root, t));
    expect(at("Branch policy")).toBeGreaterThan(at("Repository"));
    expect(at("Branch policy")).toBeLessThan(at("Repo roles"));
    await type(field(card(root, "Branch policy"), "Check command"), "npm test");
    await press(named(root, "Save policy"));
    expect(sent("PUT", `${API}/policy`)).toHaveLength(1);
    expect(root.textContent).toContain("Committed .cinder.yml · abcdef1");
  });

  it("settings has no Promotions card", async () => {
    const { root } = await mount({ [`${API}/policy`]: { ...POLICY, promote: [{ from: "develop", to: "main" }] } });
    expect(all(root).filter((n) => /^Promot/.test(n.attrs?.["aria-label"] ?? ""))).toEqual([]);
    expect(root.textContent).not.toMatch(/promotion|develop/i);
  });

  it("a 409 policy save shows moved since this page loaded with Reload", async () => {
    // The server answers 409 to the loaded base sha only when it is stale; without base_sha the save would commit.
    const { root, sent } = await mount({ [`${API}/policy`]: { ...POLICY, base_sha: "a474c1f" },
      [`PUT ${API}/policy`]: (init) => (JSON.parse(init.body).base_sha === "a474c1f" ? Response.json({ error: { message: "main moved" } }, { status: 409 })
        : Response.json({ sha: "abcdef1234" }, { status: 201 })) });
    await type(field(card(root, "Branch policy"), "Check command"), "npm test");
    await press(named(root, "Save policy"));
    expect(sent("PUT", `${API}/policy`)[0].base_sha).toBe("a474c1f");
    expect(all(root).find((n) => n.attrs.role === "alert").textContent).toBe("main moved since this page loaded. Reload");
  });

  it("a 409 renders the moved-head message with Reload, and Reload keeps the draft", async () => {
    const { root, sent } = await mount({ [`PUT ${API}/policy`]: () => Response.json({ error: { message: "head moved" } }, { status: 409 }) });
    const check = field(card(root, "Branch policy"), "Check command");
    await type(check, "npm test");
    await press(named(root, "Save policy"));
    expect(all(root).find((n) => n.attrs.role === "alert").textContent).toBe("main moved since this page loaded. Reload");
    await press(named(root, "Reload"));
    expect(sent("GET", `${API}/policy`)).toHaveLength(2);
    expect(field(card(root, "Branch policy"), "Check command").value).toBe("npm test");
  });

  it("the read-only .cinder.yml card renders no inputs", async () => {
    const { root } = await mount({ [`${API}/policy`]: { ...POLICY, overlap: "wait" } });
    const readOnly = card(root, "Also read from .cinder.yml");
    expect(readOnly.textContent).toContain("OverlapwaitUnresolved threads block mergenot set");
    expect(all(readOnly).some((n) => ["INPUT", "SELECT", "TEXTAREA"].includes(n.nodeName))).toBe(false);
  });

  it("Groups lists only the mappings that apply to this repo", async () => {
    const g = (name, repos) => ({ name, source: "Access group", role: "contributor", repos });
    const { root } = await mount({ "/api/groups": [g("everyone", []), g("web-team", ["web"]), g("api-team", ["api"])] });
    const rows = all(card(root, "Groups with access")).filter((n) => n.nodeName === "TR").slice(1).map((n) => n.textContent);
    expect(rows).toEqual(["Access groupeveryonecontributorall repos", "Access groupweb-teamcontributorthis repo"]);
  });

  it("changing a Role select sends PUT …/people/{email}", async () => {
    const { root, sent } = await mount();
    const select = named(root, "Repo role of a@x.dev", "SELECT");
    await act(async () => { select.value = "contributor"; fire(select, "change"); });
    await settle();
    expect(sent("PUT", `${API}/people/a%40x.dev`)).toEqual([{ role: "contributor" }]);
  });

  it("Remove sends DELETE …/people/{email}", async () => {
    vi.stubGlobal("confirm", () => true);
    const { root, sent } = await mount();
    await press(named(card(root, "Repo roles"), "Remove"));
    expect(sent("DELETE", `${API}/people/a%40x.dev`)).toHaveLength(1);
  });

  it("the Person select leaves out people who already hold a repo role", async () => {
    const { root } = await mount();
    expect(options(named(root, "Person", "SELECT"))).toEqual(["Person", "b@x.dev"]);
  });

  it("a custom role from the stub renders in the Role select", async () => {
    const { root } = await mount({ "/api/roles": [...ROLES, { name: "auditor", capabilities: ["repo.read"], built_in: false }] });
    expect(options(named(root, "Repo role of a@x.dev", "SELECT"))).toEqual(["owner", "maintainer", "contributor", "auditor"]);
    expect(options(named(root, "New repo role", "SELECT"))).toContain("auditor");
  });

  it("a webhook secret renders once after add or rotate, and is gone when the modal reopens", async () => {
    const { root, sent } = await mount({ [`${API}/webhooks`]: [hook(null)],
      [`POST ${API}/webhooks`]: () => Response.json({ ...hook(null), secret: "whsec_add" }, { status: 201 }),
      [`POST ${API}/webhooks/h1/rotate`]: () => Response.json({ secret: "whsec_rot" }) });
    const shows = (secret) => all(root).some((n) => n.value === secret);
    await press(named(root, "Add webhook"));
    await type(field(dialog(root), "URL"), "https://hooks.example/new");
    await press(named(dialog(root), "Add"));
    expect(sent("POST", `${API}/webhooks`)).toEqual([{ url: "https://hooks.example/new", events: ["change", "verdict", "judgment"] }]);
    expect(shows("whsec_add")).toBe(true);
    await press(named(dialog(root), "Done"));
    await press(named(root, "Add webhook"));
    expect(shows("whsec_add")).toBe(false);
    await press(named(dialog(root), "Cancel"));
    await press(named(root, "Rotate secret"));
    await press(named(dialog(root), "Rotate"));
    expect(shows("whsec_rot")).toBe(true);
    await press(named(dialog(root), "Done"));
    await press(named(root, "Rotate secret"));
    expect(shows("whsec_rot")).toBe(false);
  });

  it("Edit events PATCHes the webhook's events in place", async () => {
    const { root, sent } = await mount({ [`${API}/webhooks`]: [hook(null)] });
    await press(named(card(root, "Webhooks"), "Edit events"));
    const box = all(dialog(root)).find((n) => n.nodeName === "LABEL" && n.textContent === "verdict").childNodes[0];
    await act(async () => { Object.assign(box, { type: "checkbox", checked: true }); click(box); });
    await press(named(dialog(root), "Save"));
    expect(sent("PATCH", `${API}/webhooks/h1`)).toEqual([{ events: ["change", "verdict"] }]);
    expect(dialog(root)).toBeUndefined();
  });

  it("a failed delivery renders the failing pill with the code", async () => {
    const { root } = await mount({ [`${API}/webhooks`]: [hook({ at: T, ok: false, status: 502, error: null })] });
    const cell = all(card(root, "Webhooks")).find((n) => n.nodeName === "TD" && n.textContent.includes("failing"));
    expect(named(cell, "failing", "SPAN").attrs.class).toBe("pill");
    expect(cell.textContent).toMatch(/^failing 502 · /);
  });

  it("when can_reimport is false, Re-import… is disabled and shows the help line", async () => {
    const { root } = await mount({ [`${API}/settings`]: { ...GET[`${API}/settings`], can_reimport: false } });
    expect("disabled" in named(root, "Re-import…").attrs).toBe(true);
    expect(card(root, "Import").textContent).toContain("This repo has files, so it can't be re-imported.");
  });

  it("the re-import token hint says it is kept in Keystore for re-imports", async () => {
    const { root } = await mount();
    await press(named(root, "Re-import…"));
    expect(field(dialog(root), "Token").getAttribute("placeholder")).toBe("kept encrypted in Keystore for re-imports; remove it there");
  });

  it("the token field is empty after both success and failure", async () => {
    let answer;
    const { root } = await mount({ [`POST ${API}/import`]: () => answer() });
    await press(named(root, "Re-import…"));
    const fill = async () => { await type(field(dialog(root), "Clone URL"), "https://git.example/x.git"); await type(field(dialog(root), "Token"), "ghp_secret"); };
    answer = () => Response.json({ error: { message: "import failed" } }, { status: 502 });
    await fill();
    await press(named(dialog(root), "Re-import"));
    expect([field(dialog(root), "Token").value, all(dialog(root)).find((n) => n.attrs.role === "alert").textContent]).toEqual(["", "POST /api/repos/web/import → 502 import failed"]);
    let land;
    answer = () => new Promise((r) => { land = () => r(Response.json(REPO)); });
    await fill();
    await press(named(dialog(root), "Re-import"));
    expect(field(dialog(root), "Token").value).toBe("");
    await act(async () => land());
    await settle();
    expect(dialog(root)).toBeUndefined();
    expect(root.textContent).toContain("Importing from https://git.example/x.git. Code shows the files once it lands.");
  });

  it("Archive posts only after the confirm action", async () => {
    const { root, sent, router } = await mount();
    await press(named(root, "Archive"));
    expect(sent("POST", `${API}/archive`)).toHaveLength(0);
    expect(dialog(root).attrs["aria-label"]).toBe("Archive web?");
    await press(named(dialog(root), "Archive"));
    expect(sent("POST", `${API}/archive`)).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/");
  });

  it("the Delete row is absent when owner is false", async () => {
    const { root } = await mount({ "/api/me": { email: "m@x.dev", owner: false } });
    expect(named(root, "Delete…")).toBeUndefined();
    expect(root.textContent).not.toContain("Delete this repo");
    expect(root.textContent).toContain("Archive this repo");
  });

  it("Delete is disabled until the typed name matches, then sends DELETE /api/repos/:name {confirm}", async () => {
    const { root, sent, router } = await mount({ [`DELETE ${API}`]: () => new Response(null, { status: 204 }) });
    await press(named(root, "Delete…"));
    const del = named(dialog(root), "Delete");
    expect("disabled" in del.attrs).toBe(true);
    await type(field(dialog(root), "Type"), "we");
    expect("disabled" in del.attrs).toBe(true);
    await type(field(dialog(root), "Type"), "web");
    expect("disabled" in del.attrs).toBe(false);
    await press(del);
    expect(sent("DELETE", API)).toEqual([{ confirm: "web" }]);
    expect([router.state.location.pathname, router.state.location.state]).toEqual(["/", { deleted: "web" }]);
  });

  it("a stored shape of n renders n bones, and n = 0 renders the empty state with no bones", async () => {
    const pending = { [`${API}/webhooks`]: () => new Promise(() => {}) };
    const two = await mount(pending, { storage: { "shape:settings/web/webhooks": JSON.stringify({ n: 2 }) } });
    const hooks = card(two.root, "Webhooks");
    expect(all(hooks).filter((n) => n.nodeName === "TBODY")[0].childNodes).toHaveLength(2);
    expect(hooks.textContent).not.toContain("No webhooks");
    const none = card((await mount(pending, { storage: { "shape:settings/web/webhooks": JSON.stringify({ n: 0 }) } })).root, "Webhooks");
    expect(none.textContent).toContain("No webhooks. Add one to receive signed change, verdict and judgment events.");
    expect(all(none).some((n) => n.attrs.class === "bone")).toBe(false);
  });

  it("a released test counts from the next run: Release from quarantine posts the release and the list falls back to every test counts", async () => {
    const t1 = { test: "t1", runs: 50, flakes: 9, rate: 0.18, quarantined: true, quarantined_since: "2026-10-02T09:00:00Z", quarantined_by: "verifier" };
    let held = [t1, { ...t1, test: "t2", quarantined_since: null, quarantined_by: null }];
    const { root, sent } = await mount({ [`${API}/flakes`]: () => Response.json(held), [`POST ${API}/flakes/t1/release`]: () => { held = []; return new Response(null, { status: 204 }); } });
    const flaky = card(root, "Flaky checks");
    expect(all(flaky).filter((n) => n.nodeName === "TR").slice(1).map((r) => r.textContent)).toEqual(["t118% 9/50Oct 2verifierRelease from quarantine"]);
    await press(named(flaky, "Release from quarantine"));
    expect(sent("POST", `${API}/flakes/t1/release`)).toEqual([{}]);
    expect(card(root, "Flaky checks").textContent).toContain("No tests are quarantined. Every test counts in the verdict.");
  });

  it("the Quarantine automatically toggle sends auto_quarantine", async () => {
    const { root, sent } = await mount();
    const toggle = named(card(root, "Flaky checks"), "Quarantine automatically", "INPUT");
    expect(toggle.checked).toBe(true);
    await act(async () => { toggle.checked = false; fire(toggle, "click"); fire(toggle, "change"); });
    await settle();
    expect(sent("PUT", `${API}/settings`)).toEqual([{ auto_quarantine: false }]);
  });

  it("a 500 on one card's GET renders that card's error with Retry while the other cards render data", async () => {
    const { root, sent } = await mount({ [`${API}/webhooks`]: () => new Response("", { status: 500 }) });
    const err = all(card(root, "Webhooks")).find((n) => n.attrs.role === "alert");
    expect(err.textContent).toBe(`Couldn't load webhooks: GET ${API}/webhooks` + "Retry");
    expect(field(card(root, "About"), "Description").value).toBe("Edge");
    expect(card(root, "Groups with access").textContent).toContain("eng-all");
    expect(card(root, "Repo roles").textContent).toContain("a@x.dev");
    await press(named(err, "Retry"));
    expect(sent("GET", `${API}/webhooks`)).toHaveLength(2);
  });

  it("Apply opens a .cinder.yml change", async () => {
    const after = { ...POLICY, integration: ["develop", "main"], rules: ["develop", "main"].map((branch) => ({ branch, queue: true, judges: 1, risk: 10, route: [] })) };
    const { root, sent } = await mount({ [`${API}/policy/preview?strategy=gitflow`]: { policy: after, changes: [{ key: "integration", from: ["main"], to: ["develop", "main"] }] } });
    const pol = card(root, "Branch policy");
    await press(named(pol, "Gitflow"));
    const preview = all(pol).find((n) => n.attrs["aria-label"] === "Preview: Gitflow");
    const rows = (caption) => all(all(preview).find((n) => n.nodeName === "TABLE" && n.attrs["aria-label"] === caption)).filter((n) => n.nodeName === "TR").slice(1).map((r) => r.textContent);
    expect(rows("Now (Trunk)")).toEqual(["mainintegrationproduction"]);
    expect(rows("After (Gitflow)")).toEqual(["developintegrationstaging", "mainintegrationproduction"]);
    expect(preview.textContent).toContain("an ordinary change from develop into main");
    await press(named(preview, "Apply Gitflow"));
    expect(sent("PUT", `${API}/settings`)).toEqual([{ strategy: "gitflow", apply: true }]);
    expect(sent("GET", `${API}/policy`)).toHaveLength(2);
    expect(root.textContent).toContain("Applied Gitflow: committed .cinder.yml to main.");
    expect(all(pol).some((n) => n.attrs["aria-label"] === "Preview: Gitflow")).toBe(false);
  });

  it("Editing the tables flips the control to Custom", async () => {
    const { root, sent } = await mount();
    const pol = card(root, "Branch policy");
    const pressed = () => all(named(pol, "Branch policy strategy", "DIV")).filter((b) => b.attrs["aria-pressed"] === "true").map((b) => b.textContent);
    expect(pressed()).toEqual(["Trunk"]);
    await type(named(pol, "New release branch pattern", "INPUT"), "release/*");
    await press(all(pol).filter((n) => n.nodeName === "BUTTON" && n.textContent === "Add")[1]);
    expect(pressed()).toEqual(["Custom"]);
    expect(pol.textContent).toContain("Custom: the tables were edited by hand.");
    await press(named(pol, "Release branches"));
    expect(sent("GET", `${API}/policy/preview?strategy=release`)).toHaveLength(1);
    await press(named(pol, "Keep mine"));
    expect(pressed()).toEqual(["Custom"]);
  });
});
