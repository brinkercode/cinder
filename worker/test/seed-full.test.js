// The full seed: every section through the real API, then every page of the web app rendered against it.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { CI, INTENTS, PEOPLE, PEOPLE_EDITS, REPOS, ROLES, client, commitRelease, seed, seedReview } from "../../seed/seed.mjs";
import { routes } from "../../web/src/routes.jsx";
import { JOB_KINDS } from "../src/api/contract.js";
import worker from "../src/index.js";
import { routes as apiRoutes } from "../src/routes.js";
import { signedIn } from "./helpers/edge.js";
import { git } from "./fakes/bare-repo.js";
import { BAKED_IN, agentsFake } from "./fakes/agents-repo.js";
import { SEED_IMPORTS, SEED_SOURCES, relayCommit } from "./fakes/seed.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";
import { fakeReset } from "./fakes/reset.js";

// Every repo's remote is one relay bare repo, so the baked-in agents and the seed's releases commit for real.
let fake;
const cf = fakeCloudflare();
// The Worker's own git reads (the branches list) go to the relay even while pages fetch from the Worker.
const net = globalThis.fetch;
const pages = (input, init) => (String(input?.url ?? input).startsWith(inject("runnerRelay").url) ? net(input, init) : real(input, init));
const real = cf.through((url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake, PIPELINE: { create: async () => ({}) }, ...cf.env }));
const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });

// The relay's bare repos are shared by every test file in the run, so this file's are prefixed with its own dir.
const dir = crypto.randomUUID();
const push = commitRelease(api);
// A repo's history goes through the real seed route into a relay bare repo, mirrored into the fake.
const commit = (body) => relayCommit(dir, fake)(body);
const full = () => seed(api, push, "all", commit, SEED_SOURCES);
const repoGit = (repo, ...args) => git(["--git-dir", `${dir}-${repo}.git`, ...args]);

const snapshot = async () => {
  const repos = (await api("GET", "/api/repos")).map((r) => r.name);
  const per = (path) => Promise.all(repos.map(async (r) => (await api("GET", `/api/repos/${r}/${path}`)) ?? []));
  return {
    repos,
    changes: (await per("changes")).flat().map((c) => [c.id, c.state]),
    threads: (await Promise.all((await per("changes")).flat().map((c) => api("GET", `/api/changes/${c.id}/threads`)))).flat().length,
    wiki: (await per("wiki/tree")).flat().length,
    issues: (await per("issues")).flat().map((i) => i.state),
    releases: (await per("releases")).flat().map((r) => [r.tag, r.state]),
    scans: (await per("scans")).flat().length,
    runners: (await api("GET", "/api/workers")).length,
    people: (await api("GET", "/api/people")).length,
    needs: (await api("GET", "/api/needs")).map((n) => n.kind),
    git: await Promise.all(Object.keys(SEED_SOURCES).map((r) => repoGit(r, "log", "--all", "--format=%H %an %aI %D"))),
  };
};

// The owner, signed in through Access before the first seed, so the import credits them too.
const OWNER = "owner@example.com";
beforeAll(async () => {
  fake = await agentsFake(dir, SEED_IMPORTS);
  env.ARTIFACTS = fake;
  env.OWNERS = OWNER;
  await env.DB.prepare("INSERT INTO people (email, created_at) VALUES (?, '2026-10-01T00:00:00Z')").bind(OWNER).run();
}, 120000);
beforeEach(() => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", cf.through(globalThis.fetch)); // the keystore and model keys' Cloudflare API; the rest unchanged
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => { delete env.ARTIFACTS; delete env.OWNERS; });

