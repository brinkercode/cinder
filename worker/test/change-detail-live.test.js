// The web Change detail page, rendered against this worker with seeded data instead of fixtures.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DETAIL, REPOS, client, seed } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { markReady, runFor } from "./helpers/pool.js";
import { seedArtifacts } from "./fakes/seed.js";

const fake = seedArtifacts();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });
let id;
let unverified;
const api = (method, path, body) => real(path, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) });
const byIntent = async (repo, intent) => (await (await api("GET", `/api/repos/${repo}/changes`)).json()).find((c) => c.intent === intent);

async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  // The page <Await>s its deferred loader data: settle it, let the first render track it, and the second shows it.
  await Promise.allSettled(Object.values(context.loaderData).flatMap((d) => Object.values(d ?? {})));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context });
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el).replace(/<!-- -->| data-discover="true"/g, "");
}

beforeAll(async () => {
  env.ARTIFACTS = fake;
  const seeder = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
  await seed(seeder, undefined, ["changes", "gitflow", "detail"]);
  // A person marks the drafts ready; the changes section, run again, turns the leased detail change's auto-queue off.
  await markReady(seeder, Object.values(REPOS));
  await seed(seeder, undefined, ["changes"]);
  // A pool takes the detail change through develop and a verify that touches the person-routed orders.go#Get, then the detail section runs again.
  const detail = (await seeder("GET", `/api/repos/${REPOS.trunk}/changes`)).find((c) => c.intent === DETAIL);
  unverified = (await seeder("GET", `/api/changes/${detail.id}`)).reviewers;
  await runFor(seeder, "develop", detail.id, { status: "done" });
  // Its agent's push (the fake Artifacts takes no git push), so it has a head to verify and queue.
  await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(detail.id)).stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: detail.id, result: "ok" }, { head: "h1" });
  await runFor(seeder, "verify", detail.id, { status: "done", writes: [{ symbol: "orders.go#Get", kind: "body" }] });
  const applePay = (await seeder("GET", `/api/repos/${REPOS.gitflow}/changes`)).find((c) => c.intent === "Add Apple Pay to the checkout form");
  await runFor(seeder, "develop", applePay.id, { status: "failed", blockers: [{ summary: "Apple Pay button never renders in Safari 17", repro: "npm test -- applepay.button" }] });
  await seed(seeder, undefined, ["detail"]);
  const changes = await (await real(`/api/repos/${REPOS.trunk}/changes`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } })).json();
  id = changes.find((c) => c.intent === "Paginate GET /orders with limit and after").id;
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("change detail (live)", () => {
  it("page renders from a real local worker with seeded data", async () => {
    const html = await render(`/${REPOS.trunk}/changes/${id}`);
    // The header names the change by its key; the id stays in the tooltip.
    expect(html).toMatch(new RegExp(`<h1>Paginate GET /orders with limit and after <span class="subtle"><span class="mono" title="${id}">SVCORDERSGO-\\d+</span></span>`));
    expect(html).toMatch(/<div class="tl-e">.*created → draft.*ready → planned/);
    expect(html).toContain("<b>Verifier running</b>");
    expect(await render(`/${REPOS.trunk}/changes/c_missing`)).toContain("<h3>Change not found</h3>");
  });

  it("seedDetail skips a change no pool has taken to verifying, and requests the owner's review once one has", async () => {
    expect(unverified).toBeUndefined();
    const awaiting = await (await api("GET", `/api/changes/${(await byIntent(REPOS.trunk, DETAIL)).id}`)).json();
    expect([awaiting.state, awaiting.auto_queue, awaiting.reviewers]).toEqual(["verifying", false, [{ person: "owner" }]]);
    const html = await render(`/${REPOS.trunk}/changes/${awaiting.id}`);
    for (const s of [`<h1>${DETAIL}`, "<b>Verifier passed</b>", "<b>Waiting on owner (requested)</b><small>Auto-queue holds until requested reviewers approve the head"]) expect(html).toContain(s);
    expect(await render(`/${REPOS.trunk}/changes/c_missing`)).toContain("Back to Changes");
  });

  it("GET /api/changes/:id has no view field, and PUT /api/changes/:id/view is gone", async () => {
    const change = await (await api("GET", `/api/changes/${id}`)).json();
    expect(change).not.toHaveProperty("view");
    expect([404, 405]).toContain((await api("PUT", `/api/changes/${id}/view`, { files: [] })).status);
  });

  it("There's no merge button for humans. Merging always goes through the verifier queue", async () => {
    const { id: c } = await byIntent(REPOS.trunk, DETAIL);
    expect((await api("POST", `/api/changes/${c}/merge`)).status).toBe(404);
    expect((await api("POST", `/api/changes/${c}/queue`)).status).toBe(409); // owner hasn't approved yet
    expect((await (await api("POST", `/api/changes/${c}/review`, { verdict: "approve" })).json()).state).toBe("verifying");
    expect((await (await api("POST", `/api/changes/${c}/queue`)).json()).state).toBe("in_queue");
    // No push reached the guard, so the queue holds the merge on the gate.
    expect(await env.DB.prepare("SELECT reason FROM queue_blockers WHERE change_id = ?").bind(c).first("reason")).toContain("no guard result");
    expect((await api("POST", `/api/changes/${c}/queue`)).status).toBe(409);
  });

  it("after seeding, the page's API calls return data for every state the seed and the pool leave", async () => {
    const get = async (path) => (await real(path, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } })).json();
    const ids = (await Promise.all(Object.values(REPOS).map((r) => get(`/api/repos/${r}/changes`)))).flat().map((c) => c.id);
    const pages = await Promise.all(ids.map((cid) => get(`/api/changes/${cid}`)));
    expect(new Set(pages.map((p) => p.state))).toEqual(new Set(["leased", "developing", "in_queue", "failed", "closed"]));
    for (const p of pages) {
      expect(p.events.length).toBeGreaterThan(0);
      expect(p.blockers.length).toBeGreaterThan(0);
    }
    const failed = pages.find((p) => p.title === "Add Apple Pay to the checkout form");
    expect(failed.events.at(-1)).toMatchObject({ action: "job.report", result: "failed", reason: expect.stringContaining("repro: ") });
    const html = await render(`/${REPOS.gitflow}/changes/${failed.id}`);
    expect(html).toContain("Apple Pay button never renders in Safari 17");
  });

  it("an API error shows the error state, not a blank page", async () => {
    const path = `/api/changes/${id}`;
    vi.stubGlobal("fetch", (url, init) => (url === path ? new Response("", { status: 503 }) : real(url, init)));
    const html = await render(`/${REPOS.trunk}/changes/${id}`);
    expect(html).toContain(`Couldn&#x27;t load this change: ${path}: HTTP 503`);
  });
});
