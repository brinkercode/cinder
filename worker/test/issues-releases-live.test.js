// The web Releases page, written through its forms against this worker.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { invalidate } from "../../web/src/client.js";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const REPO = "issues-releases-live";
const fake = fakeArtifacts({ creates: { [REPO]: {} } });
const net = globalThis.fetch;
// Creates go to the fake; commits and tags push to a real bare repo, which the fake can't take. The push itself (to the relay) goes out.
const real = (url, init) => {
  const u = new URL(url, "http://cinder.test");
  if (u.host !== "cinder.test") return net(url, init);
  return worker.fetch(signedIn(u, init), { ...env, ARTIFACTS: /\/(commits|tags)$/.test(u.pathname) ? { get: async (n) => bareRepo(n) } : fake, PIPELINE: { create: async () => ({}) } });
};

const query = (path, form) => createStaticHandler(routes).query(new Request(`http://cinder.test${path}`, form && { method: "POST", body: new URLSearchParams(form) }));
async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
  return (await new Response((await prerender(el)).prelude).text()).replace(/<!--.*?-->| data-discover="true"/g, "");
}
let head;

beforeAll(async () => {
  await real("/api/repos", { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ name: REPO }) });
  await git(["init", "-q", "--bare", "-b", "main", `${REPO}.git`]);
  // New tag tags a picked commit, so main needs one: its sha is what the dialog posts.
  head = (await (await real(`/api/repos/${REPO}/commits`, { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
    body: JSON.stringify({ branch: "main", base_sha: null, message: "init", changes: [{ path: "README.md", content: "hi\n" }] }) })).json()).sha;
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// The Code toolbar's link to Releases is checked in web/src/code.test.jsx; this repo's files live outside the fake, so Code shows Quick setup.
it("e2e: create a tag on Releases, and it persists after a reload", async () => {
  const releases = `/${REPO}/releases`;
  expect(await render(releases)).toContain("<h3>No releases yet</h3>");
  const tagged = await query(releases, { intent: "tag", tag: "v1.0.0", message: "First cut", sha: head });
  expect(Object.values(tagged.actionData)).toEqual([{ created: "v1.0.0" }]);
  expect(await git(["--git-dir", `${REPO}.git`, "rev-parse", "--verify", "-q", "refs/tags/v1.0.0"])).toMatch(/^[0-9a-f]{40}$/);
  expect(await render(releases)).toContain("<option>v1.0.0</option>");
});

it("promoting shows up in Environments and on that environment's card once its deploy succeeds", async () => {
  fake.repos.get(REPO).files[".cinder.yml"] = "deploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true }\n  worker: wrangler.jsonc\n";
  const releases = `/${REPO}/releases`;
  await query(releases, { intent: "tag", tag: "v2.0.0", message: "Second cut", sha: head });
  await query(releases, { intent: "release", tag: "v2.0.0", title: "Second cut", notes: "**Faster** handshakes" });
  const { id, sha } = (await (await real(`/api/repos/${REPO}/releases`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } })).json()).find((r) => r.tag === "v2.0.0");
  await query(releases, { intent: "publish", id });
  // Promotion lives on Environments.
  const promoted = await query(`/${REPO}/environments`, { env: "production", release: id });
  expect(Object.values(promoted.actionData)).toEqual([null]);
  expect(await render(releases)).toMatch(/<span class="mono">v2\.0\.0<\/span>.*?Not deployed/);
  // The promote's deploy lands (the pipeline marks its sync Synced).
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES ('irl-sync', ?, 'production', ?, 'irl-version', 'Synced', '[]', 'owner', ?, ?)")
    .bind(REPO, sha, "2026-10-07T00:00:00Z", "2026-10-07T00:00:00Z").run();
  // Written straight to D1, so no live event drops the pages' kept GETs: the next renders are a fresh page load.
  invalidate();
  expect(await render(`/${REPO}/environments`)).toMatch(/<h3>production<\/h3>.*<dt>Version<\/dt><dd class="mono">v2\.0\.0<\/dd>/);
  expect(await render(releases)).toMatch(/<span class="mono">v2\.0\.0<\/span>.*?Live in <a class="pill"[^>]*><span class="dot ok"><\/span>production<\/a>/);
});

it("Releases loads for a repo with recorded deploys", async () => {
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, status, changes, actor, started_at, at) VALUES ('irl-other', ?, 'production', ?, 'Synced', '[]', 'owner', ?, ?)")
    .bind(REPO, "1".repeat(40), "2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z").run();
  expect(await render(`/${REPO}/releases`)).toMatch(/<span class="mono">v2\.0\.0<\/span>.*?Live in <a class="pill"[^>]*><span class="dot ok"><\/span>production<\/a>/);
  expect(await render(`/${REPO}/environments`)).toContain("<h3>production</h3>");
});

it("unknown repo URLs and the repo-less Releases URL redirect", async () => {
  expect((await query(`/${REPO}/nope/deeper`)).headers.get("Location")).toBe(`/${REPO}/code/main`);
  expect(await render("/releases")).toContain(`href="/${REPO}/releases"`);
});
