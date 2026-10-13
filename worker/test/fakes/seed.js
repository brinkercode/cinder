// Artifacts for tests that run seed/seed.mjs. Its gitflow repo lands with web-store's files (no commit callback reaches
// this fake); the demo commits pulse from demo/pulse through the seed route (relayCommit).
import { env } from "cloudflare:workers";
import { REPO } from "../../../seed/demo.mjs";
import { REPOS } from "../../../seed/seed.mjs";
import worker from "../../src/index.js";
import { fakeArtifacts } from "./artifacts.js";
import { bareRepo, git } from "./bare-repo.js";

// seed(..., commit, sources)'s sources: every seed/repos/<name> file, dotfiles and flows too, minus local build output.
const files = import.meta.glob(["../../../seed/repos/*/**/*", "../../../seed/repos/*/**/.*", "../../../seed/repos/*/.cinder/flows/*", "!**/{node_modules,dist,.next,.astro,.venv,target,bin,obj,.terraform}/**"],
  { query: "?raw", import: "default", eager: true });
export const SEED_SOURCES = {};
for (const [path, text] of Object.entries(files)) {
  const [name, ...rest] = path.slice("../../../seed/repos/".length).split("/");
  (SEED_SOURCES[name] ??= {})[rest.join("/")] = text;
}

// demo(api, commit, files)'s files: every demo/pulse file, dotfiles and flows too.
export const PULSE_SOURCES = Object.fromEntries(Object.entries(import.meta.glob(["../../../demo/pulse/**/*", "../../../demo/pulse/**/.*", "../../../demo/pulse/.cinder/flows/*"],
  { query: "?raw", import: "default", eager: true })).map(([path, text]) => [path.slice("../../../demo/pulse/".length), text]));

export const SEED_IMPORTS = {
  // A tiny public repo for the import tests; a landed import lists as ready.
  "https://github.com/octocat/Hello-World.git": { README: "Hello World!\n" },
};
// seed()'s commit: the real seed route into the relay's bare repo <dir>-<repo>.git, mirrored into fake, which can't read a push.
export const relayCommit = (dir, fake) => async ({ repo, ...body }) => {
  await git(["init", "-q", "--bare", "-b", "main", `${dir}-${repo}.git`]);
  const res = await worker.fetch(new Request(`http://cinder.test/api/repos/${repo}/seed`, { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
    body: JSON.stringify(body) }), { ...env, ARTIFACTS: { get: async (name) => bareRepo(`${dir}-${name}`) } });
  if (res.status !== 201) throw new Error(`seed route: ${res.status} ${await res.text()}`);
  const { shas } = await res.json();
  body.commits.forEach(({ files, author, message }, i) => Object.assign(fake.repos.get(repo).files, files) && fake.repos.get(repo).commits.unshift({ sha: shas[i], author: { name: author }, message }));
  // As the push event does: the Code API's cached heads of repo (the route dropped the relay repo's).
  await env.REPO_DO.get(env.REPO_DO.idFromName(repo)).dropHeads();
  return shas;
};
// The other seed repos land with only the commit create's .cinder.yml would have left, so they don't list as empty.
export const seedArtifacts = () => fakeArtifacts({ imports: SEED_IMPORTS, creates: { [REPOS.trunk]: {}, [REPOS.infra]: {}, [REPOS.gitflow]: SEED_SOURCES[REPOS.gitflow] } });

// Plays the index runner for the job demo() queues (polls ~100 s, inside the test's 120 s: under the full suite the job can queue late): the symbols cinder-verify finds in demo/pulse/src/index.js.
export async function indexPulse(api) {
  const { token } = await api("POST", "/api/runners", { name: "index", kinds: ["index"] });
  let claim;
  for (let i = 0; !claim && i < 2000; i++) {
    claim = await api("POST", "/api/work/claim", { kinds: ["index"], slots_free: 1 }, token) ?? await new Promise((r) => setTimeout(r, 50));
  }
  await api("PUT", `/api/work/repos/${REPO}/symbols/${claim.payload.sha}`, [
    { path: "src/index.js", name: "DAY_MS", kind: "variable", line: 1, end: 1 },
    { path: "src/index.js", name: "esc", kind: "variable", line: 2, end: 2 },
    { path: "src/index.js", name: "alerts", kind: "function", line: 5, end: 8, exported: true },
    { path: "src/index.js", name: "check", kind: "function", line: 11, end: 28, exported: true },
    { path: "src/index.js", name: "page", kind: "function", line: 30, end: 39 },
  ], token);
  await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done" }, token);
}
