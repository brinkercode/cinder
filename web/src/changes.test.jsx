import { readFileSync } from "node:fs";
import { repoAt } from "./fake-repos.js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import collisions from "../../worker/src/api/fixtures/collisions.json";
import { all, click, doc, El } from "./fake-dom.js";

// react-dom checks for oninput when it loads; without it a text input's onChange never fires.
doc.oninput = null;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { createMemoryRouter, createStaticHandler, createStaticRouter, RouterProvider, StaticRouterProvider } = await import("react-router");
const { routes } = await import("./routes.jsx");
// Pages load lazily: importing them here first lets a render resolve its route without waiting on a fresh import.
const { ago } = await import("./changes.jsx");

const flow = `/${encodeURIComponent(repos.find((r) => r.id === "r_flow").name)}/changes`;

const page = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  return <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />;
};
const clean = (html) => html.replace(/<!-- -->| data-discover="true"/g, "");

// The first render starts tracking the board promise; once it settles, the second render shows the result.
async function render(path) {
  const el = await page(path);
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return clean(renderToString(el));
}

const at = new Date().toISOString();
const REPO = { id: "r", name: "web", default_branch: "main", strategy: "trunk", branch_policy: { integration: ["main"], release: [], check: "make check", stack: "code@v1" }, created_at: at };
const item = (id, lane, extra) => ({ kind: "change", n: null, change_id: id, title: `Change ${id}`, lane, priority: null, labels: [], author: "developer@v7",
  assignee: null, why: null, updated_at: at, ...extra });
const intent = (n, extra) => item(null, "intent", { kind: "intent", n, title: `Intent ${n}`, author: "maya@acme.dev", ...extra });
const change = (id, state, extra) => ({ id, repo_id: "r", kind: "change", title: id, intent: "x", target_branch: "main", state, fork: "f", stacked_on: null,
  risk: null, created_at: at, updated_at: at, ...extra });
const TILES = { intents: 0, in_flight: 0, review: 0, merged_24h: 0, needs_you: 0, verifier: { pass: 0, n: 0, trusted: false } };
const find = (root, role) => all(root).find((n) => n.attrs.role === role);
const fire = (el, type, extra) => {
  for (let n = el; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f({ type, target: el, bubbles: true, preventDefault() {}, stopPropagation() {}, ...extra });
};

// items: GET /work; changes: GET /changes; post: POST /issues's answer; answer(url, init): any other route's, or null.
async function mount({ items = [], changes = [], post = () => Response.json({}), answer = () => null, can = true, patch } = {}) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
  const sockets = [];
  vi.stubGlobal("WebSocket", class { constructor() { sockets.push(this); } close() {} });
  const fetch = vi.fn(async (url, init) => (init?.method === "PATCH" && patch ? patch(url, init) : await answer(url, init)) ?? (url === "/api/live-ticket" ? Response.json({ ticket: "t" }) : url === "/api/repos/web/work" ? Response.json({ items, tiles: TILES, can_write: can })
    : url.startsWith("/api/repos/web/changes") ? Response.json(changes) : url === "/api/repos/web/issues" && init?.method === "POST" ? post() : Response.json(repoAt(url, [REPO]) ?? [REPO])));
  vi.stubGlobal("fetch", fetch);
  const route = routes.flatMap(function flat(r) { return [r, ...(r.children ?? []).flatMap(flat)]; }).find((r) => r.path === "changes");
  const router = createMemoryRouter([{ ...route, path: "/:repo/changes" }], { initialEntries: ["/web/changes"] });
  const root = doc.body.appendChild(new El("div"));
  const r = createRoot(root);
  onTestFinished(() => act(() => r.unmount())); // stops its live listeners, as leaving the page does
  await act(async () => r.render(<RouterProvider router={router} />));
  const find = (pred) => all(root).find(pred);
  const col = (name) => find((n) => n.nodeName === "SECTION" && n.attrs["aria-label"] === name);
  const cards = (el = root) => all(el).filter((n) => n.nodeName === "ARTICLE").map((n) => n.textContent);
  const button = (text) => find((n) => n.nodeName === "BUTTON" && (n.textContent === text || n.attrs["aria-label"] === text));
  const send = (m) => act(async () => sockets.forEach((s) => s.onmessage({ data: JSON.stringify(m) })));
  return { root, fetch, find, col, cards, button, send };
}

