// The web Code page, rendered against this worker instead of fixtures.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../../web/src/routes.jsx";
import { validateCodeHit, validateCodeLog, validateCommitDiff } from "../src/api/contract.js";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// Monaco needs a browser; the fake renders the text and mode the Code page hands it.
vi.mock("../../web/src/monaco.jsx", () => ({ default: ({ value, options }) => createElement("pre", { "data-monaco": options.readOnly ? "view" : "edit", "aria-label": options.ariaLabel }, value) }));

const fake = fakeArtifacts();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });
const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const FILE = "function one() {\n  return 1;\n}\nfunction two() {\n  return 2;\n}\n";

async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
  const { prelude } = await prerender(el);
  return (await new Response(prelude).text()).replace(/<!--.*?-->| data-discover="true"/g, "");
}

// The file viewer's text: the code region's markup with its syntax spans stripped.
const view = (html) => html.slice(html.indexOf('role="region" aria-label="src/a.js"')).replace(/<[^>]+>/g, "").replaceAll("&quot;", '"');

async function setup(name) {
  expect((await real("/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const repo = fake.repos.get(name);
  repo.commits.unshift({ sha: "m1" });
  repo.files["README.md"] = "## Hello\n";
  repo.files["src/a.js"] = FILE;
  const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  await env.DB.prepare("INSERT INTO symbols (repo_id, sha, path, name, kind, start_line, end_line) VALUES (?, 'm1', 'src/a.js', 'two', 'function', 4, 6)").bind(id).run();
}

// Signs in as ana through Cloudflare Access: the edge's JWT on every request, the team's certs served locally.
// One key for every sign-in: the Worker caches the certs by kid for the isolate's life.
let accessKeys;
async function signIn() {
  const TEAM = "cinder-test.cloudflareaccess.com";
  const keys = accessKeys ??= await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const part = (o) => b64(new TextEncoder().encode(JSON.stringify(o)));
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part({ aud: ["aud-cinder"], iss: `https://${TEAM}`, email: "ana@example.com", exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const jwt = `${body}.${b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body)))}`;
  const e = { ...env, ARTIFACTS: fake, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud-cinder", OWNERS: "ana@example.com" };
  vi.stubGlobal("fetch", async (url, init) => {
    if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256" }] });
    const req = new Request(new URL(url, "http://cinder.test"), init);
    req.headers.set("Cf-Access-Jwt-Assertion", jwt);
    return worker.fetch(req, e);
  });
}

beforeEach(() => {
  env.ARTIFACTS = fake;
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); delete env.ARTIFACTS; });

describe("code page (live)", () => {
  it("page renders a branch and a change workspace from a local worker", async () => {
    await setup("code-live");
    const res = await real("/api/repos/code-live/changes/edit", { method: "POST", headers: OWNER, body: JSON.stringify({
      target: "main", path: "src/a.js", base_sha: "m1", content: FILE.replace("return 2", "return 3"), intent: "Make two return 3",
    }) });
    const change = await res.json();
    fake.repos.get(change.fork).files["src/a.js"] = FILE.replace("return 2", "return 3");

    const branch = await render("/code-live/code/main/src/a.js");
    expect(branch).toContain('<h2 class="mono"><span>src/</span><span class="cur">a.js</span></h2><span class="meta">7 lines</span>');
    expect(view(branch)).toContain("return 2;");
    expect(branch).toMatch(/aria-current="page"[^>]*>.*<span>a\.js<\/span>/);
    expect(branch).toContain('<a class="btn btn-secondary btn-sm" href="/code-live/code/main/src/a.js?v=edit">Edit</a>');
    // The lease rail: the edit's change holds a lease on `two` in this file.
    // The lease rail: the edit's change holds a lease on `two` in this file; no one took over, so its agent (not yet named) holds it.
    expect(branch).toContain(`<span class="meta"><code>two</code> · <span class="mono">agent@pending</span> · exclusive</span>`);

    const readme = await render("/code-live/code/main");
    expect(readme).toContain('<div class="md"><h3>Hello</h3></div>');

    const ws = await render(`/code-live/code/${change.id}/src/a.js`);
    expect(view(ws)).toContain("return 3;");
    expect(ws).not.toContain("return 2;");
    expect(ws).toContain(`Workspace of <a href="/code-live/changes/${change.id}"><span class="mono" title="${change.id}">${change.id.slice(0, 8)}</span></a>`);
    expect(ws).not.toContain(">Edit</a>");
  });

  it("a change carrying agent and version renders agent@ver in the lease strip and Active in repo", async () => {
    await setup("code-agent-ver");
    const change = await (await real("/api/repos/code-agent-ver/changes/edit", { method: "POST", headers: OWNER, body: JSON.stringify({
      target: "main", path: "src/a.js", base_sha: "m1", content: FILE.replace("return 2", "return 3"), intent: "Make two return 3",
    }) })).json();
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status = 'queued'").run();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString()).run();
    const { token } = await (await real("/api/runners", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "lab", kinds: ["develop"] }) })).json();
    expect((await real("/api/work/claim", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ kinds: ["develop"] }) })).status).toBe(200);

    const file = await render("/code-agent-ver/code/main/src/a.js");
    expect(file).toContain(`<span class="meta"><code>two</code> · <span class="mono">cinder-agent@v0</span> · exclusive</span>`);
    expect(file).not.toContain("agent@pending");
    const root = await render("/code-agent-ver/code/main");
    expect(root).toContain(`<span class="meta"><span class="mono">cinder-agent@v0</span> · <code>src/a.js</code> · <code>two</code></span>`);
  });

  // m4 leaves deep.js alone, m3 edits it, m2 adds it: its history is m3 then m2. Blame is read at the head, m4.
  async function deep(name) {
    await setup(name);
    const repo = fake.repos.get(name);
    repo.commits.unshift({ sha: "m4", message: "Touch nothing here" }, { sha: "m3", message: "Tidy deep", author: { name: "bo" } }, { sha: "m2", message: "Add deep" });
    repo.files["src/lib/deep.js"] = "let a = 2;\n";
    repo.at = { m2: { ...repo.files, "src/lib/deep.js": "let a = 1;\n" }, m1: {} };
    const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
    await env.DB.prepare("INSERT INTO authorship VALUES (?, 'm4', 'src/lib/deep.js', ?)").bind(id, JSON.stringify([{ commit: "m3", person: "ana" }, { commit: "m3", person: "ana" }])).run();
  }

  it("browse to a nested file, see blame and history", async () => {
    await deep("code-deep");
    const blame = await render("/code-deep/code/main/src/lib/deep.js?v=blame");
    expect(blame).toContain('class="codev blame"');
    expect(blame).toContain('<span class="bl"><code>m3</code> <span class="mono">ana · person</span></span>');
    const history = await render("/code-deep/code/main/src/lib/deep.js?v=history");
    expect(history).toMatch(/<code>m3<\/code>.*bo · person.*Tidy deep.*<code>m2<\/code>.*unknown · person.*Add deep/);
    expect(history.slice(history.lastIndexOf('class="code-wrap"'))).not.toContain("Touch nothing here");
    const log = await (await real("/api/repos/code-deep/log?ref=main&path=src/lib/deep.js", { headers: OWNER })).json();
    expect(validateCodeLog(log)).toEqual({ ok: true, errors: [] });
  });

  it("commit history lists the seeded commits for main and develop; a commit opens its diff", async () => {
    await deep("code-commits");
    fake.repos.get("code-commits").branches = ["main", "develop"];
    for (const ref of ["main", "develop"]) {
      const html = await render(`/code-commits/code/${ref}`);
      expect(html).toContain(`<h2>Commits</h2><span class="mono">${ref}</span><span class="cm-last">Latest: <span class="mono">m4</span> Touch nothing here</span>`);
      expect(html).toMatch(/>m4<\/a>.*Touch nothing here.*>m3<\/a>.*Tidy deep.*bo.*>m2<\/a>.*Add deep.*>m1<\/a>/);
      expect(html).toContain(`href="/code-commits/code/${ref}?v=commits&amp;sha=m3"`);
    }

    const diff = await render("/code-commits/code/develop?v=commits&sha=m3");
    expect(diff).toMatch(/<code>m3<\/code><span>Tidy deep<\/span>/);
    expect(diff).toMatch(/<span>src\/lib\/deep.js<\/span>.*modified/);
    expect(diff).toContain('<div class="dl del"><span class="ln">1</span><span class="ln"></span><span class="pv"></span><span>−let a = 1;</span></div>');
    expect(diff).toContain('<div class="dl add"><span class="ln"></span><span class="ln">1</span><span class="pv"></span><span>+let a = 2;</span></div>');
    expect(diff.match(/class="fh"/g)).toHaveLength(1);

    const body = await (await real("/api/repos/code-commits/commits/m3?ref=develop", { headers: OWNER })).json();
    expect(validateCommitDiff(body)).toEqual({ ok: true, errors: [] });
    expect(body).toMatchObject({ sha: "m3", parent: "m2", author: "bo", files: [{ path: "src/lib/deep.js", status: "modified", lines: ["-let a = 1;", "+let a = 2;"] }] });
    expect((await real("/api/repos/code-commits/commits/nope?ref=main", { headers: OWNER })).status).toBe(404);
    const log = await (await real("/api/repos/code-commits/log?ref=main&page=2", { headers: OWNER })).json();
    expect(log).toMatchObject({ commits: [], more: false, total: 4 });
    expect((await real("/api/repos/code-commits/log?ref=main&page=0", { headers: OWNER })).status).toBe(400);
  });

  it("no 401 for a signed-in owner", async () => {
    await deep("code-access");
    await signIn();
    const signedIn = globalThis.fetch;
    const statuses = [];
    vi.stubGlobal("fetch", async (url, init) => {
      const res = await signedIn(url, init);
      if (String(url).startsWith("/api/")) statuses.push(`${res.status} ${url}`);
      return res;
    });
    const html = await render("/code-access/code/main/src/lib/deep.js?v=history");
    expect(html).toContain("Tidy deep");
    expect(statuses).toContain("200 /api/repos/code-access/log?ref=main&path=src%2Flib%2Fdeep.js");
    expect(statuses.filter((s) => !/^20\d /.test(s))).toEqual([]);
  });

  it("code search finds lines across the repo's files", async () => {
    await deep("code-search");
    await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "code-search" }, payload: { ref: "refs/heads/main", before: "m3", after: "m4" } } }] }, { ...env, ARTIFACTS: fake });
    const hits = await (await real("/api/repos/code-search/code-search?ref=main&q=RETURN 2", { headers: OWNER })).json();
    expect(hits).toEqual([{ path: "src/a.js", line: 5, text: "  return 2;" }]);
    expect(hits.every((h) => validateCodeHit(h).ok)).toBe(true);
    expect((await real("/api/repos/code-search/code-search?ref=main&q=r", { headers: OWNER })).status).toBe(400);
    expect(await render("/code-search/code/main?q=let%20a")).toMatch(/<a class="mono" href="\/code-search\/code\/main\/src\/lib\/deep.js">src\/lib\/deep.js:1<\/a><code>let a = 2;<\/code>/);
  });

  it("the tree lists the live repo's files and opens a file at its deep link", async () => {
    await setup("code-tree");
    const html = await render("/code-tree/code/main/src/a.js");
    expect(html).toMatch(/<button type="button" class="dir" aria-expanded="true"[^>]*>.*src<\/button>/);
    expect(html).toContain('href="/code-tree/code/main/README.md"');
    expect(html).toContain('aria-current="page" href="/code-tree/code/main/src/a.js"');
    expect(view(html)).toContain("function one() {");
  });

  it("editing then Propose change creates a change authored by the signed-in person with the edited file in its diff", async () => {
    await setup("code-propose");
    const form = await render("/code-propose/code/main/src/a.js?v=edit");
    expect(form).toContain('<pre data-monaco="edit" aria-label="Edit src/a.js">');
    expect(form).toContain('aria-label="Change message"');
    expect(form).toContain('<button type="submit" class="btn btn-primary" disabled="" title="Make an edit first">Open change</button>');

    await signIn();
    const content = FILE.replace("return 2", "return 3");
    const body = new URLSearchParams({ base_sha: "m1", content, intent: "Make two return 3" });
    const res = await createStaticHandler(routes).query(new Request("http://cinder.test/code-propose/code/main/src/a.js", { method: "POST", body }));
    const id = res.headers.get("Location").match(/^\/code-propose\/changes\/([\w-]+)$/)[1];
    const change = await (await real(`/api/changes/${id}`, { headers: OWNER })).json();
    expect(change.events[0]).toMatchObject({ kind: "created", actor: { type: "human", id: "ana@example.com" } });
    const job = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'commit'").bind(id).first();
    expect(JSON.parse(job.payload)).toMatchObject({ path: "src/a.js", content, lease: ["src/a.js#two"] });
  });

  it("saving an edit creates a change and opens it", async () => {
    await setup("code-edit");
    const form = await render("/code-edit/code/main/src/a.js?v=edit");
    expect(form).toContain('<form action="/code-edit/code/main/src/a.js?v=edit" method="post"><input type="hidden" name="base_sha" value="m1"/>');

    const handler = createStaticHandler(routes);
    const body = new URLSearchParams({ base_sha: "m1", content: FILE.replace("return 1", "return 0"), intent: "Make one return 0" });
    const res = await handler.query(new Request("http://cinder.test/code-edit/code/main/src/a.js", { method: "POST", body }));
    expect(res.status).toBe(302);
    const opened = res.headers.get("Location");
    const id = opened.match(/^\/code-edit\/changes\/([\w-]+)$/)[1];
    const change = await (await real(`/api/changes/${id}`, { headers: OWNER })).json();
    expect(change).toMatchObject({ intent: "Make one return 0", target_branch: "main", state: "leased" });
    expect(await render(opened)).toContain("Make one return 0");

    const stale = await handler.query(new Request("http://cinder.test/code-edit/code/main/src/a.js", { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(body), base_sha: "nope" }) }));
    expect(stale.actionData).toEqual({ "0-1-0": { error: "Someone committed first; reload to rebase your edit" } });
    // A refused save stays on the page, which reloads around the form.
    expect((await stale.loaderData["0-1-0"].page).files.map((f) => f.path)).toEqual(["README.md", "src/a.js"]);
  });
});
