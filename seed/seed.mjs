// Seeds demo data through cinder's real API: `CINDER_URL=... CINDER_TOKEN=<owner token> node seed/seed.mjs`.
// Idempotent: repos are looked up by name and changes by intent, so a re-run creates nothing new.
// Each page's seed task appends its own section to seed() using these helpers.


// Five placeholder people, created by seedAccess through POST /api/people with ROLES[i]; page sections use the ones with
// write roles as commit and change authors. syncPolicy adds every person to the Access policy, so they sit on a domain the owner owns.
export const PEOPLE = ["ana.ruiz@brinkercode.dev", "ben.okafor@brinkercode.dev", "chen.wu@brinkercode.dev", "dara.novak@brinkercode.dev", "emeka.obi@brinkercode.dev"];
export const ROLES = ["maintainer", "developer", "developer", "contributor", "viewer"];
const WRITERS = PEOPLE.filter((_, i) => ROLES[i] !== "viewer");
// The owner's email: the person cinder reports as owner. lazy: only listed once the owner has signed in (a reset empties
// people), so until then the seed leaves the owner out; upgrade if /api/me ever reports an email for the owner token.
const ownerOf = async (api) => (await api("GET", "/api/people")).find((p) => p.owner)?.email;

// The seed's three full repos, all from seed/repos, each with every feature: trunk a Go service on main, gitflow a
// TypeScript storefront on develop and main (release/*), infra a Terraform module on main.
export const REPOS = { trunk: "svc-orders-go", gitflow: "web-store", infra: "infra-cloudflare-tf" };
// The intent of the change the detail section (seedDetail) dresses as a change awaiting approval.
export const DETAIL = "Return 404 for an unknown order instead of an empty order";
// The code-page section's repo: the Terraform module with leases on its Worker and its tests.
export const CODE_REPOS = { code: REPOS.infra };

// The fields of web-store's .cinder.yml the gitflow sections target.
const GITFLOW = { integration: ["develop", "main"], release: ["release/*"] };

// Each seed repo's history, oldest first: its root config, then one commit per top-level folder (root sources count as
// src, tests anywhere as test; tests and flows last), each by the next person on a fixed date, so a re-run writes the same
// history. n spreads the repos' dates apart.
const ABOUT = { ".cinder": "build, test and deploy flows", app: "the application", lib: "the domain logic", src: "the source", templates: "the chart templates",
  migrations: "the D1 schema", public: "static assets", test: "tests", tests: "tests" };
