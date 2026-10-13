import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { createMemoryRouter, createStaticHandler, createStaticRouter, RouterProvider, StaticRouterProvider } = await import("react-router");
const { IntentDrawer } = await import("./intent-drawer.jsx");
const { routes } = await import("./routes.jsx");

// The fake DOM has no dialog API (the drawer only opens itself) and no querySelectorAll (React looks up a radio's group).
El.prototype.showModal = function showModal() { this.open = true; };
El.prototype.querySelectorAll = () => [];

const at = new Date().toISOString();
const IT = { kind: "intent", n: 12, change_id: null, title: "Cache the tax table", lane: "intent", priority: "P2", labels: ["billing"], author: "maya@acme.dev",
  assignee: null, why: null, updated_at: at };
const ISSUE = { id: "i12", repo_id: "r", number: 12, title: IT.title, body: "Rates change yearly.", state: "open", author: IT.author, assignee: null, labels: ["billing"],
  status: "todo", priority: "P2", iteration: null, change: null, created_at: at, updated_at: at, closed_at: null, comments: [], changes: [] };
const SUGGEST = [{ agent: "developer@v7", p_merge: 0.71, n: 312, trusted: true }, { agent: "developer@v8", p_merge: 0.5, n: 6, trusted: false }];

async function mount() {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", vi.fn(async (url) => Response.json(url.includes("/agents/suggest?issue=12") ? SUGGEST : url === "/api/repos/web/issues/12" ? ISSUE : null)));
  const router = createMemoryRouter([
    { path: "/web/changes", element: <IntentDrawer repo="web" base="/web" target="main" it={IT} can why="" onStart={() => {}} onClosed={() => {}} onClose={() => {}} /> },
    { path: "/web/changes/new", element: <p>new change</p> },
  ], { initialEntries: ["/web/changes"] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const find = (pred) => all(root).find(pred);
  return { root, router, find };
}

afterEach(() => vi.unstubAllEnvs());

describe("intent drawer", () => {
  it("Who writes it lists the best agent with p(merge), race two with the untrusted count, and I'll write it", async () => {
    const { find } = await mount();
    const who = find((n) => n.nodeName === "FIELDSET").textContent;
    expect(who).toMatch(/^Who writes itdeveloper@v7.*p 0\.71Race two agentsdeveloper@v7 vs developer@v8.*untrusted: 6 outcomesI'll write it/);
    expect(find((n) => n.nodeName === "DIALOG").textContent).toContain("Rates change yearly.");
  });

  it("I'll write it opens New change › I wrote it for #n", async () => {
    const { router, find } = await mount();
    // React reads a radio's change from its click by the input's type.
    await act(async () => click(Object.assign(find((n) => n.nodeName === "INPUT" && (n.value ?? n.attrs.value) === "me"), { type: "radio", checked: true })));
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Start")));
    const url = `${router.state.location.pathname}${router.state.location.search}`;
    expect(url).toBe("/web/changes/new?head=&issue=12");
    // New change opens on I wrote it with the title starting #12, so the change links the intent.
    vi.stubEnv("VITE_FIXTURES", "1");
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request(`http://cinder.test/acme%2Fweb/changes/new?head=&issue=12`));
    const html = renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
    expect(html).toMatch(/<input type="radio" name="nc-mode" checked="" value="human"\/>/);
    expect(html).toContain('aria-label="Title" placeholder="Title" value="#12 "');
  });
});
