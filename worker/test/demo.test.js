import { env } from "cloudflare:workers";
import { expect, it, onTestFinished } from "vitest";
import { INTENTS, REPO, demo, deploy } from "../../seed/demo.mjs";
import { PEOPLE, client, seedAgents } from "../../seed/seed.mjs";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { git } from "./fakes/bare-repo.js";
import { PULSE_SOURCES, indexPulse, relayCommit } from "./fakes/seed.js";

it("demo loads pulse from demo/pulse with main and develop and no GitHub token", async () => {
  const fake = fakeArtifacts();
  // RepoDO reads .cinder.yml through its own env (see seed.test.js).
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), { ...env, ARTIFACTS: fake, PIPELINE: { create: async () => ({}) } }) });
  const dir = `demo-${crypto.randomUUID()}`;
  const commit = relayCommit(dir, fake);
  const snapshot = async () => {
    const repos = (await api("GET", "/api/repos")).map((r) => r.name);
    // The seam change cinder files for the alerts() pair is checked in demo-seam.test.js.
    const changes = (await api("GET", `/api/repos/${REPO}/changes`)).filter((c) => c.kind !== "seam");
    const authors = await Promise.all(changes.map(async (c) => (await api("GET", `/api/changes/${c.id}`)).events[0].actor.id));
    return { repos, changes: changes.map((c, i) => [c.id, c.intent, c.target_branch, c.state, authors[i]]).sort() };
  };

  await Promise.all([demo(api, commit, PULSE_SOURCES), indexPulse(api)]);
  const first = await snapshot();
  const heads = await git(["--git-dir", `${dir}-${REPO}.git`, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]);
  await demo(api, commit, PULSE_SOURCES);
  expect(await snapshot()).toEqual(first);
  // A re-run leaves the repo as it is.
  expect(await git(["--git-dir", `${dir}-${REPO}.git`, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"])).toBe(heads);
  expect(heads.split("\n").map((l) => l.split(" ")[0])).toEqual(["develop", "main"]);
  const tree = (ref) => git(["--git-dir", `${dir}-${REPO}.git`, "ls-tree", "-r", "--name-only", ref]);
  expect((await tree("main")).split("\n").sort()).toEqual(Object.keys(PULSE_SOURCES).sort());
  expect((await tree("develop")).split("\n")).toEqual(expect.arrayContaining(Object.keys(PULSE_SOURCES)));
  await git(["--git-dir", `${dir}-${REPO}.git`, "merge-base", "--is-ancestor", "main", "develop"]);
  // Nothing is imported, so no GitHub token is needed or kept.
  expect(fake.calls.filter((c) => c.method === "import")).toEqual([]);
  expect(INTENTS).toHaveLength(12);
  expect(new Set(first.changes.map(([, intent]) => intent))).toEqual(new Set(INTENTS.map((i) => i.intent)));
  // The race files its intent as two changes.
  expect(first.changes).toHaveLength(13);
  expect(new Set(first.changes.map(([, , , , author]) => author))).toEqual(new Set(PEOPLE));
  expect(first.repos).toEqual([REPO]);
  expect(first.changes.every(([, , target]) => target === "develop")).toBe(true);
});

it("the raced intent names two seeded agent versions on two different models", async () => {
  const locks = [];
  await seedAgents(async (method, path) => (method === "GET" && path !== "/api/models/catalog" ? null : []), async ({ lock }) => locks.push(lock));
  const [raced] = INTENTS.filter((i) => i.race);
  const models = raced.race.map((ref) => {
    const [name, version] = ref.split("@v");
    return locks.find((l) => l.name === name && l.version === Number(version))?.model;
  });
  expect(models).toEqual(["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b"]);
});

it("the demo setup deploys each of pulse's branch environments once", async () => {
  const posts = [];
  let envs = [{ name: "preview", branch: null, history: [] }, { name: "staging", branch: "develop", history: [] }, { name: "production", branch: "main", history: [] }];
  const api = async (method, path) => (method === "GET" ? envs : posts.push(path));
  await deploy(api);
  expect(posts).toEqual([`/api/repos/${REPO}/environments/staging/sync`, `/api/repos/${REPO}/environments/production/sync`]);
  envs = envs.map((e) => ({ ...e, history: e.branch ? [{ status: "Synced" }] : [] }));
  await deploy(api);
  expect(posts).toHaveLength(2);
});