// First in the file: a full seed files the work section's intents, and a re-run files nothing to record.
it("the work section files intents and claims two through the claim route", async () => {
  const calls = [];
  const recording = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => {
    if (init?.method && init.method !== "GET") calls.push([init.method, new URL(url).pathname, init.body && JSON.parse(init.body)]);
    return real(url, init);
  } });
  // Changes and issues first, as in a full seed (the issues section links a change); a second run finds the intents by title and files nothing.
  for (let i = 0; i < 2; i++) await seed(recording, commitRelease(recording), ["changes", "issues", "work"], commit, SEED_SOURCES);
  const issues = `/api/repos/${REPOS.infra}/issues`;
  const filed = calls.filter(([m, path, body]) => m === "POST" && path === issues && INTENTS.includes(body.title));
  expect(filed).toHaveLength(4);
  const { items } = await api("GET", `/api/repos/${REPOS.infra}/work`);
  const ns = items.filter((i) => INTENTS.some((t) => i.title.endsWith(t))).map((i) => i.n);
  // Only the claim route writes to them: nothing edits the intents or their rows directly.
  const writes = calls.filter(([, path]) => ns.some((n) => path.startsWith(`${issues}/${n}/`) || path === `${issues}/${n}`));
  expect(writes.map(([m, path, body]) => [m, path.endsWith("/claim"), body.mode, body.agents.length])).toEqual([["POST", true, "agent", 1], ["POST", true, "race", 2]]);
  // The claimed intents are in progress: the agent's change and the race's two legs, none committed yet.
  expect(items.filter((i) => i.kind === "change" && ns.includes(i.n)).map((i) => i.lane)).toEqual(["progress", "progress", "progress"]);
}, 120000);

