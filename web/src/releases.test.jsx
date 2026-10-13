import { renderToReadableStream, renderToString } from "react-dom/server";
import { repoAt } from "./fake-repos.js";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { Markdown } from "./lib/markdown.jsx";
import { routes } from "./routes.jsx";

const repo = encodeURIComponent(repos[0].name);
const path = `/${repo}/releases`;
const SHA = "a".repeat(40);
const release = (tag, state, environments) => ({ id: `r-${tag}`, repo: repos[0].name, tag, title: tag, notes: `Notes for ${tag}`, author: "owner", sha: SHA,
  state, created_at: "2026-10-04T09:00:00Z", published_at: state === "published" ? "2026-10-04T09:00:00Z" : null, environments });

const page = async (init) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`, init));
  return <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />;
};
// The first render starts tracking the loader's promise; once it settles, the second shows the result.
async function render(init) {
  const el = await page(init);
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el).replace(/<!-- -->/g, "");
}
const serve = (lists) => vi.stubGlobal("fetch", async (url) => {
  if (repoAt(url)) return Response.json(repoAt(url));
  const rest = url.slice(`/api/repos/${repo}`.length);
  return rest in lists ? lists[rest] : Response.json({ error: { code: "not_found", message: "none" } }, { status: 404 });
});

beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("draft and published states are visually distinct", async () => {
  serve({ "/tags": Response.json([]), "/releases": Response.json([release("v2.15.0-rc.2", "draft", []), release("v2.14.0", "published", ["production"])]) });
  const html = await render();
  const card = (tag) => html.match(new RegExp(`<div class="lc"><div class="lc-m">(?:(?!<div class="lc">).)*?<span class="mono">${tag.replace(/\./g, "\\.")}</span>.*?</span></div></div>`))[0];
  const [draft, published] = [card("v2.15.0-rc.2"), card("v2.14.0")];
  expect(draft).toContain('<span class="tag">draft</span>');
  expect(draft).toContain(">Publish</button>");
  expect(draft).toContain('<span class="muted">Not deployed</span>');
  expect(draft).not.toContain('class="pill"');
  expect(published).toContain('<span class="pill"><span class="dot ok"></span>published</span>');
  expect(published).not.toContain(">Publish</button>");
  expect(published).not.toContain('class="tag"');
  expect(published).toMatch(/Live in <a class="pill"[^>]*><span class="dot ok"><\/span>production<\/a>/);
});

it("releases: loading skeleton cards, empty 'No releases yet' with New tag, and a card error with Retry", async () => {
  serve({ "/tags": Response.json([]), "/releases": Response.json([]) });
  expect(await render()).toMatch(/<div class="empty">.*<h3>No releases yet<\/h3>.*New tag<\/button>/);

  vi.stubGlobal("fetch", async (url) => (repoAt(url) ? Response.json(repoAt(url)) : new Promise(() => {})));
  // The lists never settle, so the stream stops after the shell; read until the page is out.
  const reader = (await renderToReadableStream(await page(), { onError: () => {} })).getReader();
  let shell = "";
  while (!shell.includes("</main>")) shell += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  expect(shell.match(/class="card skel-card"/g)).toHaveLength(3);

  serve({ "/tags": new Response("", { status: 503 }), "/releases": Response.json([]) });
  expect(await render()).toMatch(/<div class="lc"><div class="err" role="alert">.*Couldn&#x27;t load releases<\/span><button[^>]*>Retry<\/button>/);
});

const tag = (name) => ({ name, sha: SHA, message: `Message for ${name}`, tagger: "owner", created_at: "2026-10-04T09:00:00Z" });

it("renders a card for a tag that has no release", async () => {
  serve({ "/tags": Response.json([tag("v0.0.1-qa-a"), tag("v2.14.0")]), "/releases": Response.json([release("v2.14.0", "published", [])]) });
  const html = await render();
  expect(html).toMatch(/<div class="lc"><div class="lc-m">.*<span class="mono">v0\.0\.1-qa-a<\/span>.*Message for v0\.0\.1-qa-a/);
  expect(html).not.toContain("No releases yet");
});

it("after Create tag succeeds, the new tag renders without a reload", async () => {
  let tags = [];
  serve({ "/releases": Response.json([]), get "/tags"() { return Response.json(tags); } });
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url, init) => {
    if (init?.method === "POST" && url.endsWith("/tags")) { tags = [tag(JSON.parse(init.body).tag)]; return Response.json({ sha: SHA }, { status: 201 }); }
    return fetch(url, init);
  });
  const html = await render({ method: "POST", body: new URLSearchParams({ intent: "tag", tag: "v0.0.1-qa-a", message: "qa" }) });
  expect(html).toContain('role="status">Tag v0.0.1-qa-a created</span>');
  expect(html).toMatch(/<div class="lc"><div class="lc-m">.*<span class="mono">v0\.0\.1-qa-a<\/span>/);
});

it("New tag posts the tag at the picked commit's sha", async () => {
  serve({ "/tags": Response.json([]), "/releases": Response.json([]) });
  const posts = [];
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url, init) => {
    if (init?.method !== "POST") return fetch(url, init);
    posts.push([url, JSON.parse(init.body)]);
    return Response.json(tag("v1.2.0"), { status: 201 });
  });
  await render({ method: "POST", body: new URLSearchParams({ intent: "tag", tag: "v1.2.0", message: "qa", sha: SHA }) });
  expect(posts).toEqual([[`/api/repos/${repo}/tags`, { tag: "v1.2.0", sha: SHA, message: "qa" }]]);
});

it("Preview of **bold** renders a <strong>; the release card renders the title and formatted notes", async () => {
  const r = { ...release("v1.0.0", "draft", []), title: "Manual test qa-a release", notes: "**bold** notes\n- item" };
  serve({ "/tags": Response.json([tag("v1.0.0")]), "/releases": Response.json([r]) });
  const html = await render();
  expect(html).toContain("<span>Manual test qa-a release</span>");
  expect(html).toMatch(/<div class="lc-s"><div class="md"><p><strong>bold<\/strong> notes<\/p><ul><li>item<\/li><\/ul><\/div><\/div>/);
  expect(renderToString(<Markdown text="**bold** and *it*" />)).toContain("<strong>bold</strong> and <em>it</em>");
});

it("a release card has no Promote to environment menu", async () => {
  serve({ "/tags": Response.json([]), "/releases": Response.json([release("v2.14.0", "published", ["production"]), release("v2.15.0", "draft", [])]) });
  const html = await render();
  expect(html).toMatch(/Live in <a class="pill"/);
  expect(html).not.toContain("Promote to environment");
  expect(html).not.toContain('value="promote"');
});

it("Promote exists only in Environments", async () => {
  serve({ "/tags": Response.json([]), "/releases": Response.json([release("v2.14.0", "published", ["production"]), release("v2.16.0", "published", [])]) });
  const html = await render();
  expect(html).not.toMatch(/<button[^>]*>[^<]*Promote/);
  expect(html.match(/<a [^>]*>Promote in Environments/g)).toHaveLength(1);
  expect(html).toContain(`<a href="/${repo}/environments" data-discover="true">Promote in Environments`);
});

it("Release cards show live-in chips", async () => {
  serve({ "/tags": Response.json([]), "/releases": Response.json([release("v2.14.0", "published", ["production", "staging"])]) });
  const chips = (await render()).match(/<a class="pill" title="Open \w+ in Environments" href="[^"]*"[^>]*><span class="dot ok"><\/span>\w+<\/a>/g);
  expect(chips).toHaveLength(2);
  expect(chips[0]).toContain(`href="/${repo}/environments"`);
  expect(chips[1]).toContain("staging</a>");
});

it("the Releases page shows the Code › Releases breadcrumb", async () => {
  serve({ "/tags": Response.json([]), "/releases": Response.json([]) });
  expect(await render()).toContain(`<div class="page-bar"><nav class="crumb" aria-label="Breadcrumb"><a href="/${repo}/code/${encodeURIComponent(repos[0].default_branch)}" data-discover="true">Code</a><span>›</span><span class="cur">Releases</span></nav>`);
});

it("Releases draws bones before its data arrives", async () => {
  // The route's hydrate fallback, with no repo loaded: the page draws without waiting on /api/repos.
  const { hydrateFallbackElement } = await routes[0].children.find((r) => r.id === "repo").children.find((r) => r.path === "releases").lazy();
  const handler = createStaticHandler([{ path: "/:repo/releases", element: hydrateFallbackElement }]);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const html = renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
  expect(html.match(/class="card skel-card"/g)).toHaveLength(3);
  expect(html).toContain(`<a href="/${repo}" data-discover="true">Code</a>`);
});
