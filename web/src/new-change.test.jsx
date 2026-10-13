import { readFileSync } from "node:fs";
import { repoAt } from "./fake-repos.js";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { createMemoryRouter, createStaticHandler, createStaticRouter, RouterProvider, StaticRouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agents from "../../worker/src/api/fixtures/agents.json";
import leaseMap from "../../worker/src/api/fixtures/lease-map.json";
import { suggest } from "./new-change.jsx";
import { routes } from "./routes.jsx";

let branchesFail = false;
vi.mock("./client.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, branchesFor: (repo) => (branchesFail ? Promise.reject(new Error("GET branches: HTTP 503")) : real.branchesFor(repo)) };
});

const path = "/acme%2Fweb/changes/new";
const intent = "Strip hop-by-hop headers before cache lookup @patch@3.3.0 #c-1042";

const page = async (url) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${url}`));
  return <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />;
};
const clean = (html) => html.replace(/<!-- -->| data-discover="true"/g, "");

// An intent handed over in the link's state (as Judges and Reconcile do): a memory router, loaded before it renders.
const handed = async (url, intent) => {
  const router = createMemoryRouter(routes, { initialEntries: [{ pathname: url.split("?")[0], search: url.slice(url.split("?")[0].length), state: { intent } }] });
  while (!router.state.initialized || router.state.navigation.state !== "idle") await new Promise((r) => setTimeout(r));
  return <RouterProvider router={router} />;
};

// The first render starts tracking the data promise; once it settles, the second render shows the result.
async function render(url, intent) {
  const el = await (intent === undefined ? page(url) : handed(url, intent));
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return clean(renderToString(el));
}

beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "1");
  vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); branchesFail = false; });

describe("new change", () => {
  it("renders every element the page doc lists from fixtures", async () => {
    const empty = await render(path);
    expect(empty).toContain('<nav class="crumb" aria-label="Breadcrumb"><a href="/acme%2Fweb/changes">Changes</a><span>/</span><span>New</span></nav>');
    expect(empty).not.toContain("<h1>");
    expect(empty).toContain('<div class="toolbar-end"><a class="btn btn-secondary" href="/acme%2Fweb/code/develop">Edit in Code</a></div>');
    // Intent panel.
    expect(empty).toMatch(/<h2>Intent<\/h2><label class="row end"><span class="meta">target<\/span><select class="input mono" aria-label="Target branch"><option selected="">develop<\/option><option>main<\/option><\/select>/);
    expect(empty).toContain('<div class="pad ibox"><textarea class="input" aria-label="Intent" aria-autocomplete="list" aria-expanded="false" spellCheck="true" placeholder="e.g. Strip hop-by-hop headers before cache lookup @patch@3.3.0 #c-1042">');
    expect(empty).toContain('<input type="checkbox"/> One change per bullet line</label>');
    expect(empty).toContain('<a class="btn btn-ghost end" href="/acme%2Fweb/changes">Cancel</a><button type="button" class="btn btn-ghost" disabled="">Save draft</button><button type="button" class="btn btn-primary" disabled="">Hand to agent</button>');
    // Two radio cards pick the mode; Describe it is the default.
    expect(empty).toMatch(/<div class="nc-mode" role="radiogroup" aria-label="How this change gets written"><label class="nc-m nc-agent"><input type="radio" name="nc-mode" checked="" value="agent"\/>.*<b>Describe it<\/b>.*<label class="nc-m nc-human"><input type="radio" name="nc-mode" value="human"\/>.*<b>I wrote it<\/b>/);
    expect(empty).toContain('<details class="nc-det"><summary>Acceptance criteria, labels, priority</summary>');
    // Prediction rail before 8 characters.
    expect(empty).toMatch(/<h2>Prediction<\/h2><span class="live-s">.*live<\/span>.*<div aria-live="polite"><p class="pred-empty">Start typing an intent. Predicted leases, collisions and risk appear here as you write.<\/p>/);

    // An intent handed over (Judges): the live prediction from fixtures.
    const ready = await render(path, intent);
    const rail = ready.match(/<aside class="rail">.*<\/aside>/)[0];
    expect(ready).toContain('<button type="button" class="btn btn-primary">Hand to agent</button>');
    expect(rail).toContain("<li><b>Predicted leases</b><code>fn normalize_headers</code><code>type HeaderMap</code></li>");
    expect(rail).toMatch(/<b>Collisions with active changes<\/b><div class="row"><a href="\/acme%2Fweb\/changes\/c-1042"><span class="mono" title="c-1042">c-1042<\/span><\/a><code>fn normalize_headers<\/code><span class="trust"[^>]*><span class="p">62%<\/span><span class="subtle">Clef<\/span>/);
    expect(rail).toMatch(/<b>Risk<\/b><div class="row"><span class="trust"[^>]*><span class="p">\d+%<\/span><span class="subtle">Jev<\/span><\/span><span class="meta">reverted or breaks develop within 7 days<\/span>/);
    expect(rail).toContain('<li><b>Agent</b><span class="mono">patch@3.3.0</span></li>');
    expect(rail).toContain('<li><b>Linked changes</b><span class="row"><a href="/acme%2Fweb/changes/c-1042"><span class="mono" title="c-1042">c-1042</span></a><span class="meta">Preserve case of X-Forwarded-* headers during normalization</span></span></li>');
    expect(rail).toContain('<li><b>Launch</b><span class="meta">1 change on <span class="br">develop</span></span></li>');
    expect(await render(`${path}?target=main`, intent)).toMatch(/<option>develop<\/option><option selected="">main<\/option>.*reverted or breaks main within 7 days.*1 change on <span class="br">main<\/span>/);

    const plain = await render(path, "Add a brand new widget");
    expect(plain).toContain('<b>Predicted leases</b><span class="meta">No existing symbols matched. Likely new code only.</span>');
    expect(plain).toContain('<li><b>Agent</b><span class="mono">patch@3.2.1 (stable, default)</span></li>');
    expect(plain).not.toContain("Linked changes");

    // Autocomplete: `@` suggests agent@version with its channel, `#` suggests active changes as id and intent.
    const data = [agents, leaseMap];
    const at = suggest("Fix it @pat", 11, data);
    expect(at.start).toBe(7);
    expect(at.items.map((i) => [i.id, i.meta])).toEqual([["patch@3.3.0", "canary"], ["patch@3.2.1", "stable"]]);
    expect(suggest("Fix #c-104", 10, data).items[0]).toEqual({ ins: "#c-1042", id: "c-1042", meta: "Preserve case of X-Forwarded-* headers during normalization" });
    expect(suggest("email a@b", 9, data)).toBeNull();
  });

  it("the new change page has no intent prefill from Code", async () => {
    const html = await render(`${path}?target=main&intent=${encodeURIComponent(intent)}`);
    expect(html).toMatch(/aria-label="Intent"[^>]*><\/textarea>/);
    expect(html).toContain('<p class="pred-empty">Start typing an intent.');
  });

  it("the selectors default from the current repo and policy", async () => {
    const details = await render(path);
    expect(details).toContain('<option value="patch@3.2.1" selected="">patch@3.2.1 · stable · 54% win</option>');
    expect(details).toContain('<option value="patch@3.3.0">patch@3.3.0 · canary · 60% win</option>');
    expect(details).toContain('<option value="scribe@2.2.0">scribe@2.2.0 · canary · not enough races</option>');
    expect(details).toContain('<option selected="">P2</option>');
    expect(details).toContain('aria-label="Labels"');
    expect(details).toContain('aria-label="Acceptance criteria"');
    // The target comes from the repo's branch policy, defaulting to its default branch.
    expect(await render(path)).toMatch(/target<\/span><select class="input mono" aria-label="Target branch"><option selected="">develop<\/option><option>main<\/option><\/select>/);
  });

  it("?head= opens I wrote it with the branch's diff summary, reviewers and the What happens rail", async () => {
    const html = await render("/acme%2Fweb/changes/new?target=develop&head=release%2F2.5");
    const t = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(html).toContain('<input type="radio" name="nc-mode" checked="" value="human"/>');
    expect(html).toMatch(/<option value="">Pick a branch you pushed<\/option><option selected="">release\/2.5<\/option><option>main<\/option><option>spike\/cache<\/option><\/select>/);
    expect(t).toContain("or push to refs/for/develop");
    expect(t).toContain("release/2.5 2 commits · 214 files +6120 −840");
    expect(html).toContain('<input class="input" aria-label="Title" placeholder="Title" value="2.5"/>');
    expect(html).toContain('<button type="button" class="btn btn-ghost btn-sm nc-rv" aria-pressed="false">');
    expect(t).toContain("sam@acme.test");
    expect(html).toMatch(/<input type="checkbox"\/><span><b>Let agents push to it<\/b>/);
    expect(html).toContain('<button type="button" class="btn btn-primary" disabled="" title="Pick a reviewer">Open change</button>');
    expect(t).toContain("What happens Verifier runs");
    expect(t).toMatch(/Judges score it.*Reviewers approve.*Verifier merges Through the merge queue into develop/);
  });

  it("empty, loading and error states render as the doc describes", async () => {
    // Empty: before 8 characters the rail asks for an intent and Launch stays disabled.
    const short = await render(path, "Fix");
    expect(short).toContain('<p class="pred-empty">Start typing an intent.');
    expect(short).toContain('<button type="button" class="btn btn-primary" disabled="">Hand to agent</button>');

    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url) => (repoAt(url) ? Response.json(repoAt(url)) : new Promise(() => {})));
    // The data fetch never settles, so the stream stops after the shell; read until the page is out.
    const reader = (await renderToReadableStream(await page(path), { onError: () => {} })).getReader();
    let shell = "";
    while (!shell.includes("</main>")) shell += new TextDecoder().decode((await reader.read()).value);
    reader.cancel();
    expect(clean(shell)).toMatch(/<aside class="rail"><div class="panel" aria-busy="true">.*Loading prediction…/);
    expect(shell).toContain('aria-label="Intent"');

    vi.stubGlobal("fetch", async (url) => (repoAt(url) ? Response.json(repoAt(url))
      : url.endsWith("/lease-map") ? new Response("", { status: 503 }) : new Promise(() => {})));
    const failed = await render(path);
    expect(failed).not.toContain("<h1>");
    expect(failed).toMatch(/<div class="state error"><h2>Couldn&#x27;t load the prediction<\/h2><pre>GET \/api\/repos\/acme%2Fweb\/lease-map: HTTP 503<\/pre><button[^>]*>.*Retry<\/button>/);
    expect(failed).toContain('aria-label="Intent"');
  });

  it("opens with the prediction when branches fail", async () => {
    branchesFail = true;
    const html = await render(path, intent);
    expect(html).not.toContain("Couldn&#x27;t load the prediction");
    expect(html).toContain("<li><b>Predicted leases</b><code>fn normalize_headers</code><code>type HeaderMap</code></li>");
  });

  it("no color literal or font-family outside tokens.css", () => {
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    const jsx = readFileSync(new URL("new-change.jsx", import.meta.url), "utf8");
    for (const sel of [".ibox{", ".ibox textarea.input{", ".sugg{", ".sugg button{", ".pred-empty{"]) expect(css).toContain(sel);
    for (const src of [css, jsx]) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/);
      expect(src).not.toMatch(/font-family:\s*(?!var\(--font-)|fontFamily/);
    }
    expect(jsx).not.toMatch(/style=\{\{/);
  });
});
