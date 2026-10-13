// The web New change page (live intent box), rendered against this worker with seeded data instead of fixtures.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, createStaticHandler, createStaticRouter, RouterProvider, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { git } from "./fakes/bare-repo.js";

// The repo's git is an empty relay bare repo; the Worker's reads of it skip the fetch stub that answers from the Worker.
const relay = inject("runnerRelay").url;
const net = globalThis.fetch;
const fake = fakeArtifacts({ remote: (name) => `${relay}/smart/${name}.git` });
const real = (url, init) => (String(url).startsWith(relay) ? net(url, init) : worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake }));
const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const path = "/nc-live/changes/new";
let holderKey;

// Static render once the real worker has answered the loaders.
async function render() {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  await Promise.allSettled(Object.values(context.loaderData).map((d) => d?.data));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context });
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el).replace(/<!-- -->| data-discover="true"/g, "");
}

// Client render with an intent handed over in the link's state (as Judges and Reconcile do), once the page has asked
// the real worker for its preview: the rail's text.
async function rail(intent, until = "Predicted leases") {
  const { all, doc, El } = await import("../../web/src/fake-dom.js");
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const router = createMemoryRouter(routes, { initialEntries: [{ pathname: path, state: { intent } }] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(createElement(RouterProvider, { router })));
  const text = () => all(root).find((n) => n.nodeName === "ASIDE")?.textContent ?? "";
  await vi.waitFor(() => expect(text()).toContain(until), { timeout: 10000, interval: 50 });
  return text();
}

// One indexed symbol, and an open change that leases it.
beforeAll(async () => {
  env.ARTIFACTS = fake;
  await git(["init", "-q", "--bare", "-b", "main", "nc-live.git"]);
  expect((await real("/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "nc-live" }) })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("nc-live")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  fake.repos.get("nc-live").commits.push({ sha: "sha1" });
  const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind("nc-live").first();
  await env.DB.prepare("INSERT INTO symbols VALUES (?, 'sha1', 'src/http.js', 'retryFetch', 'function', 1, 2)").bind(id).run();
  await env.DB.prepare("INSERT INTO symbol_indexes VALUES (?, 'sha1')").bind(id).run();
  const res = await real("/api/repos/nc-live/changes", { method: "POST", headers: OWNER, body: JSON.stringify({ intent: "Make retryFetch back off" }) });
  expect(res.status).toBe(201);
  ({ key: holderKey } = await res.json());
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("new change (live)", () => {
  it("page renders from a real local worker with seeded data", async () => {
    // The holder shows by its key (NCLIVE-1) once ChangeId has looked it up.
    const text = await rail("Log every retryFetch attempt", `Collisions with active changes${holderKey}`);
    expect(text).not.toContain("Couldn't load the prediction");
    expect(text).toContain("Predicted leasessrc/http.js#retryFetch");
    expect(text).toContain(`Collisions with active changes${holderKey}src/http.js#retryFetch`);
    expect(text).toContain("reverted or breaks main within 7 days");
  });

  it("an API error shows the error state, not a blank page", async () => {
    vi.stubGlobal("fetch", async (url, init) => (String(url).endsWith("/lease-map") ? new Response("", { status: 503 }) : real(url, init)));
    const html = await render();
    expect(html).not.toContain("<h1>");
    expect(html).toContain('<div class="state error"><h2>Couldn&#x27;t load the prediction</h2><pre>GET /api/repos/nc-live/lease-map: HTTP 503</pre>');
    expect(html).toContain('aria-label="Intent"');
  });
});