it("Seed test: --full against a local Worker imports every repo with its history and flows, and a re-run changes nothing", async () => {
  await full();
  const first = await snapshot();
  await full();
  expect(await snapshot()).toEqual(first);
  expect(first.repos).toEqual(expect.arrayContaining(Object.keys(SEED_SOURCES)));
  for (const [repo, files] of Object.entries(SEED_SOURCES)) {
    // History: dated commits by several people, every file of the repo on main, its flows among them, and a feature branch.
    const log = (await repoGit(repo, "log", "--format=%an %aI", "main")).split("\n");
    expect(new Set(log.map((l) => l.split(" ")[0])).size, repo).toBeGreaterThan(1);
    expect(log.at(-1), repo).toMatch(/ 2026-0[78]-\d\dT/);
    expect((await repoGit(repo, "ls-tree", "-r", "--name-only", "main")).split("\n"), repo).toEqual(expect.arrayContaining(Object.keys(files)));
    expect(Object.keys(files).some((p) => p.startsWith(".cinder/flows/")), repo).toBe(true);
    expect(await repoGit(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feature/"), repo).not.toBe("");
    expect((await api("GET", `/api/repos/${repo}/issues`)).some((i) => i.labels.includes("bug")), repo).toBe(true);
  }
  // Gitflow: develop, a release branch, tags and releases; the storefront's environments, v1.0.0 promoted to production.
  expect(await repoGit(REPOS.gitflow, "for-each-ref", "--format=%(refname:short)", "refs/heads/develop", "refs/heads/release/")).toBe("develop\nrelease/1.1\nrelease/1.2");
  expect(await repoGit(REPOS.gitflow, "tag")).toBe("v1.0.0\nv1.1.0\nv1.2.0-rc.1");
  expect(first.releases).toEqual(expect.arrayContaining([["v1.1.0", "published"], ["v1.2.0-rc.1", "draft"]]));
  const envs = await api("GET", `/api/repos/${REPOS.gitflow}/environments`);
  expect(envs.map((e) => [e.name, e.target, e.release])).toEqual([["dev", "Cloudflare", null], ["staging", "Cloudflare", null], ["production", "Cloudflare", null]]);
  // Agents on the catalog's Workers AI models, with stable and canary channels.
  const dev = await api("GET", "/api/agents/developer");
  expect(dev.versions.find((v) => v.version === 3).model).toMatch(/^@cf\//);
  expect(dev.channels).toEqual(expect.arrayContaining([{ channel: "stable", version: 2 }, { channel: "canary", version: 3 }]));
}, 300000);

const FULL = [REPOS.gitflow, REPOS.trunk, REPOS.infra];

it("after a full seed, /api/repos lists exactly web-store, svc-orders-go and infra-cloudflare-tf", async () => {
  await full();
  expect((await api("GET", "/api/repos")).map((r) => r.name).sort()).toEqual(["infra-cloudflare-tf", "svc-orders-go", "web-store"]);
  for (const repo of FULL) {
    expect((await repoGit(repo, "rev-list", "--count", "main")).trim() * 1, repo).toBeGreaterThanOrEqual(4);
    expect(new Set((await repoGit(repo, "log", "--format=%an", "main")).split("\n")).size, repo).toBeGreaterThanOrEqual(4);
    expect((await api("GET", `/api/repos/${repo}/branches`)).length, repo).toBeGreaterThanOrEqual(3);
    expect((await api("GET", `/api/repos/${repo}/changes`)).length, repo).toBeGreaterThan(0);
    expect((await api("GET", `/api/repos/${repo}/releases`)).filter((r) => r.state === "published").length, repo).toBeGreaterThanOrEqual(2);
    expect((await api("GET", `/api/repos/${repo}/wiki/tree`)).length, repo).toBeGreaterThan(0);
  }
}, 300000);

it("web-store's develop has merge commits from feature branches and main has the release merge tagged v1.1.0", async () => {
  await full();
  const g = (...args) => repoGit(REPOS.gitflow, ...args);
  expect((await g("log", "--merges", "--format=%s", "develop")).split("\n")).toEqual(expect.arrayContaining(["Merge feature/worker into develop",
    "Merge feature/lib into develop", "Merge feature/public into develop", "Merge feature/migrations into develop", "Merge feature/tests into develop",
    "Merge feature/flows into develop", "Merge release/1.1 into develop"]));
  expect(await g("log", "-1", "--format=%s", "v1.1.0")).toBe("Merge release/1.1 into main");
  expect(await g("rev-parse", "v1.1.0^{commit}")).toBe(await g("rev-parse", "main"));
  expect(await g("rev-parse", "v1.1.0^{commit}^2")).toBe(await g("rev-parse", "release/1.1"));
}, 120000);

it("no seed repo commit changes only CHANGELOG.md", async () => {
  await full();
  for (const repo of FULL) {
    const commits = (await repoGit(repo, "log", "--all", "--diff-merges=first-parent", "--name-only", "--format=%x00%s")).split("\0").slice(1);
    expect(commits.length, repo).toBeGreaterThan(0);
    expect(commits.filter((c) => c.trim().split("\n").slice(1).filter(Boolean).join() === "CHANGELOG.md"), repo).toEqual([]);
  }
}, 120000);

it("web-store keeps one open feature branch not merged into develop", async () => {
  await full();
  const open = await repoGit(REPOS.gitflow, "branch", "--no-merged", "develop", "--list", "feature/*");
  expect(open).toBe("feature/postcodes-outside-the-us");
  expect((await repoGit(REPOS.gitflow, "branch", "--merged", "develop", "--list", "feature/*")).split("\n").length).toBe(6);
}, 120000);

it("Seed test: re-running the full seed changes nothing", async () => {
  await full();
  const first = await snapshot();
  const deploys = () => Promise.all(FULL.map(async (r) => (await api("GET", `/api/repos/${r}/environments`)).flatMap((e) => e.history.map((h) => h.started_at))));
  const before = await deploys();
  await full();
  expect([await snapshot(), await deploys()]).toEqual([first, before]);
}, 300000);

it("seed with all sections against the worker test env completes and a second run creates nothing new", async () => {
  await full();
  const first = await snapshot();
  await full();
  expect(await snapshot()).toEqual(first);
  expect(first.wiki).toBeGreaterThan(0);
  expect(new Set(first.issues)).toEqual(new Set(["open", "closed"]));
  expect(first.releases).toEqual(expect.arrayContaining([["v1.0.0", "published"], ["v1.1.0", "published"], ["v1.2.0-rc.1", "draft"]]));
}, 120000);

it("seed with all sections against the worker test env completes with the baked-in agent model", async () => {
  await full();
  const agents = await api("GET", "/api/agents");
  for (const name of [...BAKED_IN, "dev-open"]) expect(agents.find((a) => a.name === name)?.versions[0].version, name).toBe(1);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE kind IN ('release', 'draft')").first("n")).toBe(0);
  // The sections after agents ran: the release branch.
  expect((await api("GET", `/api/repos/${REPOS.gitflow}/changes`)).some((c) => c.target_branch === "release/1.2")).toBe(true);
}, 120000);

it("the seed releases only the agents the platform runs, each on web markdown", async () => {
  await full();
  const agents = await api("GET", "/api/agents");
  expect(agents.map((a) => a.name).sort()).toEqual(["dev-open", "developer", "resolver", "reviewer"]);
  const versions = async (name) => (await api("GET", `/api/agents/${name}/versions`)).map((v) => [v.version, v.channel, v.web.mode]);
  expect(await versions("developer")).toEqual([[1, null, "markdown"], [2, "stable", "markdown"], [3, "canary", "markdown"]]);
  expect(await versions("dev-open")).toEqual([[1, "stable", "markdown"]]);
  for (const name of ["reviewer", "resolver"]) expect(await versions(name), name).toEqual([[1, null, "markdown"], [2, "stable", "markdown"]]);
  expect((await api("GET", "/api/agents/developer")).versions.find((v) => v.version === 3)).toMatchObject({ races: 0, wins: 0 });
}, 120000);

it("the full seed still produces its initial trees with distinct authors without a policy job", async () => {
  await full();
  expect(await repoGit(REPOS.trunk, "log", "--format=%an <%ae>", "main")).toMatch(/^([\w.]+ <[\w.]+@example.com>\n?){4}$/);
  expect(await repoGit(REPOS.trunk, "show", "main:.cinder.yml")).toContain("integration: [main]");
  expect(await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'policy'").first("n")).toBe(0);
}, 120000);

it("a full seed leaves no person without an email", async () => {
  await full();
  const { results } = await env.DB.prepare("SELECT email FROM people").all();
  expect(results.length).toBeGreaterThan(0);
  expect(results.filter((p) => !/^[^\s@]+@[^\s@]+$/.test(p.email))).toEqual([]);
}, 120000);

it("every commit author on the seed repos is the owner or a seeded person's email", async () => {
  await full();
  for (const repo of FULL) {
    const authors = new Set((await repoGit(repo, "log", "--all", "--format=%ae")).trim().split("\n"));
    expect([...authors].filter((a) => a !== OWNER && !PEOPLE.includes(a)), repo).toEqual([]);
    expect(authors.has(OWNER), repo).toBe(true);
  }
}, 120000);

it("no seeded person is a viewer who authored a commit", async () => {
  await full();
  const viewers = PEOPLE.filter((_, i) => ROLES[i] === "viewer");
  expect(viewers.length).toBeGreaterThan(0);
  for (const repo of FULL) expect((await repoGit(repo, "log", "--all", "--format=%ae")).split("\n").filter((a) => viewers.includes(a)), repo).toEqual([]);
}, 120000);

async function render(path) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  if (context instanceof Response) return `redirect ${context.status}`;
  // Deferred loader fields (promises the page <Await>s) are settled before the render, as the agents live test does.
  await Promise.allSettled(Object.values(context.loaderData).flatMap((d) => Object.values(d ?? {})));
  const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
  renderToString(el);
  await new Promise((r) => setTimeout(r));
  return renderToString(el);
}

it("every page route in web/src/routes.jsx renders non-empty data (no empty state) after the full seed", async () => {
  await full();
  vi.stubGlobal("fetch", pages);
  const [change] = await api("GET", `/api/repos/${REPOS.trunk}/changes`);
  const { trunk: t, gitflow: g } = REPOS;
  // Each data page and the URL that shows it; null marks one no seed can fill. Stubs, pickers and redirects have no data.
  const PAGES = {
    "/": "/", "/:repo": null, "code/:ref/*": `/${t}/code/main/`,
    changes: `/${t}/changes`, "changes/:id/:tab?": `/${t}/changes/${change.id}`,
    settings: `/${g}/settings`, "changes/new": `/${t}/changes/new`, insights: `/${t}/insights`,
    watchtower: null, "changes/collisions": null,
    environments: `/${g}/environments`,
    flows: `/${g}/flows`, "flows/runs/:id": null, "/automation/workers": "/automation/workers", "/settings/keystore": null, "/settings/access": "/settings/access",
    "/automation/judges/:id?": "/automation/judges", "/automation/agents": "/automation/agents",
    "/automation/agents/:name/:tab?": "/automation/agents/developer/runs", "/needs": null,
    releases: `/${t}/releases`,
    "/wiki": "/wiki", "/wiki/:repo/:id?": `/wiki/${t}`,
    "/me/models": "/me/models", "/automation/marketplace": "/automation/marketplace",
  };
  const stub = (r) => ["Soon", "PickRepo"].includes(r.element?.type?.name) || !r.element;
  const all = (rs) => rs.flatMap((r) => [r, ...all(r.children ?? [])]).filter((r) => r.path);
  const missing = all(routes).filter((r) => !stub(r) && !(r.path in PAGES)).map((r) => r.path);
  expect(missing).toEqual([]);
  const empty = [];
  for (const path of Object.values(PAGES).filter(Boolean)) {
    const html = await render(path);
    // An empty, error or loading state, or a page that only redirects.
    const at = html.search(/class="state[ "]|empty-cell|aria-busy|^redirect/);
    if (at >= 0) empty.push(`${path}: ${html.slice(at, at + 120)}`);
  }
  expect(empty).toEqual([]);
}, 120000);

it("issues board: the full seed gives each repo a backlog over the board's columns, and the trunk repo's feature links its change", async () => {
  await full();
  const board = await api("GET", `/api/repos/${REPOS.gitflow}/issues`);
  const each = (list, k) => [...new Set(list.map((i) => i[k]))].sort();
  expect([each(board, "status"), each(board, "priority"), each(board, "iteration")]).toEqual([["backlog", "done", "progress", "todo"], ["P1", "P2", "P3"], ["Sprint 13", "Sprint 14", null]]);
  const trunk = await api("GET", `/api/repos/${REPOS.trunk}/issues`);
  expect([each(trunk, "status"), trunk.filter((i) => i.change).length]).toEqual([["done", "progress", "review"], 1]);
}, 120000);

it("a full seed registers no runner token and only the self-hosted BYO pool", async () => {
  // Storage is shared within this file, so only names the seed adds count.
  const outside = async () => {
    const ids = (await api("GET", "/api/workers/pools")).map((p) => p.id);
    return (await api("GET", "/api/workers")).filter((w) => !ids.includes(w.pool)).map((w) => w.name);
  };
  const before = await outside();
  await full();
  const managed = await api("GET", "/api/workers/pools");
  expect(managed.map((p) => [p.name, p.size, p.kinds])).toEqual([["build", "basic", JOB_KINDS], ["toolchains", "standard-2", JOB_KINDS]]);
  expect((await outside()).filter((n) => !before.includes(n))).toEqual([]);
  expect((await api("GET", "/api/workers/byo-pools")).map((p) => [p.name, p.labels, p.members])).toEqual([["self-hosted", ["linux", "gpu"], 0]]);
  expect(managed.find((p) => p.name === "toolchains").labels).toEqual(["linux", "full-image"]);
}, 120000);

it("seed.mjs seeds the Agents fleet's versions, channels and roles, with only the races it claims and no gateway calls", async () => {
  await full();
  vi.stubGlobal("fetch", real);
  const text = async (path) => (await render(path)).replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
  const index = await text("/automation/agents");
  for (const row of ["|developer|v2|stable|canary v3|develop · opencode · 0 repos|idle|Win rate |no outcomes yet|0| tokens|0| merged|0| races|",
    "|resolver|v2|stable|resolve conflicts · opencode · 0 repos|", "|dev-open|v1|stable|open-model develop · opencode · 0 repos|idle|"]) expect(index).toContain(row);
  expect(await text("/automation/agents/developer/runs")).toContain("|No runs yet|AI Gateway has logged no call for this agent.|");
  expect(await text("/automation/agents/developer/races")).toMatch(/\|#\d+ Add a KV namespace for feature flags\|/);
  // The test's Artifacts fake reads no file the commit API wrote, so the prompt itself shows only against the e2e Worker.
  expect(await text("/automation/agents/developer/settings")).toContain("|Model|Cloudflare credits|@cf/qwen/qwen2.5-coder-32b-instruct|");
}, 120000);

it("no seeded wiki page tells the reader to run kubectl", async () => {
  await full();
  for (const repo of Object.keys(SEED_SOURCES)) expect(await api("GET", `/api/repos/${repo}/wiki/search?q=kubectl`), repo).toEqual([]);
  expect((await api("GET", `/api/repos/${REPOS.trunk}/wiki/search?q=rollback`)).map((p) => p.title)).toContain("Roll back a bad rollout");
}, 120000);

it("Environments: the full seed gives the storefront dev, staging and production cards, none deployed; the empty repo has none", async () => {
  await full();
  vi.stubGlobal("fetch", real);
  const envs = await api("GET", `/api/repos/${REPOS.gitflow}/environments`);
  expect(envs.map((e) => [e.name, e.branch, e.target, e.release, e.gate])).toEqual([
    ["dev", "develop", "Cloudflare", null, "manual"], ["staging", "main", "Cloudflare", null, "manual"], ["production", "main", "Cloudflare", null, "manual · health /healthz"]]);
  if (!(await api("GET", "/api/repos/manual-empty-1"))) await api("POST", "/api/repos", { name: "manual-empty-1" });
  // A repo with no commit shows the empty-repo state instead of the page.
  expect(await render("/manual-empty-1/environments")).toMatch(/<h3>No environments yet<\/h3>.*Quick setup/);
}, 120000);

it("a full seed records no deploy sync and no release promotion", async () => {
  await full();
  const count = (sql) => env.DB.prepare(sql).bind(...FULL).first("n");
  const repos = FULL.map(() => "?").join(", ");
  expect(await count(`SELECT COUNT(*) AS n FROM deploy_syncs WHERE repo IN (${repos})`)).toBe(0);
}, 120000);

it("after the full seed each full repo has a change in draft", async () => {
  await full();
  for (const repo of FULL) expect((await api("GET", `/api/repos/${repo}/changes`)).some((c) => c.state === "draft"), repo).toBe(true);
}, 120000);

it("a full seed queues no develop job on any seed repo beyond the work section's claimed intents", async () => {
  await full();
  const ids = await Promise.all(FULL.map(async (r) => (await api("GET", `/api/repos/${r}`)).id));
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'develop' AND status = 'queued' AND repo_id IN (?, ?, ?) AND change_id NOT IN " +
    "(SELECT l.change_id FROM issue_links l JOIN issues i ON i.id = l.issue_id WHERE i.title IN (SELECT value FROM json_each(?)))").bind(...ids, JSON.stringify(INTENTS)).first();
  expect(n).toBe(0);
}, 120000);

// The two edit changes are a person's work (seedCode, seedCodePage), so they need no agent and no draft.
// A person's edit from Code, and the people section's changes from their own branches.
const EDITS = ["Cover the plans with an invalid account id", "Say why Create recomputes the total",
  ...Object.values(PEOPLE_EDITS).flatMap(([, edits]) => edits.slice(0, 3).map(([intent]) => intent))].sort();
it("every intent the full seed files is a draft, closed or a person's edit", async () => {
  await full();
  const changes = (await Promise.all(FULL.map((r) => api("GET", `/api/repos/${r}/changes`)))).flat();
  // The work section's claimed intents are agent work by design.
  expect(changes.filter((c) => !["draft", "closed"].includes(c.state) && !INTENTS.some((t) => c.intent.endsWith(t))).map((c) => c.intent).sort()).toEqual(EDITS);
}, 120000);

it("a full seed files no race beyond the work section's raced intent", async () => {
  await full();
  expect(await api("GET", "/api/races")).toHaveLength(1);
}, 120000);

// Only cinder (a flow or release approval) or a runner raises these; the seed plays neither.
it("a full seed raises no Needs you item", async () => {
  await full();
  expect(await api("GET", "/api/needs")).toEqual([]);
}, 120000);

it("a full seed reports no scan, finding or secret", async () => {
  await full();
  for (const repo of (await api("GET", "/api/repos")).map((r) => r.name)) {
    expect([await api("GET", `/api/repos/${repo}/watchtower/scans`), (await api("GET", `/api/repos/${repo}/watchtower`)).findings], repo).toEqual([[], []]);
  }
  expect(await api("GET", "/api/keystore")).toEqual({ secrets: [], wanted: [] });
}, 120000);

it("Flows: the full seed gives the page the storefront's deploy and ci flows and a deploy run in every state; the empty repo has none", async () => {
  await full();
  vi.stubGlobal("fetch", real);
  const g = `/${REPOS.gitflow}/flows`;
  const designer = await render(`${g}?view=designer&flow=deploy`);
  for (const f of ["deploy", "ci", 'class="dag-n t-command"']) expect(designer).toContain(f);
  expect(designer).not.toContain('class="dag-n t-deploy"');
  if (!(await api("GET", "/api/repos/manual-empty-1"))) await api("POST", "/api/repos", { name: "manual-empty-1" });
  expect(await render("/manual-empty-1/flows?view=designer")).toMatch(/<h3>No flows yet<\/h3>.*Quick setup/);
}, 120000);

it("Seed test: a reset then a full seed against the local Worker, run twice, succeeds both times", async () => {
  // Each reset empties D1, so every run makes its changes anew: more than the per-repo change limit allows in a minute.
  const unlimited = { limit: async () => ({ success: true }) };
  const e = { ...env, ARTIFACTS: fake, PIPELINE: { create: async () => ({}) }, ...cf.env, CINDER_ENV: "nonprod", CHANGE_LIMIT: unlimited };
  e.RESET = fakeReset(e);
  const nonprod = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: cf.through((url, init) => worker.fetch(signedIn(url, init), e)) });
  const run = () => seed(nonprod, commitRelease(nonprod), "all", commit, SEED_SOURCES, true);
  // A reset change gets a new id and cinder's own commit a new date; their states and authors are what must match.
  const state = async () => {
    const s = await snapshot();
    return { ...s, changes: s.changes.map(([, c]) => c), git: s.git.map((log) => log.replace(/^\w+ cinder \S+/gm, "cinder")) };
  };
  // The binding's list() pages, so the agents repo, made early, is past the newest page.
  fake.page = 1;
  try {
    await run();
    const first = await state();
    await run();
    expect(await state()).toEqual(first);
  } finally {
    fake.page = Infinity;
  }
}, 300000);

