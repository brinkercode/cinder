// The web Code page, rendered against this worker after the seed imported the orders service and the Terraform module.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_REPOS, REPOS, client, seedCode, seedCodePage, seedLibrary } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { SEED_SOURCES } from "./fakes/seed.js";
import { indexFor, markReady } from "./helpers/pool.js";

const fake = fakeArtifacts();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });
const FILE = "orders.go";

// The fake can't take a git push, so the seed's commits land straight in the fake repo.
const commit = async ({ repo: name, commits }) => {
  const repo = fake.repos.get(name);
  return commits.map(({ files, author, message }) => {
    Object.assign(repo.files, files);
    repo.commits.unshift({ sha: `seed${repo.commits.length}`, author: { name: author }, message });
    return repo.commits[0].sha;
  });
};

async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
  const { prelude } = await prerender(el);
  return (await new Response(prelude).text()).replace(/<!--.*?-->| data-discover="true"/g, "");
}

beforeAll(async () => {
  env.ARTIFACTS = fake;
  // Only the code section: a full seed() claims jobs other test files share this database for.
  const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
  await seedLibrary(api, commit, { [REPOS.trunk]: SEED_SOURCES[REPOS.trunk], [CODE_REPOS.code]: SEED_SOURCES[CODE_REPOS.code] });
  // A pool indexes both repos' main first, so the seeded changes lease the symbols they touch.
  await indexFor(api, REPOS.trunk, "main", [{ path: FILE, name: "Create", kind: "function", line: 37, end: 49, exported: true }]);
  await indexFor(api, CODE_REPOS.code, "main", [
    { path: "main.tf", name: "edge", kind: "resource", line: 6, end: 17 },
    { path: "variables.tf", name: "compatibility_date", kind: "variable", line: 27, end: 30 },
    { path: "tests/plan.tftest.hcl", name: "plans_worker_assets_and_d1", kind: "run", line: 10, end: 25 },
  ]);
  await seedCode(api);
  await seedCodePage(api);
  // A person marks the seed's drafts ready, so the changes take their leases.
  await markReady(api, [REPOS.trunk, CODE_REPOS.code]);
  await real("/api/repos", { method: "POST", body: JSON.stringify({ name: "manual-empty-1" }) });
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", real);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("code seed (live)", () => {
  it("after seeding, a file shows a lease rail and its authorship waits for a pool's blame job", async () => {
    const res = await real(`/api/repos/${REPOS.trunk}/authorship?ref=main&path=${FILE}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } });
    expect(res.status).toBe(202);
    const page = await render(`/${REPOS.trunk}/code/main/${FILE}`);
    expect(page).toContain(`<h2 class="mono"><span class="cur">${FILE}</span></h2>`);
    expect(page).toContain("<h2>Live on this file</h2>");
    expect(page).toContain('<span class="meta"><code>Create</code> · <span class="mono">agent@pending</span> · exclusive</span>');
  });

  it("seed.mjs seeds the Code page with the Terraform module's history, its leases and an empty repo", async () => {
    const page = await render(`/${CODE_REPOS.code}/code/main/main.tf`);
    // Commits: the imported history, newest first.
    expect(page).toMatch(/<span class="cm-last">Latest: <span class="mono">seed\d+<\/span> Test: [^<]+<\/span><span class="end">\d+ commits<\/span>/);
    // Lease bands on the Worker's lines 6-17 (an agent's); tree dots: the tests' file is a person's, main.tf an agent's.
    const banded = [...page.matchAll(/<div class="cl leased exclusive (\w+)"><span class="ln">(\d+)<\/span>/g)].map(([, kind, n]) => `${kind}${n}`);
    expect(banded).toEqual(Array.from({ length: 12 }, (_, i) => `agent${i + 6}`));
    expect(page).toMatch(/<span>plan\.tftest\.hcl<\/span><span class="tr-l human" title="Leased by [^"]+" aria-hidden="true">/);
    expect(page).toMatch(/<span>main\.tf<\/span><span class="tr-l agent" title="Leased by [^"]+" aria-hidden="true">/);
    expect(await render("/manual-empty-1/code/main")).toContain("Quick setup");
  });
});