const rank = (dir) => (!dir ? 0 : dir === ".cinder" ? 3 : dir.startsWith("test") ? 2 : 1);
const day = (n) => new Date(Date.UTC(2026, 6, 1) + n * 864e5).toISOString();
function history(name, files, n, authors) {
  const groups = Object.groupBy(Object.keys(files).sort(), (p) => (/(_test\.|\.test\.|^test_)/.test(p.split("/").at(-1)) ? "test"
    : p.includes("/") ? p.split("/")[0] : /\.(go|tf|ts|tsx|js|mjs|py|rs|cs)$/.test(p) ? "src" : ""));
  return Object.keys(groups).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((dir, i) => ({ author: authors[(n + i) % authors.length], dir,
    message: dir ? `Add ${ABOUT[dir] ?? dir}` : `Scaffold ${name}`, at: day(n * 3 + i * 2), files: Object.fromEntries(groups[dir].map((p) => [p, files[p]])) }));
}
// A repo whose .cinder.yml integrates develop is gitflow: develop, feature/*, release/* and the third tag.
const isGitflow = (files) => /integration: \[develop/.test(files[".cinder.yml"] ?? "");
const TAGS = [["v1.0.0", "First release"], ["v1.1.0", "Fixes and docs"], ["v1.2.0-rc.1", "Release candidate for 1.2"]];
// A gitflow repo's feature branch per folder of history().
const FEATURE = { src: "worker", test: "tests", ".cinder": "flows" };
// The gitflow repo's feature still in progress, never merged: a test for web-store's postcode gap, failing until it is closed.
const OPEN = { branch: "feature/postcodes-outside-the-us", message: "Test postcodes outside the US", files: { "lib/address/postcode.test.ts":
  'import { expect, it } from "vitest";\nimport { validatePostcode } from "./postcode";\n\nit("rejects a malformed UK postcode", () => {\n  expect(validatePostcode("GB", "12345")).toBe(false);\n});\n' } };
// The open gaps each repo's README or code names ("TODO: ..."), its backlog's features.
const todos = (files) => Object.values(files).flatMap((t) => [...t.matchAll(/TODO: (.+)$/gm)].map(([, gap]) => gap[0].toUpperCase() + gap.slice(1).replace(/\.$/, "")));
// The two feature branches the import opens, on a repo's first two open gaps, as [gap, branch].
const features = (files) => [...todos(files), "Document local development", "Add a contributing guide"].slice(0, 2)
  .map((gap) => [gap, `feature/${gap.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-$/, "")}`]);

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
// Retry-After is seconds or an HTTP date; null when absent or unreadable.
function retryAfter(value) {
  if (!value) return null;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isNaN(ms) ? null : Math.max(0, ms);
}

// accessId/accessSecret: a Cloudflare Access service token, needed when the deploy sits behind Access.
export function client({ url, token, accessId, accessSecret, fetch = globalThis.fetch }) {
  const access = accessId && accessSecret ? { "CF-Access-Client-Id": accessId, "CF-Access-Client-Secret": accessSecret } : {};
  // as: another bearer token for this call (a test runner's).
  return async (method, path, body, as = token) => {
    let res;
    // An imported repo answers 409 repo_importing until Artifacts finishes the import; back off and retry (~1 min).
    // A 429, a 5xx gateway/server error or a dropped connection is retried with backoff, 5 attempts in all.
    for (let wait = 250, backoff = 500, attempt = 1; ; ) {
      let failure;
      try {
        res = await fetch(`${url}${path}`, {
          method, headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...access },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
        });
      } catch (err) {
        failure = err;
      }
      if (!failure && res.status === 409 && wait <= 32000 && (await res.clone().json().catch(() => null))?.error?.code === "repo_importing") {
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait *= 2;
        continue;
      }
      if (!failure && !TRANSIENT.has(res.status)) break;
      // Only method, path, status and attempt: headers carry the bearer and Access tokens.
      const what = failure ? `network error (${failure.message})` : res.status;
      if (attempt === 5) throw new Error(`${method} ${path}: ${what} after ${attempt} attempts${failure ? "" : `: ${await res.text()}`}`);
      console.error(`seed: ${method} ${path}: ${what}, attempt ${attempt} of 5, retrying`);
      const after = (res?.status === 429 || res?.status === 503) && !failure ? retryAfter(res.headers.get("Retry-After")) : null;
      await new Promise((resolve) => setTimeout(resolve, after ?? backoff));
      backoff = Math.min(backoff * 2, 8000);
      attempt++;
    }
    if (res.status >= 300 && res.status < 400 && (res.headers.get("Location") ?? "").includes("cloudflareaccess.com")) {
      throw new Error(`${method} ${path}: blocked by Cloudflare Access; set CINDER_ACCESS_CLIENT_ID and CINDER_ACCESS_CLIENT_SECRET`);
    }
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    // A 202 can come with no body (Scan now), like a 204.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

// source: {url, branch?} imports an existing repo instead of creating an empty one; an existing repo with no commits on
// source.branch (one an older seed created empty, say) is re-imported. policy: the branch policy fields a section needs;
// an existing repo that differs gets them committed as .cinder.yml.
export async function ensureRepo(api, name, source, policy) {
  let repo = await api("GET", `/api/repos/${name}`);
  if (!repo) repo = await api("POST", "/api/repos", { name, import: source });
  else if (source && !(await api("GET", `/api/repos/${name}/log?ref=${source.branch}`))) repo = await api("POST", `/api/repos/${name}/import`, source);
  if (!policy) return repo;
  const now = await api("GET", `/api/repos/${name}/policy`);
  if (Object.keys(policy).some((k) => JSON.stringify(now[k]) !== JSON.stringify(policy[k]))) await api("PUT", `/api/repos/${name}/policy`, policy);
  return repo;
}

// spec: { intent, target?, closed?, author? }. Filed as a draft, so the seed queues no agent work: a person marks it
// ready. A re-run finishes whatever an interrupted run left half done.
export async function ensureChange(api, repo, { intent, target, closed = false, author }) {
  const changes = await api("GET", `/api/repos/${repo}/changes`);
  let change = changes.find((c) => c.intent === intent) ?? await api("POST", `/api/repos/${repo}/changes`, { intent, target_branch: target, author, draft: true });
  if (closed && change.state !== "closed") change = await api("POST", `/api/changes/${change.id}/close`);
  return change;
}

// Imports each repo of sources ({name: {path: text}}, seed/repos) through the seed route (commit). A trunk repo gets its
// history() on a linear main (tagged v1.0.0 and v1.1.0) and two feature branches on its open gaps. A gitflow repo gets the
// scaffold on main (v1.0.0), each folder on its own feature branch merged into develop, release/1.1 merged into main
// (v1.1.0) and back into develop, release/1.2 (v1.2.0-rc.1) and OPEN, unmerged. A repo with commits on main is left as it is.
// lazy: an import interrupted part way is not finished by a re-run; delete the repo to redo it.
export async function seedLibrary(api, commit, sources) {
  const owner = await ownerOf(api);
  const authors = owner ? [owner, ...WRITERS] : WRITERS;
  for (const [n, [name, files]] of Object.entries(sources).entries()) {
    const gitflow = isGitflow(files);
    if (!(await api("GET", `/api/repos/${name}`))) await api("POST", "/api/repos", { name, default_branch: gitflow ? "develop" : "main" });
    if (await api("GET", `/api/repos/${name}/log?ref=main`)) continue;
    const by = (i) => authors[(n + i) % authors.length];
    const main = history(name, files, n, authors);
    if (gitflow) {
      let k = 0;
      const next = (c) => ({ ...c, author: by(k), at: day(n * 3 + k++) });
      const write = (branch, from, c) => commit({ repo: name, branch, from, commits: [next(c)] });
      // develop starts from main with its first merge.
      const merge = (from, into, files, tag) => write(into, "main", { message: `Merge ${from} into ${into}`, merge: from, files, tag });
      const bump = (version) => ({ "package.json": files["package.json"].replace(/("name": .+,\n)/, `$1  "version": "${version}",\n`) });
      const [scaffold, ...work] = main;
      await write("main", undefined, { message: scaffold.message, files: scaffold.files, tag: TAGS[0][0] });
      for (const [i, { dir, message, files: added }] of work.entries()) {
        const branch = `feature/${FEATURE[dir] ?? dir}`;
        await write(branch, i ? "develop" : "main", { message, files: added });
        await merge(branch, "develop", added);
      }
      await write("release/1.1", "develop", { message: "Bump the version to 1.1.0", files: bump("1.1.0") });
      await merge("release/1.1", "main", { ...files, ...bump("1.1.0") }, TAGS[1][0]);
      await merge("release/1.1", "develop", bump("1.1.0"));
      await write("release/1.2", "develop", { message: "Bump the version to 1.2.0-rc.1", files: bump("1.2.0-rc.1"), tag: TAGS[2][0] });
      await write(OPEN.branch, "develop", OPEN);
      continue;
    }
    main.at(-2).tag = TAGS[0][0];
    main.at(-1).tag = TAGS[1][0];
    await commit({ repo: name, branch: "main", commits: main });
    for (const [k, [gap, branch]] of features(files).entries()) {
      await commit({ repo: name, branch, from: "main", commits: [
        { author: by(3 + k), message: `WIP: ${gap}`, at: day(n * 3 + main.length * 2 + k), files: { "README.md": `${files["README.md"] ?? `# ${name}\n`}\n## In progress\n\n- ${gap}\n` } },
        { author: by(4 + k), message: `Test: ${gap}`, at: day(n * 3 + main.length * 2 + 2 + k), files: { "NOTES.md": `# In progress\n\n${gap}: the change and its tests.\n` } }] });
    }
  }
}

// Releases (/:repo/releases) for each repo's tags: the release candidate a draft, the others published. Deploys come
// only from seed/activity.mjs.
async function seedReleases(api, sources) {
  for (const name of Object.keys(sources)) {
    const have = (await api("GET", `/api/repos/${name}/releases`)).map((r) => r.tag);
    for (const [tag, notes] of TAGS.filter(([t]) => !have.includes(t) && (isGitflow(sources[name]) || !t.includes("-rc")))) {
      // A tag the import just pushed can take a moment to show in the repo's refs on a fresh install: wait for it (~1 min at most).
      for (let wait = 250; !(await api("GET", `/api/repos/${name}/tags`)).some((t) => t.name === tag) && wait <= 16000; wait *= 2) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      await api("POST", `/api/repos/${name}/releases`, { tag, title: `${name} ${tag}`, notes, draft: tag.includes("-rc") });
    }
  }
}

// The develop and release changes, and a stack waiting on a shared lease, on the policy web-store's .cinder.yml sets.
async function seedGitflow(api) {
  await ensureChange(api, REPOS.gitflow, { intent: "Split shipping and billing address forms", target: "develop" });
  await ensureChange(api, REPOS.gitflow, { intent: "Fix tax rounding on the 1.2 release", target: "release/1.2" });
  // Both intents name applyDiscount: once a pool has indexed develop, the second waits, stacked on the first.
  await ensureChange(api, REPOS.gitflow, { intent: "Apply discount codes before tax", target: "develop" });
  await ensureChange(api, REPOS.gitflow, { intent: "Cap stacked discount codes at two per order", target: "develop" });
  // Leases page: a lease no other change wants, beside the contested applyDiscount.
  await ensureChange(api, REPOS.gitflow, { intent: "Validate postcodes on the address form", target: "develop" });
  // Seam: both intents share a term with the exported paymentMethods ("methods"), so with develop indexed the scheduler starts a seam change for it.
  await ensureChange(api, REPOS.gitflow, { intent: "Accept PayPal, one of the methods", target: "develop" });
  await ensureChange(api, REPOS.gitflow, { intent: "Accept bank transfers, one of the methods", target: "develop" });
}

// Workers AI coding models, best first: they run on the account's Workers AI, so no one needs a personal key. A Worker
// without a Cloudflare token can't read Cloudflare's catalog, so the seed uses these ids as they are. Only the first two
// call tools and write files through opencode, so every seeded version uses index 0 or 1.
const WORKERS_AI = ["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b", "@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/meta/llama-4-scout-17b-16e-instruct"];
// The catalog's Workers AI models (GET /api/models/catalog), WORKERS_AI's first in their order; WORKERS_AI without a catalog.
async function catalogModels(api) {
  const catalog = await api("GET", "/api/models/catalog").catch((e) => { if (!e.message.includes(" 502 ")) throw e; });
  const hosted = (catalog ?? []).filter((m) => m.hosted).map((m) => m.id);
  if (!hosted.length) return WORKERS_AI;
  return [...WORKERS_AI.filter((id) => hosted.includes(id)), ...hosted.filter((id) => !WORKERS_AI.includes(id))];
}
// The judges every repo runs (DEFAULT_JUDGES in worker/src/repos.js), each with a minimum confidence, on the Workers AI judge
// models (CLEF_MODELS in worker/src/s1/client.js): the catalog's @cf ids aren't the pinned name@version a judge needs.
const JUDGES = { lease: ["clef-flash", "clef-flash@2", 0.7], collision: ["clef-flash", "clef-flash@2", 0.7], seam: ["clef-flash", "clef-flash@2", 0.7],
  split: ["clef-flash", "clef-flash@2", 0.7], guard: ["clef-flash", "clef-flash@2", 0.6], risk: ["clef", "clef@2", 0.6], flake: ["clef", "clef@2", 0.6],
  resembles_vuln: ["clef", "clef@2", 0.7] };
// Through PUT /api/repos/:name/judges/:kind, which is idempotent: a re-run keeps each judge and its airlock as they are.
// A seeded repo's trust floor: its judges are trusted from 20 outcomes, so shadow scoring earns trust within a demo
// (the Worker's default is 200). min_races keeps the default.
export const TRUST = { min_outcomes: 20, min_races: 30 };
async function seedJudges(api) {
  for (const name of Object.values(REPOS)) {
    await api("PUT", `/api/repos/${name}/settings`, { trust: TRUST });
    for (const [kind, [backend, model_version, min_confidence]] of Object.entries(JUDGES)) {
      await api("PUT", `/api/repos/${name}/judges/${kind}`, { backend, model_version, min_confidence });
    }
  }
}

// The Worker's DEFAULT_EGRESS (worker/src/agents.js), which a draft without egress gets.
const EGRESS = ["registry.npmjs.org", "proxy.golang.org", "sum.golang.org", "pkg.go.dev", "developer.mozilla.org", "developers.cloudflare.com"];

// Releases through the commit API: the prompt committed on a new branch for the version, tagged agent/<name>/vN with the
// lock as the message, which records the version. lazy: one branch per seeded version; fine for a demo instance.
export const commitRelease = (api) => ({ lock, prompt }) => api("POST", "/api/repos/cinder-agents/commits", {
  branch: `releases/${lock.name}/v${lock.version}`, base_sha: null, message: JSON.stringify(lock, null, 2), tag: `agent/${lock.name}/v${lock.version}`,
  changes: [{ path: `agents/${lock.name}/prompt.md`, content: prompt }],
});

// Agents: only the four the platform runs. developer takes develop jobs (baked-in v1, stable v2, a canary v3 on a share of
// changes that adds the fetch tool and more docs hosts), reviewer review jobs, resolver resolve jobs (each stable v2), and
// dev-open, the smaller model the demo's A/B race puts against developer. Every version reads the web as Markdown.
const LIMITS = { max_cost_usd: 8, max_minutes: 120 };
// The reading rules every prompt shares: egress converts allowed pages to Markdown, so primary docs are cheap to read.
const DOCS = `## Reading documentation

Your web requests leave through cinder's egress. For a host on your allowlist it asks for \`text/markdown\` first, and
converts an HTML answer to Markdown before you see it, so a docs page arrives as clean headings, code blocks and tables
without navigation or scripts.

- Check an API you are not certain of against its primary docs before you use it: developer.mozilla.org for Web
  APIs, pkg.go.dev for Go packages, developers.cloudflare.com for Workers, D1, R2 and Queues. Don't guess a signature.
- Fetch the one page you need, with \`curl -s <url>\` or your fetch tool, and read only the section that answers you.
- Quote only the lines you rely on, and name the URL in your report.
- A denied host means the version's allowlist doesn't include it. Note it in the report and work from what you
  have; never route around it through another host, a mirror or a cached copy.
`;
const DEVELOP = `# developer

You are cinder's developer. You take one change: its intent, its acceptance items when the intent has them, and the
symbols it leases on the target branch. You work on the change's fork branch, already checked out in the current
directory. Meet the intent with the smallest change that works and a test that proves it.

## Before you write

1. Read the intent twice. Its words are the whole job: nothing it doesn't ask for goes in.
2. Read the files that hold your leased symbols, their direct callers and the tests beside them. Stop when you can
   name every file you will change and the test that proves each part of the intent.
3. Find how this repo runs its tests (package.json scripts, Makefile, go.mod) and run them once before editing.

## Rules

- Change only what your lease covers. Another change may hold the symbol next to yours; touching it raises a collision.
- Reuse what the repo has before you add. No new dependency, no option or abstraction the intent doesn't use.
- Never weaken, skip or delete a test to get green. A failing test you can't fix is a blocker.
- Never write secrets, tokens or real-looking keys, in code or in test fixtures. The push guard quarantines them.
- Commit on the fork branch with a message that says what changed and why, in the repo's style.

${DOCS}
## Report

End with: what you changed and why, file by file; the test command you ran and its result; the docs URLs you relied on;
and any blocker with what you tried.
`;
const AGENTS = {
  developer: [
    { model: 0, effort: "medium", tools: ["bash", "edit", "git"], prompt: DEVELOP },
    { model: 0, effort: "high", tools: ["bash", "edit", "git", "net.fetch"], egress: [...EGRESS, "nodejs.org", "go.dev", "vitest.dev"],
      limits: { max_cost_usd: 12, max_minutes: 120 },
      prompt: `${DEVELOP}\nWhen a test fails, read the failure, fetch the docs for the API at fault, and name the failing test and the docs URL in the report.\n` },
  ],
  "dev-open": [{ model: 1, effort: "high", tools: ["bash", "edit", "git"], prompt: `# dev-open

You are cinder's developer on a smaller open model. Same job as developer: one change, one intent, the smallest
change that works and a test that proves it. Work in short, explicit steps and use one tool per step.

1. Run \`git status\` and \`ls\`, then read the files that hold your leased symbols with \`cat\`.
2. Find the test command (package.json scripts, Makefile, go.mod) and run it once.
3. Make one edit at a time with the edit tool. After each edit, run the tests.
4. When the tests pass, \`git add\` the files you changed and \`git commit\` with a message that says why.

Rules: change only leased symbols; never add a dependency; never weaken or skip a test; never write real-looking keys.

${DOCS}
## Report

List the files you changed, the test command and its result, the docs URLs you used, and any blocker.
` }],
  reviewer: [{ model: 0, effort: "medium", tools: ["bash", "git"], prompt: `# reviewer

You are cinder's reviewer. You get one change's diff against its target, its intent and its verify results. Decide
whether the diff does what the intent asks, nothing more, and proves it.

## What to check

1. **Intent.** Every part of the intent is met, and nothing the intent didn't ask for is in the diff.
2. **Tests.** Each behaviour the intent names has a test that fails without the change. Run them:
   \`git diff --stat origin/<target>...HEAD\`, then the repo's own test command.
3. **Edges.** Empty input, missing values, a second concurrent caller, a timeout. Name the branch no test covers.
4. **API use.** Where the diff calls a platform API in a way you are not sure of, check the docs. Say what they say.
5. **Safety.** No secrets, no weakened validation, no disabled check, no new dependency.

${DOCS}
## Report

Give a verdict: approve, or request changes. Each blocker gets a file and line, what is wrong, and a command that
reproduces it. Suggestions that aren't blockers are marked as such. Cite the docs URL behind any API claim.
` }],
  resolver: [{ model: 0, effort: "high", tools: ["bash", "edit", "git"], prompt: `# resolver

You are cinder's resolver. A change fell behind its target and git couldn't merge it: another change landed on the
same lines first. You get both intents and the conflicted files, with the target merged in and the conflict markers
in place on the change's fork branch.

## How to resolve

1. Read both intents. A resolution keeps what each one asked for; neither side simply wins.
2. For each conflicted hunk, read the target's side, the change's side and the code around them, then write the
   version that does both. When they can't both hold, keep the target's and report the conflict as a blocker.
3. Remove every conflict marker. \`git diff --check\` must be clean.
4. Run the repo's tests. Both changes' tests must pass.
5. Commit the merge on the fork branch.

Never drop a test from either side, and never resolve by reverting the change.

${DOCS}
## Report

For each hunk: the file, what each side wanted, and what you kept. Then the test command and its result.
` }],
};
// What the Agents page shows each one doing.
const AGENT_ROLES = { developer: "develop", "dev-open": "open-model develop", reviewer: "review", resolver: "resolve conflicts" };
// developer's canary takes 20% of new changes; the others run their stable.
const CHANNELS = { developer: { stable: 2, canary: [3, 20] }, "dev-open": { stable: 1 }, reviewer: { stable: 2 }, resolver: { stable: 2 } };
// The baked-in agents' v1 exists before the seed runs, so their drafts start at v2.
const BAKED = ["developer", "reviewer", "resolver"];

// Releases each version not yet recorded with push({lock, prompt}) (commitRelease, or a test's push event), then points
// the channels and sets each agent's role.
export async function seedAgents(api, push) {
  await api("GET", "/api/agents");
  const models = await catalogModels(api);
  for (const [name, drafts] of Object.entries(AGENTS)) {
    const recorded = (await api("GET", `/api/agents/${name}`))?.versions.length ?? 0;
    for (const [i, d] of drafts.entries()) {
      const version = (BAKED.includes(name) ? 2 : 1) + i;
      if (version <= recorded) continue;
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(d.prompt)));
      const lock = { name, version, harness: "opencode", model: models[d.model], effort: d.effort, prompt_hash: `sha256:${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        tools: d.tools, limits: d.limits ?? LIMITS, egress: d.egress ?? EGRESS, web: "markdown" };
      await push({ lock, prompt: d.prompt });
    }
    const { stable, canary } = CHANNELS[name];
    await api("PUT", `/api/agents/${name}/channels/stable`, { version: stable });
    if (canary) await api("PUT", `/api/agents/${name}/channels/canary`, { version: canary[0], share: canary[1] });
    await api("PUT", `/api/agents/${name}/role`, { role: AGENT_ROLES[name] });
  }
}

// Code: svc-orders-go's orders.go on main as the library import wrote it, "Cancel open orders" filed for an agent and the
// owner's edit to Create, which leases it, so the file shows a lease rail. Authorship comes from a runner's blame job.
// The edit keeps Create's behaviour, so the change's check flow passes. CODE_EDIT: [intent, find, replace] on orders.go.
const ORDERS = "orders.go";
export const CODE_EDIT = ["Say why Create recomputes the total", "\to.Total = 0\n", "\t// A total the client sent is ignored: the server prices every item.\n\to.Total = 0\n"];
export async function seedCode(api) {
  const repo = REPOS.trunk;
  await ensureChange(api, repo, { intent: "Cancel open orders" });
  const [intent, find, replace] = CODE_EDIT;
  if ((await api("GET", `/api/repos/${repo}/changes`)).some((c) => c.intent === intent)) return;
  const file = await api("GET", `/api/repos/${repo}/file?ref=main&path=${ORDERS}`);
  // Nothing to build on before the library import.
  if (!file?.content) return;
  await api("POST", `/api/repos/${repo}/changes/edit`, { target: "main", path: ORDERS, base_sha: file.sha,
    content: file.content.replace(find, replace), intent });
}

// The changes boards' intents, per repo, filed as drafts: once a person marks them ready, detail waits for a person once
// verified (seedDetail), verifying is the one seedReview reviews; closed is closed as filed.
const SCENES = {
  [REPOS.trunk]: { detail: DETAIL, developing: "Paginate GET /orders with limit and after", verifying: "Reject orders with a non-positive quantity",
    closed: "Drop the unused /v0/orders route", merged: "Cancel open orders", gaveUp: "Shard the store by customer",
    behind: ["Return Retry-After when the store is locked", "Expose order counts as a metric"],
    requeued: "Cap order request bodies at 64 KiB", conflict: "Keep orders in a slice sorted by id", resolving: "Add a /healthz endpoint", converging: "Log request latency per route" },
  [REPOS.gitflow]: { detail: "Show stock levels on the product page", developing: "Lazy-load product images", verifying: "Cap cart quantities at the product's stock",
    closed: "Rename cart total helper", merged: "Remember the last shipping country", gaveUp: "Move the cart into server state", behind: ["Add a sitemap"] },
  [REPOS.infra]: { detail: "Require Terraform 1.9 or later", developing: "Add a KV namespace for sessions", verifying: "Validate the account id format",
    closed: "Drop the unused R2 bucket output", merged: "Output the Worker's workers.dev URL", gaveUp: "Split the module per environment", behind: ["Tag resources with the environment"] },
};
async function seedChanges(api) {
  for (const [repo, intents] of Object.entries(SCENES)) {
    const get = (role, more) => intents[role] && ensureChange(api, repo, { intent: intents[role], ...more });
    // With auto-queue off, a verified detail change waits, unqueued, for a person.
    const detail = await get("detail");
    if (detail.state === "leased") await api("PATCH", `/api/changes/${detail.id}/auto_queue`, { auto_queue: false });
    await get("developing");
    await get("verifying");
    await get("closed", { closed: true });
    for (const role of ["merged", "requeued", "conflict", "resolving", "converging", "gaveUp"]) await get(role);
    for (const intent of intents.behind) await ensureChange(api, repo, { intent });
  }
  await ensureChange(api, REPOS.gitflow, { intent: "Add Apple Pay to the checkout form" });
  await ensureChange(api, REPOS.gitflow, { intent: "Show saved cards first in the payment picker" });
}

// Per repo: a base and a change stacked on it (both name one symbol, once a pool has indexed the target), one its reviewer sends back with that
// review, a fresh one and another draft.
const STATES = {
  [REPOS.gitflow]: ["Show the order total with tax", "Round the total to whole cents", "Trim spaces from coupon codes", "Codes are case-insensitive too; fold case before the lookup.",
    "Add a gift message field", "Offer saved cards at checkout"],
  [REPOS.trunk]: ["Validate item SKUs against the catalogue", "Validate that every order names a customer", "Trim spaces from customer names",
    "Names can carry tabs too; strip every kind of whitespace.", "Add a notes field to each order", "Accept a coupon code with each order"],
  [REPOS.infra]: ["Bump the compatibility date to 2026-10-15", "Read the compatibility date from a tfvars file", "Tag the R2 bucket with its environment",
    "Name the environment in the tag key too.", "Add a D1 read replica", "Add a route for the script"],
};

// Changes board (/:repo/changes) and Access (/settings/access), on every repo: a base the owner closes, a change its
// reviewer sends back once a pool has taken it to verifying, a fresh one and a draft never marked ready.
async function seedStates(api) {
  for (const [repo, [baseIntent, stacked, fixIntent, review, fresh, draft]] of Object.entries(STATES)) {
    const base = await ensureChange(api, repo, { intent: baseIntent });
    await ensureChange(api, repo, { intent: stacked });
    const fix = await ensureChange(api, repo, { intent: fixIntent, author: PEOPLE[1] });
    if (base.state !== "closed") await api("POST", `/api/changes/${base.id}/close`);
    if (fix.state === "verifying") await api("POST", `/api/changes/${fix.id}/review`, { verdict: "request_changes", body: review });
    await ensureChange(api, repo, { intent: fresh });
    await ensureChange(api, repo, { intent: draft });
  }
}

// Change detail's review tab (/:repo/changes/:id) and a Needs you review item (/needs), on each repo's verifying change
// once a pool has taken it there (skipped until then):
// a person and an agent version asked to review, a thread with a reply, a resolved one and a suggestion, as [path, line,
// question, reply, resolved, suggestion]. Old-side anchors sit on main's code, so they need no change head (the seed pushes no forks).
const REVIEWS = {
  [REPOS.trunk]: [ORDERS, 86, "Does a zero price still pass? Free samples ship at 0.", "Yes: only a negative price is rejected.", "Name the bad item in the error.",
    "Split the checks so the error says which one failed:\n\n```suggestion\n\t\tif it.Quantity <= 0 {\n\t\t\treturn errors.New(it.SKU + \": quantity must be positive\")\n\t\t}\n```"],
  [REPOS.gitflow]: ["lib/cart.ts", 19, "Does a product with no stock field still add?", "No: products.ts sets stock on every product.", "Say why sold-out items are ignored.",
    "Cap at stock in the same return:\n\n```suggestion\n  return { ...cart, [id]: Math.min((cart[id] ?? 0) + 1, product.stock) };\n```"],
  [REPOS.infra]: ["variables.tf", 1, "Is the id ever upper case?", "No: Cloudflare account ids are lower-case hex.", "Describe the expected format.",
    "Check the format here:\n\n```suggestion\nvariable \"account_id\" {\n  description = \"Cloudflare account id: 32 lower-case hex characters.\"\n```"],
};
export async function seedReview(api) {
  const owner = await ownerOf(api) ?? "owner";
  for (const [repo, [path, line, question, reply, resolved, suggestion]] of Object.entries(REVIEWS)) {
    const change = (await api("GET", `/api/repos/${repo}/changes`)).find((c) => c.intent === SCENES[repo].verifying);
    if (change?.state !== "verifying" || (await api("GET", `/api/changes/${change.id}/threads`)).length) continue;
    const at = `/api/changes/${change.id}`;
    await api("POST", `${at}/reviewers`, { person: owner });
    await api("POST", `${at}/reviewers`, { person: PEOPLE[0] });
    await api("POST", `${at}/reviewers`, { agent_version: "reviewer@v2" });
    const thread = (body, n) => api("POST", `${at}/threads`, { body, path, side: "old", line: n });
    await api("POST", `${at}/threads/${(await thread(question, line)).id}/comments`, { body: reply });
    await api("POST", `${at}/threads/${(await thread(resolved, line + 1)).id}/resolve`);
    await thread(suggestion, line);
  }
}

// Change detail (/:repo/changes/:id): the owner's review requested on each repo's verified, unqueued change, once a pool
// has taken it to verifying (skipped until then).
async function seedDetail(api) {
  for (const [repo, { detail }] of Object.entries(SCENES)) {
    const c = (await api("GET", `/api/repos/${repo}/changes`)).find((x) => x.intent === detail);
    if (c?.state === "verifying") await api("POST", `/api/changes/${c.id}/reviewers`, { person: "owner" });
  }
}

// Code (/:repo/code): the Terraform module's history (the library import) and two leases: an agent's on the
// Worker and one a person drives (taken over) on the plan test.
// The person's change starts as their edit to the plan test, so it leases the run it touches whatever the lease judge predicts.
const PLAN = "tests/plan.tftest.hcl";
const PLAN_ASSERT = `  assert {\n    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))\n    error_message = "the account id is 32 lower-case hex characters"\n  }\n`;
export async function seedCodePage(api) {
  const repo = CODE_REPOS.code;
  if (!(await api("GET", `/api/repos/${repo}/tree?ref=main`))?.entries?.length) return;
  const intent = "Cover the plans with an invalid account id";
  let person = (await api("GET", `/api/repos/${repo}/changes`)).find((c) => c.intent === intent);
  if (!person) {
    const { sha, content } = await api("GET", `/api/repos/${repo}/file?ref=main&path=${PLAN}`);
    // Inside run "plans_worker_assets_and_d1": its last assert's closing brace, then the new assert.
    const edited = content.replace('"the Worker binds D1 as DB and its static assets as ASSETS"\n  }\n', (m) => m + PLAN_ASSERT);
    person = await api("POST", `/api/repos/${repo}/changes/edit`, { target: "main", path: PLAN, base_sha: sha, content: edited, intent });
  }
  if (!person.driver) await api("POST", `/api/changes/${person.id}/takeover`);
  await ensureChange(api, repo, { intent: "Bind a KV namespace to the edge script" });
}

// Change detail and collisions (/:repo/changes/:id, /:repo/changes/collisions): per repo, three people (WRITERS) each
// commit an edit of the same lines of path to their own branch off the target (commit: the seed route, so the commit is
// theirs), so each pair is a real merge conflict, and open a change from it, so they drive it and it verifies on their
// commit. Auto-queue is off, so a verified change waits for a person. Once a pool has verified them, the first leases the
// symbol and cinder records the other two as collisions; the run (after waiting up to CINDER_PEOPLE_WAIT_MS for them)
// hands the symbol to the last of them in conflict and pushes its follow-up edit through the commits API (a person's
// push, which re-verifies), so it doesn't wait for an agent. Any other collision stays open.
// Each entry is [message, find, replace] on path; the fourth is the follow-up.
export const PEOPLE_EDITS = {
  [REPOS.trunk]: ["orders.go", [
    ["Skip the map delete for an unknown order id", "\t_, ok := s.orders[id]\n\tdelete(s.orders, id)\n\treturn ok\n",
      "\tif _, ok := s.orders[id]; !ok {\n\t\treturn false\n\t}\n\tdelete(s.orders, id)\n\treturn true\n"],
    ["Delete an order only when it exists", "\tdelete(s.orders, id)\n\treturn ok\n", "\tif ok {\n\t\tdelete(s.orders, id)\n\t}\n\treturn ok\n"],
    ["Say what Delete does with a missing id", "\t_, ok := s.orders[id]\n", "\t// A missing id is not an error: the caller gets false.\n\t_, ok := s.orders[id]\n"],
    ["Say why Delete holds the lock throughout", "func (s *Store) Delete(id int) bool {\n",
      "func (s *Store) Delete(id int) bool {\n\t// Held across the lookup and the delete, so both see the same order.\n"],
  ]],
  [REPOS.gitflow]: ["lib/cart.ts", [
    ["Stop adding a product past its stock", "[id]: (cart[id] ?? 0) + 1 }", "[id]: Math.min((cart[id] ?? 0) + 1, product.stock) }"],
    ["Treat negative stock as sold out", "product.stock === 0) return cart;", "product.stock <= 0) return cart;"],
    ["Cap a product at 10 in the cart", "[id]: (cart[id] ?? 0) + 1 }", "[id]: Math.min((cart[id] ?? 0) + 1, 10) }"],
    ["Say addToCart returns a new cart", "export function addToCart(", "// Returns a new cart; the one passed in is left as it was.\nexport function addToCart("],
  ]],
  [REPOS.infra]: ["variables.tf", [
    ["Allow Worker names up to 63 characters", "{1,40}$\", var.name))\n    error_message = \"name must be 1-40", "{1,63}$\", var.name))\n    error_message = \"name must be 1-63"],
    ["Allow underscores in Worker names", "[a-z0-9-]{1,40}$\", var.name))\n    error_message = \"name must be 1-40 lowercase letters, digits or hyphens.",
      "[a-z0-9_-]{1,40}$\", var.name))\n    error_message = \"name must be 1-40 lowercase letters, digits, hyphens or underscores."],
    ["Require Worker names to start with a letter", "\"^[a-z0-9-]{1,40}$\"", "\"^[a-z][a-z0-9-]{0,39}$\""],
    ["Say the account id is the Worker's account", "\"Cloudflare account that owns", "\"Cloudflare account id of the account that owns"],
  ]],
};
export async function seedPeople(api, commit) {
  for (const [repo, [path, edits]] of Object.entries(PEOPLE_EDITS)) {
    const target = (await api("GET", `/api/repos/${repo}`))?.default_branch;
    const base = target && await api("GET", `/api/repos/${repo}/file?ref=${target}&path=${path}`);
    // Nothing to edit before the library import.
    if (!base?.content) continue;
    const changes = await api("GET", `/api/repos/${repo}/changes`);
    const mine = [];
    for (const [i, [intent, find, replace]] of edits.slice(0, 3).entries()) {
      let change = changes.find((c) => c.intent === intent);
      if (!change) {
        const branch = `people/${intent.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        await commit({ repo, branch, from: target, commits: [{ author: WRITERS[i], message: intent, at: day(90 + i), files: { [path]: base.content.replace(find, replace) } }] });
        change = await api("POST", `/api/repos/${repo}/changes`, { intent, target_branch: target, head_branch: branch, author: WRITERS[i] });
      }
      await api("PATCH", `/api/changes/${change.id}/auto_queue`, { auto_queue: false });
      mine.push(change.id);
    }
    // Live, a pool verifies them within minutes, so this run settles the collision instead of the next run hours later
    // (the gap would be its time to resolve). Tests drive verify themselves and wait 0.
    const ours = async () => (await api("GET", `/api/repos/${repo}/collisions`)).feed.filter((f) => mine.includes(f.ours));
    let feed = await ours();
    for (const until = Date.now() + Number(globalThis.process?.env?.CINDER_PEOPLE_WAIT_MS ?? 0); !feed.length && Date.now() < until; feed = await ours()) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    const open = mine.filter((id) => feed.some((f) => f.ours === id && !f.resolution));
    let handed = feed.find((f) => f.resolution === "handover")?.ours;
    // Not only once two of them collide: a change can collide on several symbols, or only one of them collide.
    // Only a change still in conflict can be handed over; one that moved on (a later push re-verified it) is skipped.
    for (const id of handed ? [] : open.toReversed()) {
      if ((await api("GET", `/api/changes/${id}`))?.state !== "conflict") continue;
      await api("POST", `/api/changes/${id}/collisions/resolve`, { action: "handover" });
      handed = id;
      break;
    }
    // Resolved, the change is planned or leased for an agent; its person's follow-up push makes it verify again instead.
    // The commit names its change (Cinder-Change), so the code page links it.
    const change = handed && await api("GET", `/api/changes/${handed}`);
    if (["planned", "leased"].includes(change?.state)) {
      const [message, find, replace] = edits[3];
      const file = await api("GET", `/api/repos/${repo}/file?ref=${change.head_branch}&path=${path}&sha=${change.head}`);
      await api("POST", `/api/repos/${repo}/commits`, { branch: change.head_branch, base_sha: change.head, message: `${message}\n\nCinder-Change: ${handed}`,
        changes: [{ path, content: file.content.replace(find, replace) }] });
    }
    // Verified, the first change waits on its untrusted risk judge: the owner approves it over the judge, which queues it, so a
    // pool merges it. Once the handed-over change verifies again, the owner's verdict goes against the risk judge's, which
    // raises Judges disagree; its own Untrusted judge item stays.
    const needs = (await api("GET", "/api/needs")).filter((n) => mine.includes(n.change));
    const untrusted = needs.find((n) => n.change === mine[0] && n.kind === "Untrusted judge");
    if (untrusted) {
      await api("POST", `/api/needs/${untrusted.id}/resolve`, { action: "Approve change" });
    }
    const again = handed && await api("GET", `/api/changes/${handed}`);
    if (again?.state === "verifying" && again.review?.p != null && !needs.some((n) => n.change === handed && n.kind === "Judges disagree")) {
      const risky = again.review.reason.includes("risk high");
      await api("POST", `/api/changes/${handed}/review`, { verdict: risky ? "approve" : "request_changes", body: risky ? "" : "Say why the lock is held here." });
    }
  }
}

// Repositories (/): each seed repo's description (its README's first line) and language, and a token budget whose alerts
// fire from real AI Gateway usage.
const LANGUAGES = [[/go\.mod$/, "Go"], [/Cargo\.toml$/, "Rust"], [/\.csproj$/, "C#"], [/\.py$/, "Python"], [/\.tf$/, "HCL"], [/Chart\.yaml$/, "Helm"],
  [/\.astro$/, "Astro"], [/\.tsx?$/, "TypeScript"], [/\.js$/, "JavaScript"]];
async function seedRepos(api, sources) {
  for (const [repo, files] of Object.entries(sources)) {
    const description = (files["README.md"] ?? "").split("\n").find((l) => l && !l.startsWith("#"))?.slice(0, 280) ?? "";
    const language = LANGUAGES.find(([re]) => Object.keys(files).some((p) => re.test(p)))?.[1] ?? null;
    await api("PUT", `/api/repos/${repo}/settings`, { description, language });
  }
  await api("PUT", "/api/account", { name: "Cinder seed", budget_tokens: 5000000, alerts: [50, 80] });
}

// A repo's dependencies as a scanner reads them from its manifests: [file pattern, OSV ecosystem, text → [[name, version]]].
const MANIFESTS = [
  [/(^|\/)package\.json$/, "npm", (t) => Object.entries({ ...JSON.parse(t).dependencies, ...JSON.parse(t).devDependencies })],
  [/(requirements\.txt|pyproject\.toml)$/, "PyPI", (t) => [...t.matchAll(/^"?([\w.-]+)==([\w.]+)|"([\w.-]+)==([\w.]+)"/gm)].map((m) => m[1] ? [m[1], m[2]] : [m[3], m[4]])],
  [/Cargo\.toml$/, "crates.io", (t) => t.split(/^\[/m).filter((sec) => /^[\w-]*dependencies\]/.test(sec))
    .flatMap((sec) => [...sec.matchAll(/^([\w-]+) = (?:"([\d.]+)"|\{ version = "([\d.]+)")/gm)].map((m) => [m[1], m[2] ?? m[3]]))],
  [/\.csproj$/, "NuGet", (t) => [...t.matchAll(/PackageReference Include="([^"]+)" Version="([^"]+)"/g)].map((m) => m.slice(1))],
];
// The seed repos' dependencies are all permissively licensed: these three families Apache-2.0 or BSD, the rest MIT.
const license = (name) => (/^(typescript|@pulumi\/|xunit)/.test(name) ? "Apache-2.0" : /^(uvicorn|httpx)$/.test(name) ? "BSD-3-Clause" : "MIT");
const inventory = (files) => Object.entries(files).flatMap(([path, text]) => MANIFESTS.filter(([re]) => re.test(path))
  .flatMap(([, ecosystem, read]) => read(text).map(([name, version]) => ({ ecosystem, name, version, license: license(name), class: "permissive", direct: true }))));

// Each repo's code scanner result, [path, line, rule, message], uploaded as a SARIF log that a runner ingests as a code finding.
const SARIF = {
  [REPOS.trunk]: ["orders.go", 37, "go/unbounded-item-count", "Create accepts an order with any number of items."],
  [REPOS.gitflow]: ["lib/cart.ts", 1, "js/unchecked-quantity", "addToCart accepts a quantity below one."],
  [REPOS.infra]: ["main.tf", 6, "tf/worker-without-logs", "The Worker script has no observability settings."],
};

// Watchtower (/:repo/watchtower): web-store's auto-fix on three packages and each repo's SARIF upload. Scans come from a
// runner (seed/activity.mjs); the seed repos pin a vulnerable package and plant a fake token for them to find.
async function seedWatchtower(api) {
  for (const name of ["wrangler", "vitest", "typescript"]) await api("PATCH", `/api/repos/${REPOS.gitflow}/dependencies`, { ecosystem: "npm", name, auto_fix: true });
  for (const [repo, [uri, startLine, ruleId, text]] of Object.entries(SARIF)) {
    // lazy: a re-run before a runner ingested the upload uploads again; findings dedupe by fingerprint, so only the job repeats.
    if ((await api("GET", `/api/repos/${repo}/watchtower`)).findings.some((f) => f.source === "code")) continue;
    const { default_branch: ref } = await api("GET", `/api/repos/${repo}`);
    const sha = (await api("GET", `/api/repos/${repo}/log?ref=${encodeURIComponent(ref)}`))?.commits?.[0]?.sha;
    if (!sha) continue;
    await api("POST", `/api/repos/${repo}/sarif?sha=${sha}`, { version: "2.1.0", runs: [{
      tool: { driver: { name: "seed-lint", rules: [{ id: ruleId, properties: { "security-severity": "5.0" } }] } },
      results: [{ ruleId, level: "warning", message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }] }],
    }] });
  }
}

// Wiki (/wiki): the stack's org pages, one per kind of repo with each repo's README line, the orders service's runbook
// with a page in two versions, a comment and a page `search?q=rollout` finds, an Agent guides folder whose Conventions page
// is agent context, and an overview of each other repo with a comment.
const KINDS = [["Services", "svc-"], ["Web apps", "web-"], ["Infrastructure", "infra-"]];
const OVERVIEWS = { [REPOS.gitflow]: "Which browsers does checkout support?", [REPOS.infra]: "Who owns the Cloudflare account this module targets?" };
async function seedWiki(api, sources) {
  for (const [repo, question] of Object.entries(OVERVIEWS)) {
    if ((await api("GET", `/api/repos/${repo}/wiki/tree`)).length) continue;
    const readme = (sources[repo]?.["README.md"] ?? "").split("\n").find((l) => l && !l.startsWith("#")) ?? "";
    const page = await api("POST", `/api/repos/${repo}/wiki/pages`, { title: "Overview", content: `# ${repo}\n\n${readme}\n` });
    await api("POST", `/api/repos/${repo}/wiki/pages/${page.id}/comments`, { body: question });
  }
  const at = `/api/repos/${REPOS.trunk}/wiki/pages`;
  if ((await api("GET", `/api/repos/${REPOS.trunk}/wiki/tree`)).length) return;
  const stack = await api("POST", at, { title: "Stack", content: "# Stack\n\nEvery service, app, infrastructure module and library cinder delivers, by kind.\n" });
  for (const [title, prefix] of KINDS) {
    const repos = Object.entries(sources).filter(([name]) => (typeof prefix === "string" ? name.startsWith(prefix) : prefix.test(name)));
    await api("POST", at, { parent_id: stack.id, title, content: `# ${title}\n\n${repos.map(([name, f]) => `- **${name}**: ${(f["README.md"] ?? "").split("\n").find((l) => l && !l.startsWith("#")) ?? ""}`).join("\n")}\n` });
  }
  const runbook = await api("POST", at, { title: "Runbook", content: `# Runbook\n\nWhat to do when ${REPOS.trunk} pages.\n` });
  await api("PATCH", `${at}/${runbook.id}`, { base_version: 1, message: "Name the dashboards",
    content: `# Runbook\n\nWhat to do when ${REPOS.trunk} pages: check the error rate and latency dashboards, then the last Container deploy.\n` });
  await api("POST", `${at}/${runbook.id}/comments`, { body: "Who is on call for this service?" });
  const rollout = await api("POST", at, { parent_id: runbook.id, title: "Roll back a bad rollout", content: "Roll back first.\n" });
  await api("PATCH", `${at}/${rollout.id}`, { base_version: 1, message: "Say how",
    content: `Roll back a Container deploy with \`wrangler rollback\` to the Worker version that ran the previous image, then read the container's logs before the next rollout.\n` });
  await api("POST", `${at}/${rollout.id}/comments`, { body: "Does a rollback drop orders in flight?" });
  const guides = await api("POST", at, { title: "Agent guides", content: "# Agent guides\n\nWhat agents read before they change this repo.\n" });
  const conventions = await api("POST", at, { parent_id: guides.id, title: "Conventions",
    content: "# Conventions\n\n## Errors\n\nReturn errors with context; never log and return the same error.\n\n## Tests\n\nOne test per behaviour, named after it.\n" });
  await api("POST", at, { parent_id: guides.id, title: "Glossary", content: "# Glossary\n\n- **Order**: a basket a customer paid for.\n" });
  await api("PATCH", `${at}/${conventions.id}`, { agent_context: true });
}

// Issues (/:repo/issues): each seed repo's backlog: a bug (BUGS) in progress, its open gaps (todos()) as features to do,
// a dependency chore in the backlog and its flows issue done, with labels, priorities, people and agents as assignees.
// The orders service's first feature links the change that does it, and is in review.
const BUGS = {
  "svc-orders-go": "Order totals overflow int for very large quantities", "web-store": "The cart cookie is not marked Secure",
  "infra-cloudflare-tf": "terraform test downloads the provider on every run",
};
const LINKS = { [REPOS.trunk]: "Paginate GET /orders with limit and after" };
async function seedIssues(api, sources) {
  for (const [n, [repo, files]] of Object.entries(sources).entries()) {
    const at = `/api/repos/${repo}/issues`;
    if ((await api("GET", at)).length) continue;
    const dep = inventory(files)[0];
    const backlog = [
      [BUGS[repo] ?? `${repo} fails its check on a clean checkout`, "progress", "P1", PEOPLE[n % PEOPLE.length], ["bug"]],
      ...todos(files).map((gap) => [gap, "todo", "P2", "developer@v2", ["feature"]]),
      ...(dep ? [[`Bump ${dep.name} past ${dep.version}`, "backlog", "P3", null, ["chore", "dependencies"]]] : []),
      ["Add build, test and deploy flows", "done", "P2", PEOPLE[(n + 1) % PEOPLE.length], ["chore", "ci"]],
    ];
    const link = (await api("GET", `/api/repos/${repo}/changes`)).find((c) => c.intent === LINKS[repo]);
    for (const [i, [title, status, priority, assignee, labels]] of backlog.entries()) {
      const { number } = await api("POST", at, { title, body: `${title}.` });
      const change = i === 1 && labels[0] === "feature" && link;
      if (change) await api("PUT", `${at}/${number}/changes/${change.id}`);
      await api("PATCH", `${at}/${number}`, { status: change ? "review" : status, priority, assignee, labels,
        iteration: status === "backlog" ? null : status === "done" ? "Sprint 13" : "Sprint 14", ...(status === "done" && { state: "closed" }) });
    }
  }
}

// Access & people (/settings/access): PEOPLE with their ROLES, and no group mappings. A person shows "never" until
// they sign in through Access.
// Changes (/:repo/changes): intents on the Terraform module filed through the issues route, the first claimed by the
// stable developer and the second raced by developer and dev-open, through the claim route, so real pools develop them.
export const INTENTS = ["Pin the Cloudflare provider to a minor version", "Add a KV namespace for feature flags",
  "Output the D1 database ID", "Document the module's required variables"];
async function seedWork(api) {
  const at = `/api/repos/${REPOS.infra}/issues`;
  const filed = (await api("GET", at)).map((i) => i.title);
  if (filed.includes(INTENTS[0])) return;
  const ns = [];
  for (const title of INTENTS) ns.push((await api("POST", at, { title, body: `${title}.` })).number);
  // The seeded versions on Workers AI: the baked-in v1 needs a personal model key.
  const suggested = (await api("GET", `/api/repos/${REPOS.infra}/agents/suggest?issue=${ns[0]}`)).map((a) => a.agent);
  const agents = ["developer@v2", "dev-open@v1"].filter((a) => suggested.includes(a));
  await api("POST", `${at}/${ns[0]}/claim`, { mode: "agent", agents: agents.slice(0, 1) });
  await api("POST", `${at}/${ns[1]}/claim`, { mode: "race", agents: agents.slice(0, 2) });
}

// The managed pools every install starts with (a reset wipes them): without them no job runs. min 0, so a container
// runs only while a job is queued. A pool already there is left as it is, except that toolchains, while it still has the
// default allowlist, gets the Terraform registry and the GitHub release hosts its providers download from, so the
// Terraform repo's flows can init.
async function seedPools(api) {
  const pools = await api("GET", "/api/workers/pools");
  // build takes the JS repos' agent work: 12 so the demo's twelve intents can all run at once (min 0: no idle cost).
  if (!pools.some((p) => p.name === "build")) await api("POST", "/api/workers/pools", { name: "build", size: "basic", min: 0, max: 12 });
  let toolchains = pools.find((p) => p.name === "toolchains");
  if (!toolchains) {
    toolchains = await api("POST", "/api/workers/pools", { name: "toolchains", size: "standard-2", min: 0, max: 4 });
    await api("PUT", `/api/workers/pools/${toolchains.id}`, { labels: ["linux", "full-image"] });
  }
  if (!toolchains.egress_allow?.length) {
    await api("PUT", `/api/workers/pools/${toolchains.id}`, { egress_allow: [...EGRESS, "registry.terraform.io", "github.com", "release-assets.githubusercontent.com"] });
  }
}

// Workers (/automation/workers): a BYO pool self-hosted with labels linux and gpu, and labels on the toolchains managed pool.
async function seedWorkers(api) {
  const byo = await api("GET", "/api/workers/byo-pools");
  if (!byo.some((p) => p.name === "self-hosted")) await api("POST", "/api/workers/byo-pools", { name: "self-hosted", labels: ["linux", "gpu"] });
  const toolchains = (await api("GET", "/api/workers/pools")).find((p) => p.name === "toolchains");
  if (toolchains) await api("PUT", `/api/workers/pools/${toolchains.id}`, { labels: ["linux", "full-image"] });
}

// CI (/:repo/flows/runs/:id): one run of the orders service's six-stage ci flow, and one of its daily flow (the designer's
// trust bar), for real runners to take, started like Run flow does. Their flow files come with the library import; a flow
// that already has a run gets none.
export const CI = { repo: REPOS.trunk, flow: "ci" };
async function seedCi(api) {
  const runs = await api("GET", `/api/repos/${CI.repo}/flow-runs`);
  for (const flow of [CI.flow, "daily"]) if (!runs.some((r) => r.flow === flow)) await api("POST", `/api/repos/${CI.repo}/flows/${flow}/runs`);
}

export async function seedAccess(api) {
  for (const [i, email] of PEOPLE.entries()) await api("POST", "/api/people", { email, role: ROLES[i] });
}

// Accounts (the sidebar account popover): one organization with three cinder-local accounts and their members, through
// the hand-add routes. No Cloudflare account id: a sync links them when the token can read the organization.
const ORG = { name: "Nimbus Edge", accounts: [
  ["Nimbus Edge Team", "nimbus-edge-team", [[PEOPLE[0], "admin"], [PEOPLE[1], "maintainer"]]],
  ["Nimbus Edge Staging", "nimbus-edge-staging", [[PEOPLE[2], "contributor"], [PEOPLE[3], "reader"]]],
  ["Nimbus Labs", "nimbus-labs", [[PEOPLE[0], "admin"], [PEOPLE[4], "reader"]]],
] };
async function seedAccounts(api) {
  const known = await api("GET", "/api/accounts");
  for (const [name, slug, members] of ORG.accounts) {
    const id = known.find((a) => a.slug === slug)?.id ?? (await api("POST", "/api/accounts", { name, slug, organization: ORG.name })).id;
    for (const [person, git_role] of members) await api("POST", `/api/accounts/${id}/members`, { person, git_role });
  }
}

// Empties a nonprod deployment (POST /api/admin/reset) and returns once the reset is done. The reset empties the stores in
// the background; a section that ran meanwhile would lose its writes.
export async function resetAll(api) {
  const { id } = await api("POST", "/api/admin/reset");
  for (let r; (r = await api("GET", `/api/admin/reset/${id}`)).status !== "done";) {
    if (r.status === "failed") throw new Error(`reset ${id} failed at ${r.step}: ${r.error}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// push: releases an agent version (commitRelease from the CLI). Without it the agents section is skipped, as a test's
// fake Artifacts can't take a git push. commit and sources: commit(body) writes a repo's history through the seed route
// and sources maps each seed/repos name to its files; with both, seedLibrary imports every repo, and the code section
// builds on it. sections: a live test seeds only the ones its page reads, so a new section adds setup time only to the
// files that name it. Picked sections run in this order.
// sections "all" (`--full`) runs every section, for a pass over every page; seed/README.md lists which page each serves.
// reset (`--reset`) first empties a nonprod deployment (POST /api/admin/reset, then polls it until done), so every run seeds the same state.
export async function seed(api, push, sections = ["changes", "gitflow"], commit, sources, reset = false) {
  const has = (s) => sections === "all" || sections.includes(s);
  if (reset) await resetAll(api);
  await seedPools(api);
  if (commit && sources) await seedLibrary(api, commit, sources);
  // Without the import, the page sections' repos are made empty; gitflow ones target develop.
  for (const name of Object.values(REPOS)) {
    if (!(await api("GET", `/api/repos/${name}`))) await api("POST", "/api/repos", { name, default_branch: name === REPOS.gitflow ? "develop" : "main" });
  }
  await ensureRepo(api, REPOS.gitflow, undefined, GITFLOW);
  await seedJudges(api);
  if (push) await seedAgents(api, push);
  if (has("changes")) await seedChanges(api);
  if (has("gitflow")) await seedGitflow(api);
  if (has("states")) await seedStates(api);
  if (has("review")) await seedReview(api);
  if (has("detail")) await seedDetail(api);
  if (has("repos")) await seedRepos(api, sources ?? {});
  if (has("watchtower")) await seedWatchtower(api);
  // Accounts, wiki, work, workers, then the CI run: each later one may read what an earlier one wrote.
  if (has("accounts")) await seedAccounts(api);
  if (has("wiki")) await seedWiki(api, sources ?? {});
  if (has("issues")) await seedIssues(api, sources ?? {});
  // After issues: the issues section seeds only a repo with no issues yet.
  if (has("work")) await seedWork(api);
  if (sources && has("releases")) await seedReleases(api, sources);
  if (has("access")) await seedAccess(api);
  if (has("workers")) await seedWorkers(api);
  if (commit && sources && has("ci")) await seedCi(api);
  if (commit) await seedCode(api);
  if (has("code-page")) await seedCodePage(api);
  if (commit && has("people")) await seedPeople(api, commit);
}

// Only when run as a script: bundled into the e2e Worker, import.meta.url is not a URL.
if (globalThis.process?.argv[1] && globalThis.process.argv[1] === new URL(import.meta.url).pathname) {
  const { CINDER_URL: url, CINDER_TOKEN: token, CINDER_ACCESS_CLIENT_ID: accessId, CINDER_ACCESS_CLIENT_SECRET: accessSecret } = process.env;
  if (!url || !token) {
    console.error("seed: CINDER_URL and CINDER_TOKEN must be set");
    process.exit(1);
  }
  const api = client({ url, token, accessId, accessSecret });
  // Every file of seed/repos that git would commit (tracked or new), by repo.
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const root = new URL("./repos/", import.meta.url).pathname;
  const sources = {};
  for (const path of execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)) {
    const [name, ...rest] = path.split("/");
    (sources[name] ??= {})[rest.join("/")] = readFileSync(root + path, "utf8");
  }
  const commit = async ({ repo, ...body }) => (await api("POST", `/api/repos/${repo}/seed`, body)).shas;
  process.env.CINDER_PEOPLE_WAIT_MS ??= "180000";
  await seed(api, commitRelease(api), process.argv.includes("--full") ? "all" : undefined, commit, sources, process.argv.includes("--reset"));
  console.log(`seeded ${Object.keys(sources).join(", ")}`);
}