it("Worker test (seed): after a full seed there is an issue linked to a change, and a runbook with two versions and a comment", async () => {
  await full();
  expect((await api("GET", `/api/repos/${REPOS.trunk}/issues`)).some((i) => i.change)).toBe(true);
  const wiki = `/api/repos/${REPOS.trunk}/wiki/pages`;
  const runbook = (await api("GET", `/api/repos/${REPOS.trunk}/wiki/tree`)).find((p) => p.title === "Runbook");
  expect((await api("GET", `${wiki}/${runbook.id}/history`)).length).toBe(2);
  expect((await api("GET", `${wiki}/${runbook.id}/comments`)).length).toBeGreaterThan(0);
}, 120000);

it("Seed test: a full seed creates no topics, stars, pins or spotlight rows", async () => {
  const calls = [];
  const recording = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => (calls.push([new URL(url).pathname, init?.body ?? ""]), real(url, init)) });
  await seed(recording, commitRelease(recording), "all", commit, SEED_SOURCES);
  expect(calls.filter(([path, body]) => /^\/api\/(topics|explore)\b|\/(topics|star|like|cheer)$/.test(path) || body.includes('"visibility":"instance"'))).toEqual([]);
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('repo_topics', 'stars', 'topic_pins', 'topic_follows', 'topic_descriptions')").all();
  expect(results).toEqual([]);
}, 120000);