// A native drag: dragstart on the card fills dataTransfer, drop on the lane reads it.
const drag = (card, lane) => act(async () => {
  const data = {};
  const dataTransfer = { setData: (k, v) => { data[k] = v; }, getData: (k) => data[k] ?? "" };
  fire(card, "dragstart", { dataTransfer });
  fire(lane, "drop", { dataTransfer });
});
const article = (el) => all(el).find((n) => n.nodeName === "ARTICLE");
const SUGGEST = [{ agent: "developer@v8", p_merge: 0.8, n: 40, trusted: true }, { agent: "developer@v7", p_merge: 0.5, n: 6, trusted: false }];
const claimCalls = (fetch) => fetch.mock.calls.filter(([url]) => url.endsWith("/claim")).map(([url, init]) => [init.method, url, init.body && JSON.parse(init.body)]);

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("changes board", () => {
  it("the board renders the six lanes from /work, with each item once", async () => {
    const items = [intent(1), ...["progress", "verify", "review", "queue", "merged"].map((lane, i) => item(`c-${i}`, lane))];
    const { root, fetch, col, cards } = await mount({ items });
    expect(fetch).toHaveBeenCalledWith("/api/repos/web/work");
    const lanes = all(root).filter((n) => n.nodeName === "SECTION").map((n) => n.attrs["aria-label"]);
    expect(lanes).toEqual(["Intents", "In progress", "Verifying", "Needs review", "Merge queue", "Merged · 24h"]);
    expect(lanes.map((l) => cards(col(l)).length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(cards()).toHaveLength(items.length);
  });

  it("a change linked to #n shows #n on its card and the issue has no card of its own", async () => {
    const { col, cards, send } = await mount({ items: [intent(12)] });
    expect(cards(col("Intents"))).toEqual([expect.stringContaining("#12")]);
    await send({ kind: "work.updated", item: item("c-77", "verify", { n: 12 }) });
    expect(cards()).toHaveLength(1);
    expect(cards(col("Verifying"))[0]).toMatch(/c-77 #12/);
  });

  it("an empty repo shows Nothing in flight with Describe a change and New intent", async () => {
    const { root, find, button } = await mount();
    expect(root.textContent).toContain("Nothing in flight");
    expect(button("New intent").attrs.disabled).toBeUndefined();
    expect(find((n) => n.nodeName === "A" && n.textContent === "Describe a change" && n.attrs.href === "/web/changes/new")).toBeTruthy();
    expect(find((n) => n.attrs.class === "board")).toBeUndefined();
    await act(async () => click(button("New intent")));
    expect(find((n) => n.attrs["aria-label"] === "Intent title")).toBeTruthy();
  });

  it("the Needs you segment count equals approval plus requested", async () => {
    const items = [item("c-a", "review"), item("c-r", "review", { author: "ben@acme.dev" }), item("c-v", "verify"), intent(3)];
    const { cards, button } = await mount({ items });
    await act(async () => click(button("Needs you 2")));
    expect(cards().map((t) => t.match(/c-\w/)[0]).sort()).toEqual(["c-a", "c-r"]);
  });

  it("search filters by title, #n, c-id, author and label without a request", async () => {
    const items = [item("c-10", "verify", { title: "Retry the webhook" }), item("c-20", "review", { n: 42 }), item("c-30", "queue", { author: "zoe@acme.dev" }),
      intent(7, { labels: ["billing"] })];
    const { fetch, find, cards } = await mount({ items });
    const calls = fetch.mock.calls.length;
    const box = find((n) => n.attrs["aria-label"] === "Search work");
    // React reads the new value from the input event's target, a text input by type.
    const hits = async (value) => { await act(async () => { Object.assign(box, { type: "text", value }); fire(box, "input"); }); return cards().map((t) => t.match(/c-\d+|#7/)[0]); };
    expect(await hits("webhook")).toEqual(["c-10"]);
    expect(await hits("#42")).toEqual(["c-20"]);
    expect(await hits("c-30")).toEqual(["c-30"]);
    expect(await hits("zoe@")).toEqual(["c-30"]);
    expect(await hits("billing")).toEqual(["#7"]);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("the board renders every card's diff summary with no compare request", async () => {
    const diff = (n) => ({ files_changed: n, additions: 10 * n, deletions: n, ahead: 1, behind: 0 });
    const items = [item("c-1", "progress", { diff: diff(1) }), item("c-2", "review", { diff: diff(2) })];
    const changes = [change("c-1", "developing", { head_branch: "feature/a" }), change("c-2", "verifying", { head_branch: "feature/b" })];
    const { fetch, cards } = await mount({ items, changes });
    expect(cards()).toEqual([expect.stringMatching(/\+10 −1.*1/), expect.stringMatching(/\+20 −2.*2/)]);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/compare"))).toEqual([]);
  });

  it("the table view lists Item, Title, Stage, Who, p(merge), Diff, Tokens and Age", async () => {
    const { find, button } = await mount({ items: [item("c-1", "verify", { n: 5 })], changes: [change("c-1", "verifying", { adds: 12, dels: 3 })] });
    await act(async () => click(button("Table")));
    expect(find((n) => n.nodeName === "THEAD").textContent).toBe("ItemTitleStageWhop(merge)DiffTokensAge");
    const row = find((n) => n.nodeName === "TR" && n.textContent.includes("c-1"));
    expect(row.textContent).toMatch(/^c-1 #5Change c-1Verifyingdeveloper@v7.*\+12 −3/);
  });

  it("inline add shows the new intent before POST /issues answers and removes it if the POST fails", async () => {
    let answer;
    const { col, cards, find, button, root } = await mount({ items: [intent(1)], post: () => new Promise((r) => { answer = r; }) });
    await act(async () => click(button("New intent")));
    const input = find((n) => n.attrs["aria-label"] === "Intent title");
    await act(async () => { input.value = "Cache the tax table"; fire(input, "keydown", { key: "Enter" }); });
    expect(cards(col("Intents"))).toEqual([expect.stringContaining("Cache the tax table"), expect.stringContaining("Intent 1")]);
    await act(async () => answer(Response.json({ error: { message: "nope" } }, { status: 500 })));
    expect(cards(col("Intents"))).toEqual([expect.stringContaining("Intent 1")]);
    expect(root.textContent).toContain("nope");
    await act(async () => fire(input, "keydown", { key: "Escape" }));
    expect(find((n) => n.attrs["aria-label"] === "Intent title")).toBeUndefined();
  });

  it("filters combine (label AND priority) and survive board redraws and live updates", async () => {
    const items = [item("c-1", "verify", { labels: ["cart"], priority: "P1" }), item("c-2", "review", { labels: ["cart"], priority: "P2" }),
      item("c-3", "queue", { labels: ["pay"], priority: "P1" }), intent(4, { labels: ["cart"], priority: "P1" })];
    const { fetch, cards, button, send } = await mount({ items });
    const ids = () => cards().map((t) => t.match(/c-\d+|#4/)[0]).sort();
    await act(async () => click(button("cart")));
    expect(ids()).toEqual(["#4", "c-1", "c-2"]);
    await act(async () => click(button("P1")));
    expect(ids()).toEqual(["#4", "c-1"]);
    // Any other event reloads the board from /work.
    const loads = fetch.mock.calls.filter(([url]) => url.endsWith("/work")).length;
    await send({ kind: "change.updated" });
    await act(async () => new Promise((r) => setTimeout(r)));
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/work")).length).toBe(loads + 1);
    expect(ids()).toEqual(["#4", "c-1"]);
    await send({ kind: "work.updated", item: item("c-2", "review", { labels: ["cart"], priority: "P1" }) });
    await send({ kind: "work.updated", item: item("c-1", "verify", { labels: [], priority: "P1" }) });
    expect(ids()).toEqual(["#4", "c-2"]);
  });

  it("label edits save immediately from the intent drawer and show on the card", async () => {
    El.prototype.showModal = function () { this.open = true; };
    onTestFinished(() => { delete El.prototype.showModal; });
    const patch = vi.fn(async (url, init) => Response.json({ number: 1, labels: JSON.parse(init.body).labels, priority: null, updated_at: at }));
    const { col, cards, find } = await mount({ items: [intent(1)], patch });
    await act(async () => click(find((n) => n.nodeName === "ARTICLE")));
    const box = find((n) => n.attrs["aria-label"] === "Find or create a label");
    await act(async () => { Object.assign(box, { type: "text", value: "cart" }); fire(box, "input"); });
    await act(async () => fire(box, "keydown", { key: "Enter" }));
    expect(patch).toHaveBeenCalledWith("/api/repos/web/issues/1", expect.objectContaining({ method: "PATCH", body: '{"labels":["cart"]}' }));
    expect(cards(col("Intents"))[0]).toContain("cart");
  });

  it("a work.updated event moves the card to its new lane without a refetch", async () => {
    const { fetch, col, cards, send } = await mount({ items: [item("c-9", "verify")] });
    const board = () => fetch.mock.calls.filter(([url]) => /\/(work|changes)$/.test(url)).length;
    const calls = board();
    await send({ kind: "work.updated", item: item("c-9", "queue") });
    expect([cards(col("Verifying")), cards(col("Merge queue")).length]).toEqual([[], 1]);
    await send({ kind: "work.activity", change_id: "c-9", activity: "editing", path: "src/a.js" });
    expect(cards(col("Merge queue"))[0]).toContain("editing src/a.js");
    expect(board()).toBe(calls);
  });

  it("an agent below the trust threshold shows untrusted: n outcomes, never 0% or 100%", async () => {
    const mine = { agent_version: "developer@v7" };
    // developer@v7 decided 3 changes, all merged: 100% from three outcomes.
    const changes = [change("c-1", "verifying", mine), ...["c-2", "c-3", "c-4"].map((id) => change(id, "merged", mine))];
    const { col, cards } = await mount({ items: [item("c-1", "verify")], changes });
    const card = cards(col("Verifying"))[0];
    expect(card).toContain("untrusted: 3 outcomes");
    expect(card).not.toMatch(/100%|0%|p 1\.00/);
  });

  it("the changes list shows PULSE-6 and no c-xxxxxxxx identifier", async () => {
    const id = "0b4f8c2e-5d6a-4e1b-9c3f-7a8b9c0d1e2f";
    const { col, cards } = await mount({ items: [item(id, "verify", { title: "Retry" })], changes: [change(id, "verifying", { number: 6, key: "PULSE-6" })] });
    expect(cards(col("Verifying"))[0]).toContain("PULSE-6");
    expect(cards(col("Verifying"))[0]).not.toContain("0b4f8c2e");
  });

  it("a card with a long title, collision and why-line keeps every field inside the card", async () => {
    const id = "0f3c9a2e-1b4d-4e8f-9a6c-2d7e5b1f8a30";
    const title = `Rework the ${"very ".repeat(40)}long route matcher title`;
    const feed = [{ ...collisions.feed[0], ours: id, theirs: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", resolution: null }];
    const why = `Blocked behind ${feed[0].theirs}, which holds the lease on src/route/matcher.rs#RouteMatcher`;
    const { col } = await mount({ items: [item(id, "verify", { title, n: 12, why })],
      answer: (url) => (url === "/api/repos/web/collisions?target=main" ? Response.json({ ...collisions, feed }) : null) });
    const card = article(col("Verifying"));
    const cls = (c) => all(card).filter((n) => n.attrs.class === c);
    expect(all(card).find((n) => n.nodeName === "H4").attrs.title).toBe(title);
    expect(cls("chg-h")[0].childNodes[0].textContent).toBe(`${id.slice(0, 8)} #12 · developer@v7 · ${ago(at)}`);
    expect(cls("why").map((n) => n.textContent)).toEqual(["Collides with 7a1b2c3d on RouteMatcher", "Blocked behind 7a1b2c3d, which holds the lease on src/route/matcher.rs#RouteMatcher"]);
    const css = readFileSync(new URL("styles/changes.css", import.meta.url), "utf8");
    const rule = (sel) => css.match(new RegExp(`(?:^|\\})${sel.replace(/[.*+>]/g, "\\$&")}\\{([^}]*)\\}`, "m"))?.[1].split(";") ?? [];
    expect(rule(".chg")).toEqual(expect.arrayContaining(["min-width:0", "overflow-wrap:anywhere"]));
    expect(rule(".chg h4")).toEqual(expect.arrayContaining(["-webkit-line-clamp:2", "overflow:hidden"]));
    expect(rule(".chg-h,.chg-f,.chg-m,.chg .row")).toContain("flex-wrap:wrap");
    expect(rule(".chg-h>*,.chg-f>*,.chg-m>*,.chg .why>*")).toContain("min-width:0");
  });

  it("a human can drag an intent claimed by an agent but not committed from In progress back to Intents, which sends DELETE claim", async () => {
    const { fetch, col, cards } = await mount({ items: [item("c-5", "progress", { n: 5, title: "#5 Cache the tax table" })],
      answer: (url, init) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : null) });
    expect(cards(col("In progress"))).toEqual([expect.stringMatching(/#5.*developer@v7/)]);
    expect(article(col("In progress")).attrs.draggable).toBe("true");
    await drag(article(col("In progress")), col("Intents"));
    expect(claimCalls(fetch)).toEqual([["DELETE", "/api/repos/web/issues/5/claim", undefined]]);
    expect([cards(col("Intents")).length, cards(col("In progress"))]).toEqual([1, []]);
  });

  it("dragging an unclaimed intent to In progress claims it with the top suggested agent", async () => {
    const { fetch, col, cards } = await mount({ items: [intent(1)], answer: (url, init) => (url.includes("/agents/suggest?issue=1") ? Response.json(SUGGEST)
      : init?.method === "POST" && url.endsWith("/claim") ? Response.json(item("c-1", "progress", { n: 1, author: "developer@v8" }), { status: 201 }) : null) });
    await drag(article(col("Intents")), col("In progress"));
    expect(claimCalls(fetch)).toEqual([["POST", "/api/repos/web/issues/1/claim", { mode: "agent", agents: ["developer@v8"] }]]);
    expect([cards(col("Intents")), cards(col("In progress"))]).toEqual([[], [expect.stringMatching(/#1.*developer@v8/)]]);
  });

  it("a drag moves the card before the request answers and rolls it back on failure", async () => {
    let answer;
    const { col, cards, root } = await mount({ items: [intent(1), item("c-5", "progress", { n: 5 })], answer: (url, init) => (url.includes("/agents/suggest") ? Response.json(SUGGEST)
      : init?.method === "POST" && url.endsWith("/claim") ? new Promise((r) => { answer = r; })
        : init?.method === "DELETE" ? Response.json({ error: { code: "verifier_owned", message: "#5's change has a commit" } }, { status: 409 }) : null) });
    await drag(article(col("Intents")), col("In progress"));
    expect(cards(col("Intents"))).toEqual([]);
    expect(cards(col("In progress"))).toHaveLength(2);
    await act(async () => answer(Response.json({ error: { message: "nope" } }, { status: 500 })));
    expect(cards(col("Intents"))).toEqual([expect.stringContaining("#1")]);
    expect(find(root, "alert").textContent).toContain("nope");
    // A release refused because an agent committed rolls back with the verifier message.
    await drag(article(col("In progress")), col("Intents"));
    expect(cards(col("In progress"))).toEqual([expect.stringContaining("#5")]);
    expect(find(root, "alert").textContent).toBe("An agent already committed; the verifier owns it now.");
  });

  it("a stale revalidation does not drop a claim's update", async () => {
    let claim, load, loads = 0;
    const { col, cards, button } = await mount({ items: [intent(1)], answer: (url, init) => (url.includes("/agents/suggest") ? Response.json(SUGGEST)
      : init?.method === "POST" && url.endsWith("/claim") ? new Promise((r) => { claim = r; })
        : url === "/api/repos/web/work" && loads++ ? new Promise((r) => { load = r; }) : null) });
    await drag(article(col("Intents")), col("In progress"));
    // The refresh's /work starts before the claim answers and finishes after it, still holding #1 as an intent.
    await act(async () => click(button("Refresh")));
    await act(async () => claim(Response.json(item("c-1", "progress", { n: 1, author: "developer@v8" }), { status: 201 })));
    await act(async () => load(Response.json({ items: [intent(1)], tiles: TILES, can_write: true })));
    expect([cards(col("Intents")), cards(col("In progress"))]).toEqual([[], [expect.stringMatching(/#1.*developer@v8/)]]);
  });

  it("dropping any card into Verifying, Needs review, Merge queue or Merged shows the verifier toast and sends no request", async () => {
    const { fetch, col, cards, root } = await mount({ items: [intent(1), item("c-9", "verify")] });
    const calls = fetch.mock.calls.length;
    for (const lane of ["Verifying", "Needs review", "Merge queue", "Merged · 24h"]) {
      for (const from of ["Intents", "Verifying"]) await drag(article(col(from)), col(lane));
      expect(find(root, "status").textContent).toBe("Past In progress, only the verifier moves work.");
    }
    expect(fetch.mock.calls.length).toBe(calls);
    expect([cards(col("Intents")).length, cards(col("Verifying")).length]).toEqual([1, 1]);
  });

  it("hovering a board card prefetches that change's detail", async () => {
    const { col, fetch } = await mount({ items: [item("c-9", "verify")] });
    const detail = () => fetch.mock.calls.filter(([url]) => url === "/api/changes/c-9").length;
    expect(detail()).toBe(0);
    await act(async () => fire(article(col("Verifying")), "mouseover"));
    await act(async () => fire(article(col("Verifying")), "mouseover"));
    expect(detail()).toBe(1);
  });

  it("a change card is not draggable", async () => {
    const { col } = await mount({ items: [intent(1), item("c-9", "verify"), item("c-8", "progress")] });
    expect(["Intents", "Verifying", "In progress"].map((l) => article(col(l)).attrs.draggable)).toEqual(["true", "false", "false"]);
  });

  it("the Move to… menu moves an intent with the keyboard", async () => {
    const { fetch, col, cards, find: get } = await mount({ items: [intent(1)], answer: (url, init) => (url.includes("/agents/suggest") ? Response.json(SUGGEST)
      : init?.method === "POST" && url.endsWith("/claim") ? Response.json(item("c-1", "progress", { n: 1 }), { status: 201 }) : null) });
    const menu = get((n) => n.attrs["aria-label"] === "Move #1 to…");
    await act(async () => { menu.value = "progress"; fire(menu, "change"); });
    expect(claimCalls(fetch)).toEqual([["POST", "/api/repos/web/issues/1/claim", { mode: "agent", agents: ["developer@v8"] }]]);
    expect(cards(col("In progress"))).toEqual([expect.stringContaining("#1")]);
  });

  it("without repo.write, drag, Move to… and Hand to agent are disabled with the reason shown", async () => {
    const { col, root, button } = await mount({ items: [intent(1)], can: false });
    const card = article(col("Intents"));
    expect([card.attrs.draggable, card.attrs.title, button("Hand to agent").attrs.disabled]).toEqual(["false", "Moving intents needs repo.write on this repo.", ""]);
    expect(root.textContent).toContain("Moving intents needs repo.write on this repo.");
  });

  it("skeleton counts match the spec: 5 tiles, 2/2/2/1/2/2 cards per lane, progress-bar bones on Verifying", async () => {
    // The board fetch never settles; the skeleton shows after its 150ms delay.
    const { find } = await mount({ answer: (url) => (url === "/api/repos/web/work" ? new Promise(() => {}) : null) });
    await act(() => new Promise((r) => setTimeout(r, 150)));
    const busy = find((n) => n.attrs["aria-busy"] === "true");
    expect(busy.childNodes[0].textContent).toBe("Loading Changes");
    const under = (cls) => all(busy).filter((n) => n.attrs.class === cls);
    const bone = (n) => all(n).filter((x) => x.attrs.class === "bone");
    expect(under("tile flat").filter((t) => bone(t).length).map((t) => t.childNodes[0].textContent))
      .toEqual(["Intents waiting", "In flight", "Needs review", "Merged · 24h", "Verifier pass rate"]);
    expect(all(find((n) => n.attrs.role === "search")).filter((n) => n.attrs.disabled === "")).toHaveLength(5);
    expect(under("col").map((c) => `${c.attrs["aria-label"]}:${all(c).filter((n) => n.attrs.class === "chg").length}:${bone(c).filter((b) => b.style.height === "4px").length}`))
      .toEqual(["Intents:2:0", "In progress:2:0", "Verifying:2:2", "Needs review:1:0", "Merge queue:2:0", "Merged · 24h:2:0"]);
  });

  it("an error shows the card error with Retry where the board goes", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (path) => (repoAt(path) ? Response.json(repoAt(path)) : path.endsWith("/work") ? new Response("", { status: 503 }) : Response.json([])));
    expect(await render(flow)).toMatch(/Verifier pass rate<\/div><div class="v">—<\/div><\/div><\/div><div class="toolbar" role="search">.*<\/button><\/div><div class="card"><div class="err" role="alert"><span class="dot bad"><\/span><span>Couldn&#x27;t load changes: GET \/api\/repos\/acme%2Fweb\/work: HTTP 503<\/span><button[^>]*>Retry<\/button>/);
  });

  it("a failed board load shows the method once", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (path) => (repoAt(path) ? Response.json(repoAt(path)) : path.endsWith("/work") ? Response.json({ error: { message: "blocked" } }, { status: 500 }) : Response.json([])));
    expect(await render(flow)).toContain("<span>Couldn&#x27;t load changes: GET /api/repos/acme%2Fweb/work → 500 blocked</span>");
  });

  it("no color literal or font-family outside tokens.css", () => {
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    const jsx = readFileSync(new URL("changes.jsx", import.meta.url), "utf8");
    for (const sel of [".board{", ".col{", ".card{", ".card:has(.card-link:focus-visible)", ".toolbar{"]) expect(css).toContain(sel);
    for (const src of [css, jsx]) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/);
      expect(src).not.toMatch(/font-family:\s*(?!var\(--font-)|fontFamily/);
    }
    expect(jsx).not.toMatch(/style=\{\{/);
  });
});
