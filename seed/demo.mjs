// The demo video's scene (docs/demo/SCRIPT.md): `CINDER_URL=... CINDER_TOKEN=<owner token> node seed/demo.mjs` on a
// fresh nonprod instance (the seed route is nonprod only). Idempotent like seed.mjs: intents already filed are skipped, so a re-run leaves the same starting state.
// The seed's repos are seed.mjs's; every demo intent runs on pulse.
import { PEOPLE, TRUST, client, seedAccess } from "./seed.mjs";

// pulse, the JS status page in demo/pulse/, on gitflow: develop is the default branch and every intent's target.
export const REPO = "pulse";
const TARGET = "develop";

// Each intent is written to provoke one scheduler behaviour in pulse's src/index.js (check() and page()).
export const INTENTS = [
  // Intents name check() only where they mean it: it is exported, so two leasing it would start a seam.
  // stacks: both rewrite how check() records a result, so the second waits on the first's fork head.
  { intent: "Add incidents with a timeline" },
  { intent: "Mark a target degraded when it answers slower than 2 s" },
  // conflict: the predictions miss that both rewrite page()'s row markup; the second conflicts and the resolver fixes it.
  { intent: "Show each target's last response time on the status page" },
  { intent: "Group targets by region on the status page" },
  // seam split: both name alerts(), an exported function, so the scheduler lands a change to it first as a seam.
  { intent: "Send alerts to a webhook when a target goes down" },
  { intent: "Send alerts by email when a target goes down" },
  // A/B race: the stable developer (gpt-oss-120b) and dev-open (gpt-oss-20b) take the same intent; the first green leg wins.
  { intent: "Show 7-day uptime next to the 24-hour figure", race: ["developer@v2", "dev-open@v1"] },
  // flaky: its retry test waits on a real timer and fails one run in five.
  { intent: "Retry a failed request once before marking a target down" },
  // guarded push: the natural test fixture is a real-looking API key, which the push guard blocks.
  { intent: "Send a per-target API key with each request" },
  // parallel: each touches code nothing else does.
  { intent: "Serve the status as JSON when the request accepts application/json" },
  { intent: "Add a /badge.svg endpoint per target" },
  { intent: "Prune results older than 30 days" },
];

// files: demo/pulse's files by path; commit: the seed route (POST /api/repos/:name/seed), as seedLibrary's. main gets the
// app and develop starts from it. The seed route starts no deploy, so pulse's .cinder.yml resources are never created.
// A repo with commits on main is left as it is. lazy: a run stopped between the two commits leaves no develop; delete the repo to redo it.
// say: one progress line per step (the command line prints them; the Worker's seed passes none).
export async function demo(api, commit, files, say = () => {}) {
  await setup(api, commit, files, say);
  // Filed one at a time, in order, so every run stacks the same change on the same one and gives it the same author.
  for (const [i, { intent, race }] of INTENTS.entries()) {
    const changes = await api("GET", `/api/repos/${REPO}/changes`);
    const change = changes.find((c) => c.intent === intent) ?? await api("POST", `/api/repos/${REPO}/changes`, { intent, race, author: PEOPLE[i % PEOPLE.length] });
    say(`  ${String(change?.key ?? "").padEnd(9)} ${intent}${race ? `  (race: ${race.join(" vs ")})` : ""}`);
  }
}

// pulse with main and develop, indexed and deployed: everything the demo needs before its intents (make seed runs this).
export async function setup(api, commit, files, say = () => {}) {
  await seedAccess(api);
  if (!(await api("GET", `/api/repos/${REPO}`))) await api("POST", "/api/repos", { name: REPO, default_branch: TARGET });
  say(`${REPO}: repository ready, target ${TARGET}`);
  await api("PUT", `/api/repos/${REPO}/settings`, { trust: TRUST });
  if (!(await api("GET", `/api/repos/${REPO}/log?ref=main`))) {
    await commit({ repo: REPO, branch: "main", commits: [{ author: PEOPLE[0], message: "Add pulse, a status page for HTTP targets", files }] });
    await commit({ repo: REPO, branch: TARGET, from: "main", commits: [{ author: PEOPLE[1], message: "Start develop", files: { "CHANGELOG.md": "# Changelog\n\n## Unreleased\n" } }] });
  }
  // Leases are predicted from the target's symbol index; asking queues the index job, which a runner does (~1 min).
  say(`${REPO}: indexing ${TARGET} so leases can be predicted…`);
  let index;
  for (let wait = 250; !(index = await api("GET", `/api/repos/${REPO}/symbols?target=${TARGET}`))?.symbols; wait *= 2) {
    if (wait > 32000) throw new Error(`demo: ${REPO} ${TARGET} is not indexed; is a runner taking index jobs?`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  say(`${REPO}: ${index.symbols.length} symbols indexed`);
  await deploy(api, say);
  say(`${REPO}: filing ${INTENTS.length} intents, one at a time`);
}

// pulse deploys for real on the account (make down deletes pulse-<env> and its D1 and KV): each branch environment
// (staging from develop, production from main) is synced once, so Environments shows live versions and history.
export async function deploy(api, say = () => {}) {
  for (const e of await api("GET", `/api/repos/${REPO}/environments`)) {
    if (e.branch && !e.history.length) await api("POST", `/api/repos/${REPO}/environments/${e.name}/sync`, {});
    if (e.branch) say(`${REPO}: environment ${e.name} deploys from ${e.branch}`);
  }
}

// Only when run as a script: bundled into the Worker, import.meta.url is not a URL.
if (globalThis.process?.argv[1] && globalThis.process.argv[1] === new URL(import.meta.url).pathname) {
  const { CINDER_URL: url, CINDER_TOKEN: token, CINDER_ACCESS_CLIENT_ID: accessId, CINDER_ACCESS_CLIENT_SECRET: accessSecret } = process.env;
  if (!url || !token) {
    console.error("demo: CINDER_URL and CINDER_TOKEN must be set");
    process.exit(1);
  }
  const api = client({ url, token, accessId, accessSecret });
  // Every file of demo/pulse that git would commit (tracked or new).
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const root = new URL("../demo/pulse/", import.meta.url).pathname;
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const commit = async ({ repo, ...body }) => (await api("POST", `/api/repos/${repo}/seed`, body)).shas;
  const files = Object.fromEntries(paths.map((p) => [p, readFileSync(root + p, "utf8")]));
  // --setup: pulse imported, indexed and deployed, with no intents filed (make seed); the demo itself files them.
  const say = (line) => console.log(line);
  if (process.argv.includes("--setup")) await setup(api, commit, files, say);
  else await demo(api, commit, files, say);
  console.log(process.argv.includes("--setup") ? `demo: ${REPO} set up and deployed` : `demo: ${INTENTS.length} intents on ${REPO}, handed to agents`);
}