it("a full seed claims and reports no job", async () => {
  const paths = [];
  const counting = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => (paths.push(new URL(url).pathname), real(url, init)) });
  await seed(counting, commitRelease(counting), "all", commit, SEED_SOURCES);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.filter((p) => p === "/api/work/claim" || /^\/api\/work\/jobs\/[^/]+\/report$/.test(p))).toEqual([]);
}, 120000);

it("a full seed leaves the seed repos' queued jobs queued", async () => {
  await full();
  const ids = await Promise.all(FULL.map(async (r) => (await api("GET", `/api/repos/${r}`)).id));
  // The edit changes' commit jobs: the only work the seed queues on its repos.
  const { token } = await api("POST", "/api/runners", { name: "pool", kinds: ["commit"] });
  const claim = await api("POST", "/api/work/claim", { kinds: ["commit"], slots_free: 1 }, token);
  expect(ids).toContain(claim?.job.repo_id);
}, 120000);

it("a full seed pushes no commit naming a change", async () => {
  await full();
  for (const repo of FULL) expect(await repoGit(repo, "log", "--format=%B", "main"), repo).not.toContain("Cinder-Change:");
}, 120000);

it("every seeded review thread anchors on a line that exists in the seed repo's file", async () => {
  const threads = [];
  // Every repo's changes list answers with its verifying change, so seedReview posts each repo's threads.
  const api = async (method, path, body) => {
    const repo = /^\/api\/repos\/([^/]+)\/changes$/.exec(path)?.[1];
    if (repo) return { find: () => ({ id: repo, state: "verifying" }) };
    if (method === "POST" && path.endsWith("/threads")) threads.push([path.split("/")[3], body.path, body.line]);
    return method === "GET" ? [] : { id: "t" };
  };
  await seedReview(api);
  expect(new Set(threads.map(([repo]) => repo))).toEqual(new Set(FULL));
  for (const [repo, path, line] of threads) {
    const text = SEED_SOURCES[repo][path] ?? "";
    expect(text.split("\n")[line - 1]?.trim(), `${repo} ${path}:${line}`).toBeTruthy();
  }
});

