import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Renders "/" (or path) and waits for the Suspense boundaries, so the text is what the user ends up seeing.
async function home(init, path = "/") {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`, init));
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
  const html = await new Response(prelude).text();
  return { context, html, text: html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'") };
}

// Real fetch mode: /api/repos answers `list`, /api/overview answers `overview` (a Response).
function api(list, overview) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (path) => (path === "/api/repos" ? Response.json(list) : overview()));
}

const overviewOf = (repos) => ({ account: { id: null, name: "cinder", git_host: "cinder.test" }, budget: { tokens: null, spent: 0, resets_at: "2026-11-01T00:00:00Z", alerts: [] },
  repos: repos.map((r) => ({ repo_id: r.id, description: "", language: null, pushed_at: r.created_at, agents: 0, spent: 0 })), archived: [] });

// A live worker stand-in: POST /api/repos adds a repo (importing when it imports), GET lists them, each has no changes.
function worker() {
  const repos = [];
  const posts = [];
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (path, init) => {
    if (path === "/api/overview") return Response.json(overviewOf(repos));
    if (path !== "/api/repos") return Response.json([]);
    if (init?.method !== "POST") return Response.json(repos);
    const body = JSON.parse(init.body);
    posts.push(body);
    const branch = body.import?.branch ?? body.default_branch ?? "main";
    const repo = { id: `r-${body.name}`, name: body.name, default_branch: branch, strategy: body.strategy ?? "trunk", created_at: "2026-10-05T00:00:00Z",
      branch_policy: { integration: [branch], release: [], promote: [], check: "make check", stack: "code@v1" }, status: body.import ? "importing" : "ready" };
    repos.push(repo);
    return Response.json(repo, { status: 201 });
  });
  return { repos, posts };
}
const post = (fields) => home({ method: "POST", body: new URLSearchParams(fields) });

describe("Repos page", () => {
  it("a repo with 2 developing, 1 merged and 3 failed changes reads 5 open on its Repositories card", async () => {
    const repo = { id: "r-edge", name: "edge-router", default_branch: "main", strategy: "trunk", created_at: "2026-10-05T00:00:00Z",
      branch_policy: { integration: ["main"], release: [], promote: [], check: "make check", stack: "code@v1" }, status: "ready" };
    const at = new Date().toISOString();
    const changes = ["developing", "developing", "merged", "failed", "failed", "failed"].map((state, i) => ({ id: `c${i}`, repo_id: repo.id, kind: "change",
      title: `c${i}`, intent: `c${i}`, target_branch: "main", state, fork: `f${i}`, stacked_on: null, risk: null, created_at: at, updated_at: at }));
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (path) => Response.json(path === "/api/repos" ? [repo] : path === "/api/overview" ? overviewOf([repo])
      : path.startsWith("/api/repos/edge-router/changes") ? changes : []));
    expect((await home()).text).toContain("5 open");
  });

  it("creating a repo from the panel adds it to the list without leaving the page", async () => {
    const { posts } = worker();
    const page = await home();
    const panel = page.html.match(/<form[^>]*aria-label="New repository".*?<\/form>/)[0];
    for (const field of ["intent", "name", "default_branch", "strategy"]) expect(panel).toContain(`name="${field}"`);
    expect(page.text).toContain("No repositories yet");

    const after = await post({ intent: "new", name: "billing", default_branch: "develop", strategy: "gitflow" });
    expect(after.context.statusCode).toBe(200);
    expect(posts).toEqual([{ name: "billing", default_branch: "develop", strategy: "gitflow" }]);
    expect(after.text).toContain("billing");
    expect(after.html).toContain('aria-label="New repository"');
  });

  it("New repository imports a clone URL, sending the token once and leaving a blank branch out", async () => {
    const { posts } = worker();
    const panel = (await home()).html.match(/<form[^>]*aria-label="New repository".*?<\/form>/)[0];
    expect(panel).toMatch(/type="password"[^>]*name="token"/);
    await post({ intent: "new", name: "billing", default_branch: "", strategy: "trunk", url: "https://git.example.com/org/billing.git", token: "ghp_once" });
    expect(posts).toEqual([{ name: "billing", strategy: "trunk", import: { url: "https://git.example.com/org/billing.git", token: "ghp_once" } }]);
  });

  it("the import token hint says it is kept in Keystore for re-imports", async () => {
    worker();
    const panel = (await home()).html.match(/<form[^>]*aria-label="New repository".*?<\/form>/)[0];
    expect(panel).toContain('placeholder="kept encrypted in Keystore for re-imports; remove it there"');
  });

  it("renders the prototype's cards and usage aside from fixtures", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
    const { html, text } = await home();
    for (const s of ["RepositoriesView docs", "Showing 1–4 of 4", "Token budget", "11.4Mof 18.1M tokens · resets ", "Changes merged27", "Verifier runs421",
      "Lease conflicts2", "acme/apiPublic HTTP API and auth edge", "mainGo14 open94.2%6 agents",
      "63%", "alert at 80%", "AccountNimbus", "Git hostgit.nimbus.dev"]) expect(text).toContain(s);
    for (const s of ['href="/acme%2Fapi/code/main"', 'placeholder="Search repositories"']) expect(html).toContain(s);
  });

  it("a new alert from the Add budget alert dialog appears in the Token budget card's list", async () => {
    const puts = [];
    let alerts = [80];
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (path, init) => {
      if (path === "/api/account") return puts.push(JSON.parse(init.body)) && (alerts = puts.at(-1).alerts) && new Response(null, { status: 204 });
      if (path === "/api/overview") return Response.json({ ...overviewOf(repos), budget: { tokens: 1000, spent: 0, resets_at: "2026-11-01T00:00:00Z", alerts } });
      return Response.json(path === "/api/repos" ? repos : []);
    });
    const { text } = await post({ intent: "account", alerts: "[80]", threshold: "65" });
    expect(puts).toEqual([{ alerts: [80, 65] }]);
    expect(text).toContain("alert at 80%alert at 65%");
  });

  it("disables Set budget for a non-owner", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (path) => Response.json(path === "/api/me" ? { email: "dev@cinder.test", owner: false }
      : path === "/api/overview" ? overviewOf(repos) : path === "/api/repos" ? repos : []));
    const { html } = await home();
    expect(html).toMatch(/<button type="submit" class="btn btn-secondary" disabled="">Set budget<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn btn-ghost" disabled="">.*?Add budget alert<\/button>/);
  });

  it("the Show select offers Show all and Archived only and cards carry no private tag", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
    const { html } = await home();
    // Both selects' options, Show then Sort.
    expect([...html.matchAll(/<button type="button" class="btn btn-ghost" aria-pressed="(?:true|false)">([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Show all", "Archived", "Last pushed", "Name"]);
    expect(html).not.toContain('<span class="tag">private</span>');
  });

  it("verifier rates under 20 outcomes show the untrusted text", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const { text } = await home();
    expect(text).toContain("developTypeScript11 openuntrusted: 9 outcomes5 agents");
    expect(text).toContain("Rust0 openno outcomes yet0 agents");
    expect(text.split("Usage")[0]).not.toMatch(/(0|100)%/); // the cards' rates, not the budget card's alert options
  });

  it("empty, loading and error states render as the doc describes", async () => {
    api([], () => Response.json(overviewOf([])));
    const empty = await home();
    expect(empty.text).toContain("No repositories yet");
    expect(empty.text).toContain("cinder repo add &lt;name&gt; --import &lt;git url&gt;");
    expect(empty.html).toMatch(/<button type="button" class="btn btn-primary" aria-expanded="false">.*New repository<\/button>/);

    api(repos, () => new Promise(() => {})); // the overview never answers
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request("http://cinder.test/"));
    const first = renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
    expect(first).toContain('<div aria-busy="true"><p role="status" class="sr-only">Loading repositories</p><div class="tb-in">');
    expect(first.match(/<div class="card skel-card">/g)).toHaveLength(4);

    api(repos, () => Response.json({ error: { code: "unavailable", message: "index unavailable" } }, { status: 503, headers: { "cf-ray": "7f3a91c2" } }));
    const error = await home();
    expect(error.text).toContain("Couldn't load repositories: GET /api/overview → 503 index unavailable · req 7f3a91c2");
    expect(error.html).toMatch(/<button[^>]*>.*Retry<\/button>/);
  });
});

// Selectors in app.css that would show a closed popover with the given classes inside .tb-in: the subject sets a visible display,
// isn't limited to :popover-open and doesn't exclude [popover] or one of the classes. Ancestors other than .tb-in are skipped.
function showsClosedPopover(classes) {
  const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /(^|;)\s*display:(?!\s*none)/.test(body))
    .flatMap(([, sel]) => sel.split(",").map((s) => s.trim()))
    .filter((sel) => {
      const parts = sel.split(/\s*[>+~ ]\s*(?![^(]*\))/);
      if (parts.length > 1 && !sel.includes(".tb-in")) return false;
      const subject = parts.at(-1).replace(/:where\((.*)\)/, "$1");
      if (subject.includes(":popover-open") || /:not\(\[popover\]\)/.test(subject)) return false;
      if ([...subject.matchAll(/:not\(\.([\w-]+)\)/g)].some(([, c]) => classes.includes(c))) return false;
      return [...subject.replace(/:not\([^)]*\)/g, "").matchAll(/\.([\w-]+)/g)].every(([, c]) => classes.includes(c));
    });
}

describe("Toolbar popovers", () => {
  it("the shared stylesheet has no rule that sets display on a closed [popover] inside .tb-in", () => {
    expect(showsClosedPopover([])).toEqual([]);
  });

  it("the Repositories toolbar's Show menu popover is not displayed while closed", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
    // The last toolbar is the loaded one; the first is the Suspense fallback.
    const bar = [...(await home()).html.matchAll(/<div class="tb-in">.*?<button type="button" aria-label="Refresh"/g)].at(-1)[0];
    const pop = bar.match(/>Show all<.*?<\/button>(<div [^>]*popover="auto"[^>]*>)/)[1];
    expect(pop).not.toMatch(/style="[^"]*display/);
    expect(showsClosedPopover(pop.match(/class="([^"]*)"/)[1].split(" "))).toEqual([]);
  });
});
