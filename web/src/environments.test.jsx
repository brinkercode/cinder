import { renderToReadableStream, renderToString } from "react-dom/server";
import { repoAt } from "./fake-repos.js";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

const repo = encodeURIComponent(repos[0].name);
const env = (name, target, link) => ({ name, branch: "main", desired_sha: null, status: null, live_version: null, step: null, drift: [], history: [],
  release: "v2.14.0", target, console: link, gate: "manual", deployed_at: "2026-10-04T09:00:00Z", secrets: 3 });

const page = async (path = "/environments", init) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test/${repo}${path}`, init));
  return <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />;
};
// The first render starts tracking the loader's promise and the second the cards' trees; once they settle, the third
// shows the result.
async function render(path, init) {
  const el = await page(path, init);
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el).replace(/<!-- -->/g, "");
}
const serve = (lists) => vi.stubGlobal("fetch", async (url) => {
  if (repoAt(url)) return Response.json(repoAt(url));
  const rest = url.slice(`/api/repos/${repo}`.length);
  return rest in lists ? lists[rest] : Response.json([]);
});

beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("non-Cloudflare targets use the same card with their own console link", async () => {
  const deployments = "https://dash.cloudflare.com/?to=/:account/workers/services/view/pulse-production/production/deployments";
  serve({ "/environments": Response.json([env("production", "Cloudflare", deployments), env("eu-batch", "AWS", "https://console.aws.amazon.com/")]) });
  const html = await render();
  const cards = html.match(/<div class="card env">.*?<\/span><\/div><\/div>/g);
  expect(cards).toHaveLength(2);
  const shape = (card) => card.replace(/<h3>.*?<\/h3>|<span class="pill">.*?<\/span>|popover[^>]*|id="[^"]*"|style="[^"]*"|aria-label="[^"]*"|value="[^"]*"|title="[^"]*"|<a href="[^"]*"[^>]*>.*?<\/a>/g, "");
  expect(shape(cards[1])).toBe(shape(cards[0]));
  expect(cards[0]).toContain(`<a href="${deployments.replace(/&/g, "&amp;")}" target="_blank" rel="noreferrer">Worker › Deployments <svg`);
  expect(cards[1]).toContain('<span class="pill"><svg');
  expect(cards[1]).toMatch(/<\/svg>AWS<\/span>/);
  expect(cards[1]).toContain('<a href="https://console.aws.amazon.com/" target="_blank" rel="noreferrer">Open in AWS console <svg');
});

it("Each target card links to its console; an SSH card names its host instead", async () => {
  serve({ "/environments": Response.json([{ ...env("on-prem", "SSH", null), host: "build-01.internal" }]) });
  const html = await render();
  expect(html).toContain('<div class="lc-f"><span class="mono muted">build-01.internal</span>');
});

it("does not show the Targets outside Cloudflare card", async () => {
  serve({ "/environments": Response.json([env("eu-batch", "AWS", "https://console.aws.amazon.com/")]) });
  const html = await render();
  expect(html).toContain('<div class="card env">');
  expect(html).not.toContain("Targets outside Cloudflare");
});

it("environments: loading skeleton of 3 cards with 5 detail rows each, no environments 'Declare environments in .cinder.yml', and a card error with Retry", async () => {
  serve({ "/environments": Response.json([]) });
  expect(await render()).toMatch(/<div class="empty">.*<h3>No environments<\/h3><p>Declare environments in <span class="mono">\.cinder\.yml<\/span><\/p>/);

  vi.stubGlobal("fetch", async (url) => (repoAt(url) ? Response.json(repoAt(url)) : new Promise(() => {})));
  // The lists never settle, so the stream stops after the shell; read until the page is out.
  const reader = (await renderToReadableStream(await page(), { onError: () => {} })).getReader();
  let shell = "";
  while (!shell.includes("</main>")) shell += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  expect(shell.match(/<div class="card env">/g)).toHaveLength(3);
  expect(shell.match(/<dd><span class="bone"/g)).toHaveLength(15);
  expect(shell).toContain("Promote a release");

  serve({ "/environments": new Response("", { status: 503 }) });
  expect(await render()).toMatch(/<div class="card"><div class="err" role="alert">.*Couldn&#x27;t load environments<\/span><button[^>]*>Retry<\/button>/);
});

it("Environments renders the branch-not-found card next to a normal card", async () => {
  serve({ "/environments": Response.json([{ ...env("staging", "Cloudflare", null), branch: "release/2026.10", branch_missing: true }, env("production", "Cloudflare", null)]) });
  const cards = (await render()).match(/<div class="card env">.*?<\/span><\/div><\/div>/g);
  expect(cards).toHaveLength(2);
  expect(cards[0]).toContain('<div class="block" role="status"><svg');
  expect(cards[0]).toContain('Branch not found: <span class="mono">release/2026.10</span>');
  expect(cards[1]).not.toContain("Branch not found");
  expect(cards[1]).toContain("<h3>production</h3>");
});

it("a drifted resource is flagged in the environment's tree", async () => {
  serve({
    "/environments": Response.json([env("production", "Cloudflare", null)]),
    "/environments/production/tree": Response.json({ script: "pulse-production", live_version: { version_id: "v1", sha: "1".repeat(40) }, bindings: [
      { binding: "PULSE_CACHE", type: "kv", resource: "pulse-cache-production", drift: false },
      { binding: null, type: "r2", resource: "old-bucket-production", drift: true },
    ] }),
  });
  const tree = (await render()).match(/<ul class="etree" aria-label="production resources">.*?<\/ul><\/li><\/ul>/)[0];
  expect(tree).toContain('<span class="mono">pulse-production</span>');
  expect(tree).toMatch(/<li><span class="dot ok"><\/span><span class="mono">PULSE_CACHE<\/span><span class="muted">kv<\/span><span class="mono">pulse-cache-production<\/span><\/li>/);
  expect(tree).toMatch(/<li><span class="dot warn"><\/span><span class="mono">unbound<\/span><span class="muted">r2<\/span><span class="mono">old-bucket-production<\/span><span class="pill">Drift<\/span><\/li>/);
});

it("environment history entries render on the card", async () => {
  const sync = (sha, status, at) => ({ status, sha, actor: "verifier", started_at: at, at, version_id: null, step: null, changes: [], run: null });
  const prod = { ...env("production", "Cloudflare", null), history: [sync("abcdef1234", "Synced", "2026-10-04T09:00:00Z"), { ...sync("1234567890", "Failed", "2026-10-03T09:00:00Z"), reason: "health check /health failed at 100%: 503" }] };
  serve({ "/environments": Response.json([prod]) });
  const text = (await render()).replace(/<[^>]+>/g, "");
  expect(text).toMatch(/abcdef1 Synced · verifier · \d+d ago/);
  expect(text).toMatch(/1234567 Failed · verifier · \d+d ago · health check \/health failed at 100%: 503/);
});

it("an OutOfSync drift result shows the amber dot, banner and Reconcile", async () => {
  const sync = (status, actor) => ({ status, sha: "abcdef1234", actor, started_at: "2026-10-10T09:00:00Z", at: "2026-10-10T09:00:00Z", version_id: null, step: null, changes: [], run: null });
  const prod = { ...env("production", "Cloudflare", null), status: "OutOfSync", history: [sync("OutOfSync", "cinder-drift"), sync("Synced", "verifier")] };
  serve({ "/environments": Response.json([prod, env("staging", "Cloudflare", null)]) });
  const cards = (await render()).match(/<div class="card env">.*?<\/span><\/div><\/div>/g);
  expect(cards[0]).toContain('<span class="dot warn"></span><h3>production</h3>');
  expect(cards[0]).toContain('Drift: the live Worker differs from <span class="mono">.cinder.yml</span>');
  expect(cards[0]).toMatch(/<a class="btn btn-secondary btn-sm end" href="[^"]*changes\/new\?target=main"[^>]*>Reconcile<\/a>/);
  expect(cards[1]).toContain('<span class="dot ok"></span><h3>staging</h3>');
  expect(cards[1]).not.toContain("Reconcile");
});

const tree = (entries) => Response.json({ sha: "a".repeat(40), entries: entries.map((name) => ({ name })) });
const at = (p) => `?ref=main&path=${encodeURIComponent(p)}`;
// The services at main's head, and an empty repo root so no flow file exists yet.
const services = (list) => ({ "/services": Response.json({ ref: "main", sha: "a".repeat(40), services: list }), [`/tree${at("")}`]: tree([]) });
const svc = (name, kind, path, resources, flow) => ({ id: `${kind}:${path}`, name, kind, path, resources,
  flow: { name: flow, yaml: `name: ${flow}\non: [manual]\nsteps:\n  build: { stage: check, run: "npm ci", needs: [] }\n` } });

it("the Services tab lists each detected service with its suggested resources and generated flow", async () => {
  serve(services([svc("shop", "worker", ".", [{ type: "worker", name: "shop" }, { type: "d1", name: "shop-db" }], "worker-root"),
    svc("api", "container", "api", [{ type: "container", name: "api" }], "container-api")]));
  const html = await render("/environments?view=services");
  expect(html).toContain('aria-selected="true" tabindex="0">Services</button>');
  const cards = html.match(/<div class="card svc">.*?<\/form><\/div><\/div>/gs);
  expect(cards).toHaveLength(2);
  expect(cards[0]).toContain('<h3>shop</h3><span class="pill">worker</span><span class="muted mono">.</span><span class="end muted mono">worker:.</span>');
  expect(cards[0]).toContain("Suggested resources (not created)");
  expect(cards[0]).toMatch(/<li><span class="muted">worker<\/span> <span class="mono">shop<\/span><\/li><li><span class="muted">d1<\/span> <span class="mono">shop-db<\/span><\/li>/);
  expect(cards[0]).toMatch(/<details><summary>Deploy flow <span class="mono">worker-root<\/span><\/summary><pre class="mono">name: worker-root\non: \[manual\]/);
  expect(cards[1]).toContain('<h3>api</h3><span class="pill">container</span><span class="muted mono">api</span><span class="end muted mono">container:api</span>');
  expect(cards[1]).toContain(">Add deploy flow</button>");
  expect(html).not.toContain('<div class="card env">');
});

it("opening the Services tab renders before the services request resolves", async () => {
  serve({ "/services": new Promise(() => {}) });
  const html = await render("/environments?view=services");
  expect(html).toContain(">Services</button>");
  expect(html.match(/<div class="card svc">/g)).toHaveLength(2);
  expect(html).toContain('<span class="bone"');
  expect(html).not.toContain("Add deploy flow");
});

it("Add deploy flow files the generated flow as an edit change and links to it", async () => {
  const sent = [];
  const shop = svc("shop", "worker", ".", [{ type: "worker", name: "shop" }], "worker-root");
  const api = svc("api", "container", "api", [{ type: "container", name: "api" }], "container-api");
  serve({ ...services([shop, api]), "/flows?ref=main": Response.json([{ flow: "container-api", head: "a".repeat(40), trigger: "manual", on: ["manual"], health: { passed: 0, failed: 0, n: 0, trusted: false } }]) });
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url, init) => {
    if (init?.method !== "POST") return fetch(url);
    sent.push([url, JSON.parse(init.body)]);
    return Response.json({ id: "c-42" }, { status: 201 });
  });
  const html = await render("/environments?view=services", { method: "POST",
    body: new URLSearchParams({ flow: "worker-root", yaml: shop.flow.yaml, target: "main", base_sha: "a".repeat(40) }) });
  expect(sent).toEqual([[`/api/repos/${repo}/changes/edit`, { target: "main", path: ".cinder/flows/worker-root.yml", base_sha: "a".repeat(40), content: shop.flow.yaml, intent: "Add deploy flow worker-root" }]]);
  const cards = html.match(/<div class="card svc">.*?<\/form><\/div><\/div>/gs);
  expect(cards[0]).toMatch(new RegExp(`<a class="mono" href="/${repo}/changes/c-42"[^>]*>c-42</a>`));
  expect(cards[0]).toMatch(/<button type="submit" class="btn btn-secondary btn-sm" disabled="">Flow added<\/button>/);
  expect(cards[1]).not.toContain("<a ");
  expect(cards[1]).toMatch(/disabled="">Flow added<\/button>/);
});

it("the Services tab shows its empty state when no service is detected", async () => {
  serve(services([]));
  const html = await render("/environments?view=services");
  expect(html).toMatch(/<div class="empty">.*<h3>No services detected<\/h3><p>Cinder looks for a Wrangler config, a Dockerfile or Cloudflare Terraform/);
  expect(html).not.toContain('<div class="card svc">');
});

it("Rollback restores environment.previous. Sync now triggers a sync run", async () => {
  const sent = [];
  const prod = { ...env("production", "Cloudflare", null), previous: "v2.13.0" };
  serve({ "/environments": Response.json([prod, { ...env("staging", "Cloudflare", null), status: "Progressing", step: 50 }]) });
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url, init) => {
    if (init?.method !== "POST") return fetch(url);
    sent.push([url, JSON.parse(init.body ?? "null")]);
    return Response.json({ name: "production", id: "s1" }, { status: 202 });
  });
  const html = await render();
  expect(html).toContain('title="Roll back to v2.13.0"');
  expect(html).toMatch(/<span class="run-i running" role="status">.*?<h3>staging<\/h3><span class="muted">Syncing · step 50%<\/span>/);
  await render(undefined, { method: "POST", body: new URLSearchParams({ intent: "rollback", env: "production", previous: "v2.13.0" }) });
  await render(undefined, { method: "POST", body: new URLSearchParams({ intent: "sync", env: "production" }) });
  expect(sent).toEqual([[`/api/repos/${repo}/environments/production/rollback`, { reason: "Rolled back to v2.13.0 from Environments" }],
    [`/api/repos/${repo}/environments/production/sync`, null]]);
});

it("a pending approval strip shows release, gate, approvers and age, and Approve resolves it", async () => {
  const sent = [];
  const pending = [{ need: "n1", release: "v2.15.0", gate: "manual", approvers: ["maya@x.dev"], at: "2026-10-04T09:00:00Z" }];
  serve({ "/environments": Response.json([{ ...env("production", "Cloudflare", null), pending }]) });
  const fetch = globalThis.fetch;
  vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    if (init?.method !== "POST") return fetch(url);
    sent.push([url, init.body]);
    return Response.json({ id: "n1" });
  });
  const text = (await render()).replace(/<[^>]+>/g, "");
  expect(text).toMatch(/Waiting for approval · v2\.15\.0 · gate: manual \(maya@x\.dev\) · \d+d agoRejectApprove/);
  await render(undefined, { method: "POST", body: new URLSearchParams({ need: "n1", decision: "Approve" }) });
  expect(sent).toEqual([["/api/needs/n1/resolve", '{"action":"Approve"}']]);
});

it("a pending approval the caller can't resolve disables Approve and Reject", async () => {
  const pending = [{ need: "n1", release: "v2.15.0", gate: "manual", approvers: ["maya@x.dev"], at: null, can_resolve: false }];
  serve({ "/environments": Response.json([{ ...env("production", "Cloudflare", null), pending }]) });
  const html = await render();
  expect(html).toMatch(/<span class="meta">Only approvers can approve<\/span><button [^>]*value="Reject" disabled=""[^>]*>Reject<\/button><button [^>]*value="Approve" disabled=""[^>]*>Approve/);
});

it("an environment card shows its secret count and links to Keystore", async () => {
  serve({ "/environments": Response.json([env("production", "Cloudflare", null)]) });
  expect(await render()).toMatch(/<a [^>]*href="\/settings\/keystore"[^>]*><svg.*?<\/svg>3 secrets · Keystore <svg/);
});

it("environment cards render before services answers", async () => {
  // Neither services nor the production card's resource tree ever answers.
  serve({ "/environments": Response.json([env("production", "Cloudflare", null)]), "/services": new Promise(() => {}),
    "/environments/production/tree": new Promise(() => {}) });
  const html = await render();
  expect(html.match(/<div class="card env">/g)).toHaveLength(1);
  expect(html).toContain("<h3>production</h3>");
  expect(html).not.toContain('aria-label="production resources"');
});

it("Environments draws card bones before its data arrives", async () => {
  // The route's hydrate fallback, with no repo loaded: the page draws without waiting on /api/repos.
  const { hydrateFallbackElement } = await routes[0].children.find((r) => r.id === "repo").children.find((r) => r.path === "environments").lazy();
  const handler = createStaticHandler([{ path: "/:repo/environments", element: hydrateFallbackElement }]);
  const at = async (q = "") => {
    const context = await handler.query(new Request(`http://cinder.test/${repo}/environments${q}`));
    return renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
  };
  const html = await at();
  expect(html.match(/<div class="card env">/g)).toHaveLength(3);
  expect(html.match(/<dd><span class="bone"/g)).toHaveLength(15);
  expect(html).toMatch(/<button type="button" class="btn btn-primary" disabled="">.*Add environment<\/button>/);
  expect((await at("?view=services")).match(/<div class="card svc">/g)).toHaveLength(2);
});