it("the accounts section adds an organization with 3 accounts through the account routes", async () => {
  const posts = [];
  const recording = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => (init?.method === "POST" && posts.push(new URL(url).pathname), real(url, init)) });
  // An earlier full seed in this file may have added them; start from none.
  const ours = "SELECT id FROM accounts WHERE slug IN ('nimbus-edge-team', 'nimbus-edge-staging', 'nimbus-labs')";
  await env.DB.batch([`DELETE FROM account_members WHERE account_id IN (${ours})`, `DELETE FROM accounts WHERE id IN (${ours})`,
    "DELETE FROM organizations WHERE name = 'Nimbus Edge'"].map((q) => env.DB.prepare(q)));
  // A second run finds the accounts by slug and creates none.
  for (let i = 0; i < 2; i++) await seed(recording, commitRelease(recording), ["accounts"], commit, SEED_SOURCES);
  expect(posts.filter((p) => p === "/api/accounts")).toHaveLength(3);
  expect(posts.filter((p) => /^\/api\/accounts\/[^/]+\/members$/.test(p))).toHaveLength(12);
  const { results } = await env.DB.prepare("SELECT a.slug, a.cf_account_id, (SELECT count(*) FROM account_members WHERE account_id = a.id) AS members " +
    "FROM accounts a JOIN organizations o ON o.id = a.org_id WHERE o.name = 'Nimbus Edge' ORDER BY a.slug").all();
  expect(results).toEqual([
    { slug: "nimbus-edge-staging", cf_account_id: null, members: 2 },
    { slug: "nimbus-edge-team", cf_account_id: null, members: 2 },
    { slug: "nimbus-labs", cf_account_id: null, members: 2 },
  ]);
}, 120000);


it("a clean full seed fills the work board, wiki, flow runs, designer, workers and accounts with no empty screen", async () => {
  await full();
  const run = (await api("GET", `/api/repos/${CI.repo}/flow-runs`)).find((r) => r.flow === CI.flow);
  expect((await api("GET", `/api/repos/${CI.repo}/flow-runs/${run?.id}`)).stages.map((s) => s.name)).toEqual(["build", "test", "integration", "package", "staging", "release"]);
  vi.stubGlobal("fetch", pages);
  const empty = [];
  for (const path of [`/${REPOS.infra}/changes`, "/wiki", `/${CI.repo}/flows/runs/${run.id}`, `/${REPOS.gitflow}/flows?view=designer&flow=ci`, "/automation/workers"]) {
    const html = await render(path);
    const at = html.search(/class="state[ "]|empty-cell|aria-busy|^redirect/);
    if (at >= 0) empty.push(`${path}: ${html.slice(at, at + 120)}`);
  }
  expect(empty).toEqual([]);
  const { organization, accounts } = await api("GET", "/api/me/accounts");
  expect([organization?.name, accounts.filter((a) => a.slug?.startsWith("nimbus-") || a.name.startsWith("Nimbus")).length]).toEqual(["Nimbus Edge", 3]);
}, 120000);

it("the seed writes only through cinder's API routes (no direct D1 writes)", async () => {
  const writes = [];
  const recording = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => {
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${new URL(url).pathname}`);
    return real(url, init);
  } });
  await seed(recording, commitRelease(recording), "all", commit, SEED_SOURCES);
  const known = Object.keys(apiRoutes).map((r) => new RegExp(`^${r.replace(/:\w+/g, "[^/]+").replace(/\*/g, ".*")}$`));
  expect(writes.filter((w) => !known.some((re) => re.test(w)))).toEqual([]);
  // The CI run too: started through the run route (a re-run finds it and starts none).
  expect((await api("GET", `/api/repos/${CI.repo}/flow-runs`)).filter((r) => r.flow === CI.flow)).toHaveLength(1);
  // The seed scripts get only an API client: none of them reaches D1 or wrangler.
  const scripts = import.meta.glob("../../seed/*.mjs", { query: "?raw", import: "default", eager: true });
  expect(Object.keys(scripts).length).toBeGreaterThan(0);
  for (const [file, src] of Object.entries(scripts)) {
    expect(src, file).not.toMatch(/\.DB\b|\.prepare\(|wrangler d1|INSERT INTO|UPDATE \w+ SET/);
  }
}, 120000);
