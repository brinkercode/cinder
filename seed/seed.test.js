// The seed through the real API, on Artifacts backed by the runner relay's bare repos: the person-driven section (seedPeople),
// where the test plays what a deployment does outside the API (Artifacts' push event, a pool's verify runner), and the
// activity script against a fake cinder API (which flow runs it starts). Runs in the Worker's vitest project.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, inject, it, onTestFinished, vi } from "vitest";
import { CI, PEOPLE, PEOPLE_EDITS, client, seed, seedAgents, seedPeople } from "./seed.mjs";
import { ADVISORIES, DELIBERATE, activity, agentIntent } from "./activity.mjs";
import { parseFlow } from "../worker/src/api/shapes/flow.js";
import worker from "../worker/src/index.js";
import { fakeClefAI } from "../worker/test/fakes/ai.js";
import { bareRepo, git } from "../worker/test/fakes/bare-repo.js";
import { SEED_SOURCES } from "../worker/test/fakes/seed.js";

// The symbol each repo's edits write, as cinder-verify reports it from the diff.
const SYMBOL = { "svc-orders-go": "orders.go#Delete", "web-store": "lib/cart.ts#addToCart", "infra-cloudflare-tf": "variables.tf#name" };
const dir = crypto.randomUUID();
const bare = (name) => `${dir}-${name}`;
const made = new Set();
const remote = (name) => `${inject("runnerRelay").url}/smart/${bare(name)}.git`;
const handle = (name) => ({ ...bareRepo(bare(name)), async fork(child) {
  await git(["clone", "-q", "--bare", `${bare(name)}.git`, `${bare(child)}.git`]);
  made.add(child);
  return { name: child, remote: remote(child), defaultBranch: "main", token: "t" };
} });
const artifacts = {
  async create(name) {
    await git(["init", "-q", "--bare", "-b", "main", `${bare(name)}.git`]);
    made.add(name);
    return { name, remote: remote(name), defaultBranch: "main", token: "t" };
  },
  async get(name) {
    if (!made.has(name)) throw Object.assign(new Error(`Repository not found: ${name}.`), { name: "ArtifactsError" });
    return handle(name);
  },
  async delete(name) { return made.delete(name); },
  async list() { return { repos: [...made].map((name) => ({ name })) }; },
};
// The risk judge answers high, untrusted while it has no outcomes, as a fresh deployment's does.
const AI = fakeClefAI(async () => ({ risk: { low: 0.05, medium: 0.05, high: 0.9 } }));
const e = () => ({ ...env, ARTIFACTS: artifacts, AI });
const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), e()) });
// As the CLI commits a repo's history: the seed route.
const commit = async ({ repo, ...body }) => (await api("POST", `/api/repos/${repo}/seed`, body)).shas;
const people = () => seed(api, undefined, ["people"], commit);
const byIntent = async (repo) => {
  const all = await api("GET", `/api/repos/${repo}/changes`);
  return PEOPLE_EDITS[repo][1].slice(0, 3).map(([intent]) => all.find((c) => c.intent === intent));
};

// A pool's verify runner: claims every queued verify job, then reports them in order ([change id, repo, symbol?]), each
// writing its repo's symbol unless given another.
async function verify(order) {
  const { token } = await api("POST", "/api/runners", { name: `verify-${crypto.randomUUID()}`, kinds: ["verify"], slots: 64 });
  const jobs = [];
  for (let claim; (claim = await api("POST", "/api/work/claim", { kinds: ["verify"], slots_free: 99 }, token));) jobs.push(claim.job);
  for (const [id, repo, symbol = SYMBOL[repo]] of order) {
    for (const job of jobs.filter((j) => j.change_id === id)) {
      await api("POST", `/api/work/jobs/${job.id}/report`, { status: "done", writes: [{ symbol, kind: "body" }] }, token);
    }
  }
}

// Artifacts announces each change's head copied into its fork, and a pool's guard runner finds it clean: the guard
// result the merge gate needs for that head.
async function guard(ids) {
  for (const id of ids) {
    const { fork, head } = await api("GET", `/api/changes/${id}`);
    await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "cinder", repoName: fork },
      payload: { ref: "refs/heads/main", before: "a".repeat(40), after: head, commits: [] } } }] }, e());
  }
  const { token } = await api("POST", "/api/runners", { name: `guard-${crypto.randomUUID()}`, kinds: ["guard"], slots: 64 });
  for (let claim; (claim = await api("POST", "/api/work/claim", { kinds: ["guard"], slots_free: 99 }, token));) {
    await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done", diff: "" }, token);
  }
}

// Each repo holds the file its edits touch, then the section runs; a pool verifies the changes in the order they were
// opened, the next run hands one collision over, pushes the follow-up, which Artifacts announces and the pool verifies, and
// queues the first change, which the pool merges; a last run gives the owner's verdict on the handed-over change.
let flow;
const seeded = () => (flow ??= (async () => {
  for (const [repo, [path]] of Object.entries(PEOPLE_EDITS)) {
    await api("POST", "/api/repos", { name: repo, default_branch: repo === "web-store" ? "develop" : "main" });
    await api("POST", `/api/repos/${repo}/seed`, { commits: [{ author: PEOPLE[0], message: "Import", files: { [path]: SEED_SOURCES[repo][path] } }] });
  }
  await people();
  const opened = [];
  for (const repo of Object.keys(PEOPLE_EDITS)) {
    opened.push(...(await byIntent(repo)).map((c) => [c.id, repo]));
  }
  await verify(opened);
  await guard(opened.map(([id]) => id));
  await people();
  const moved = [];
  for (const repo of Object.keys(PEOPLE_EDITS)) {
    const handed = (await byIntent(repo))[2];
    const after = await git(["--git-dir", `${bare(repo)}.git`, "rev-parse", `refs/heads/${handed.head_branch}`]);
    await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "cinder", repoName: repo },
      payload: { ref: `refs/heads/${handed.head_branch}`, before: "a".repeat(40), after, commits: [] } } }] }, e());
    moved.push([handed.id, repo]);
  }
  await verify(moved);
  const { token } = await api("POST", "/api/runners", { name: `merge-${crypto.randomUUID()}`, kinds: ["merge"], slots: 8 });
  for (let claim; (claim = await api("POST", "/api/work/claim", { kinds: ["merge"], slots_free: 8 }, token));) {
    await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done" }, token);
  }
  await people();
})());

beforeAll(() => { env.ARTIFACTS = artifacts; });
afterAll(() => { delete env.ARTIFACTS; });

it("the seed leaves each repo with person-driven changes that have real diffs", async () => {
  await seeded();
  for (const [repo, [path, edits]] of Object.entries(PEOPLE_EDITS)) {
    for (const [i, change] of (await byIntent(repo)).entries()) {
      const [, find, replace] = edits[i];
      expect(change.driver).toBe(PEOPLE[i]);
      // A merged change's edit is on its target, so it lists no files of its own.
      if (change.state === "merged") continue;
      const files = await api("GET", `/api/changes/${change.id}/files`);
      expect(files.map((f) => f.path)).toEqual([path]);
      const added = replace.split("\n").find((l) => l && !find.includes(l));
      expect(JSON.stringify(files[0].lines)).toContain(JSON.stringify(added).slice(1, -1));
    }
  }
}, 300000);

it("after the seed every repo has one handed-over and one open collision", async () => {
  await seeded();
  for (const repo of Object.keys(PEOPLE_EDITS)) {
    const [first, open, handed] = await byIntent(repo);
    const { feed } = await api("GET", `/api/repos/${repo}/collisions`);
    const want = [[handed.id, first.id, SYMBOL[repo], "handover"], [open.id, first.id, SYMBOL[repo], null]];
    expect(feed.map((f) => [f.ours, f.theirs, f.symbol, f.resolution]).toSorted()).toEqual(want.toSorted());
  }
}, 300000);

it("after the seed each repo has a merged change, a blocked change and a commit linked to a change", async () => {
  await seeded();
  for (const repo of Object.keys(PEOPLE_EDITS)) {
    const [first, open, handed] = await byIntent(repo);
    expect([first.state, open.state]).toEqual(["merged", "conflict"]);
    const { commits } = await api("GET", `/api/repos/${repo}/log?ref=${encodeURIComponent(handed.head_branch)}`);
    expect(commits.map((c) => c.message).join("\n")).toContain(`Cinder-Change: ${handed.id}`);
  }
}, 300000);

it("after the seed Needs you lists a judges-disagree and an untrusted-judge item", async () => {
  await seeded();
  const needs = await api("GET", "/api/needs");
  for (const repo of Object.keys(PEOPLE_EDITS)) {
    const handed = (await byIntent(repo))[2];
    expect(needs.filter((n) => n.change === handed.id).map((n) => n.kind).toSorted()).toEqual(["Judges disagree", "Untrusted judge"]);
  }
}, 300000);

it("no seeded change is left in developing without an agent to run it", async () => {
  await seeded();
  const changes = (await Promise.all(Object.keys(PEOPLE_EDITS).map(byIntent))).flat();
  expect(changes).toHaveLength(9);
  for (const c of changes) expect(["verifying", "conflict", "merged"]).toContain(c.state);
  // An agent's runner finds no develop work on them.
  const { token } = await api("POST", "/api/runners", { name: "develop", kinds: ["develop"] });
  expect(await api("POST", "/api/work/claim", { kinds: ["develop"], slots_free: 1 }, token)).toBeNull();
}, 300000);

it("a further run leaves the resolved and open collisions as they are", async () => {
  await seeded();
  const snapshot = async () => Promise.all(Object.keys(PEOPLE_EDITS).map(async (repo) => ({
    changes: (await byIntent(repo)).map((c) => [c.id, c.state, c.head]),
    feed: (await api("GET", `/api/repos/${repo}/collisions`)).feed.map((f) => [f.id, f.resolution]),
    refs: await git(["--git-dir", `${bare(repo)}.git`, "for-each-ref", "--format=%(refname) %(objectname)"]),
  })));
  const before = await snapshot();
  expect(before.flatMap((r) => r.changes)).toHaveLength(9);
  for (const r of before) expect(r.feed.filter(([, resolution]) => resolution === "handover")).toHaveLength(1);
  await people();
  expect(await snapshot()).toEqual(before);
}, 300000);

it("a seed run hands nothing over when no colliding change is still in conflict", async () => {
  // Every change collides with the first on an open collision, but a push re-verified each one before the run.
  const writes = [];
  const fake = async (method, path) => {
    const [, , , repo, what] = path.split("/");
    if (method !== "GET" && !path.endsWith("/auto_queue")) {
      writes.push(`${method} ${path}`);
      // What the Worker answers for a change that has left Conflict.
      if (path.endsWith("/collisions/resolve")) throw new Error(`${method} ${path}: 409 change_moved`);
      return {};
    }
    if (path.startsWith("/api/changes/")) return { id: path.split("/")[3], state: "verifying" };
    if (path === "/api/needs") return [];
    if (what === undefined) return { default_branch: "main" };
    if (what.startsWith("file")) return { content: "x" };
    const ids = PEOPLE_EDITS[repo][1].slice(0, 3).map((_, i) => `${repo}-${i}`);
    if (what === "changes") return PEOPLE_EDITS[repo][1].slice(0, 3).map(([intent], i) => ({ id: ids[i], intent }));
    return { feed: ids.slice(1).map((ours) => ({ ours, theirs: ids[0], resolution: null })) };
  };
  await seedPeople(fake, async () => { throw new Error("no commit expected: every change exists"); });
  expect(writes).toEqual([]);
});

// Each seed repo's flows, by name, from its .cinder/flows/*.yml.
const flowsOf = (repo) => Object.keys(SEED_SOURCES[repo]).filter((p) => /^\.cinder\/flows\/[^/]+\.yml$/.test(p)).map((p) => p.slice(".cinder/flows/".length, -4));

it("the seed starts one run of each seeded flow", async () => {
  const names = Object.keys(SEED_SOURCES);
  const started = [];
  const fake = async (method, path) => {
    const [, , , repo, what, flow] = path.split("/");
    if (path === "/api/workers") return [{ online: true, kinds: ["develop", "flow"] }];
    if (path === "/api/me/models") return { source: "mine", providers: [{ source: "mine", status: "connected" }] };
    if (path === "/api/fleet") return { agents: [] };
    if (path === "/api/keystore") return { wanted: [] };
    if (method === "GET" && what === "flows") return flowsOf(repo).map((f) => ({ flow: f, on: parseFlow(SEED_SOURCES[repo][`.cinder/flows/${f}.yml`]).on }));
    if (method === "POST" && what === "flows") started.push(`${repo}/${flow}`);
    if (what === "flow-runs") return started.filter((r) => r.startsWith(`${repo}/`)).map((r) => ({ flow: r.split("/")[1], status: "done", steps: [], created_at: "9999" }));
    if (what === "watchtower") return method === "GET" ? [{ started_at: "9999", status: "done" }] : null;
    return method === "GET" ? [] : {};
  };
  await activity(fake, names, 0);
  expect(started.sort()).toEqual(names.flatMap((repo) => flowsOf(repo).map((f) => `${repo}/${f}`)).sort());
});

it("activity waits for the seed's CI run, started before it, to settle", async () => {
  let polls = 0;
  const fake = async (method, path) => {
    const [, , , repo, what] = path.split("/");
    if (path === "/api/workers") return [{ online: true, kinds: ["develop", "flow"] }];
    if (path === "/api/me/models") return { source: "mine", providers: [{ source: "mine", status: "connected" }] };
    if (path === "/api/fleet") return { agents: [] };
    if (what === "flow-runs") return repo === CI.repo ? [{ id: "seeded", flow: CI.flow, created_at: "0000", status: polls++ > 2 ? "done" : "running", steps: [] }] : [];
    if (what === "watchtower") return method === "GET" ? [{ started_at: "9999", status: "done" }] : null;
    return method === "GET" ? [] : {};
  };
  const out = await activity(fake, [CI.repo], 0);
  expect([polls > 3, out.runs.map((r) => [r.id, r.status])]).toEqual([true, [["seeded", "done"]]]);
});

// What a reset leaves of the judges: none.
const wipeJudges = () => env.DB.batch([env.DB.prepare("DELETE FROM judge_settings"), env.DB.prepare("DELETE FROM judge_config")]);
const judgesOf = async () => Promise.all(["svc-orders-go", "web-store", "infra-cloudflare-tf"].map(async (repo) => (await api("GET", `/api/repos/${repo}/judges`)).judges
  .map((j) => ({ repo, kind: j.kind, backend: j.backend, model_version: j.model_version, count: j.count, trusted: j.trusted, config: j.config }))
  .toSorted((a, b) => a.kind.localeCompare(b.kind))));

it("the seed's judges use the @2 clef series", async () => {
  await wipeJudges();
  await seed(api, undefined, []);
  for (const judges of await judgesOf()) {
    expect(judges.map((j) => [j.kind, j.backend, j.model_version, j.config.min_confidence, j.count, j.trusted])).toEqual([["collision", "clef-flash", "clef-flash@2", 0.7, 0, false],
      ["flake", "clef", "clef@2", 0.6, 0, false], ["guard", "clef-flash", "clef-flash@2", 0.6, 0, false], ["lease", "clef-flash", "clef-flash@2", 0.7, 0, false],
      ["resembles_vuln", "clef", "clef@2", 0.7, 0, false], ["risk", "clef", "clef@2", 0.6, 0, false], ["seam", "clef-flash", "clef-flash@2", 0.7, 0, false],
      ["split", "clef-flash", "clef-flash@2", 0.7, 0, false]]);
  }
}, 300000);

it("a re-run changes no judge", async () => {
  await wipeJudges();
  await seed(api, undefined, []);
  const before = await judgesOf();
  expect(before.flat()).toHaveLength(24);
  await seed(api, undefined, []);
  expect(await judgesOf()).toEqual(before);
}, 300000);

// What a reset leaves of the managed pools: none.
const wipePools = () => env.DB.batch([env.DB.prepare("DELETE FROM pool_settings"), env.DB.prepare("DELETE FROM worker_pools")]);
const managed = async () => (await api("GET", "/api/workers/pools")).filter((p) => ["build", "toolchains"].includes(p.name))
  .map((p) => ({ id: p.id, name: p.name, size: p.size, min: p.min, max: p.max, kinds: p.kinds, labels: p.labels }));

it("after a reset the seed creates the build and toolchains pools", async () => {
  await wipePools();
  await seed(api, undefined, []);
  expect(await managed()).toMatchObject([
    { name: "build", size: "basic", min: 0, max: 12, labels: [] },
    { name: "toolchains", size: "standard-2", min: 0, max: 4, labels: ["linux", "full-image"] }]);
}, 300000);

it("a re-run with both pools present changes no pool", async () => {
  await wipePools();
  await seed(api, undefined, []);
  const before = await managed();
  expect(before).toHaveLength(2);
  await seed(api, undefined, []);
  expect(await managed()).toEqual(before);
}, 300000);

it("after the seed each repo has a passing run for every flow except the one marked as a deliberate failure", async () => {
  // The toolchains pool runs the Go and Terraform repos' flows; terraform init downloads its providers from these hosts.
  await wipePools();
  await seed(api, undefined, []);
  const toolchains = (await api("GET", "/api/workers/pools")).find((p) => p.name === "toolchains");
  expect(toolchains.egress_allow).toEqual(expect.arrayContaining(["registry.terraform.io", "github.com", "release-assets.githubusercontent.com"]));
  // Each flow run as a pool runs it: a step fails when it needs a secret a dry run lacks, uses an action no runner
  // executes, or is the step its flow file marks as the deliberate failure.
  const runOf = (repo, flow) => {
    const text = SEED_SOURCES[repo][`.cinder/flows/${flow}.yml`];
    const marked = text.match(/# Deliberate failure\b.*\n\s*([\w-]+):/)?.[1];
    const steps = parseFlow(text).steps.map((s) => ({ name: s.name, status: s.secrets?.length || s.uses || s.name === marked ? "failed" : "passed", missing_secrets: s.secrets ?? [] }));
    return { repo, flow, id: `${repo}-${flow}`, created_at: "9999", status: steps.some((s) => s.status === "failed") ? "failed" : "done", steps };
  };
  const runs = [];
  const fake = async (method, path) => {
    const [, , , repo, what, flow] = path.split("/");
    if (path === "/api/workers") return [{ online: true, kinds: ["develop", "flow"] }];
    if (path === "/api/me/models") return { source: "mine", providers: [{ source: "mine", status: "connected" }] };
    if (path === "/api/fleet") return { agents: [{ runs_24h: 1 }] };
    if (path.startsWith("/api/changes/")) return { state: "merged", review: { p: 0.1 } };
    if (what === "issues") return [{ number: 1, state: "open", title: "A gap" }];
    if (method === "POST" && what === "changes") return { id: `change-${repo}` };
    if (method === "GET" && what === "flows") return flowsOf(repo).map((f) => ({ flow: f }));
    if (method === "POST" && what === "flows") runs.push(runOf(repo, flow));
    if (what === "flow-runs") return runs.filter((r) => r.repo === repo);
    if (what === "watchtower") return method === "GET" ? [{ started_at: "9999", status: "done" }] : null;
    return method === "GET" ? [] : {};
  };
  const out = await activity(fake, Object.keys(SEED_SOURCES), 0);
  expect(out.failures).toEqual([]);
  expect(out.runs.map((r) => `${r.repo}/${r.flow}`).sort()).toEqual(Object.keys(SEED_SOURCES).flatMap((repo) => flowsOf(repo).map((f) => `${repo}/${f}`)).sort());
  expect(out.runs.filter((r) => r.status !== "done").map((r) => [r.repo, r.flow, Object.keys(r.steps).filter((s) => r.steps[s] === "failed")]))
    .toEqual([[DELIBERATE.repo, DELIBERATE.flow, [DELIBERATE.step]]]);
}, 300000);

// What cinder-verify's scan finds in a seed repo's files: each planted artifacts_token, and the lockfile's (else the
// package.json's) and go.mod's dependencies.
const scanOf = (files) => ({
  secrets: Object.entries(files).flatMap(([path, text]) => text.split("\n").flatMap((l, i) => (/\bart_v1_[\w-]{20,}/.test(l) ? [{ rule: "artifacts_token", path, line: i + 1, fingerprint: `${path}#${i + 1}` }] : []))),
  deps: Object.entries(files).flatMap(([path, text]) => (path === "package-lock.json" ? Object.entries(JSON.parse(text).packages).filter(([k]) => k).map(([k, p]) => ["npm", k.split("node_modules/").at(-1), p.version])
    : path.endsWith("go.mod") ? [...text.matchAll(/^require (\S+) (\S+)/gm)].map((m) => ["go", m[1], m[2]])
    : path.endsWith("package.json") && !files["package-lock.json"] ? Object.entries(JSON.parse(text).devDependencies ?? {}).map(([n, v]) => ["npm", n, v]) : []))
    .map(([ecosystem, name, version]) => ({ ecosystem, name, version, license: "MIT", class: "permissive" })),
});
// OSV's answer: each repo's pinned package has its advisory.
const OSV = { "lodash@4.17.20": ["GHSA-35jh-r3h4-6jhm", "4.17.21"], "golang.org/x/text@v0.3.7": ["GO-2022-1059", "0.3.8"], "esbuild@0.24.2": ["GHSA-67mh-4wv8-2f99", "0.25.0"] };

it("after the seed each repo has findings of every kind, a scan, an SBOM and a denied egress host", async () => {
  await seeded();
  const real = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "https://api.osv.dev/v1/querybatch") {
      return Response.json({ results: JSON.parse(init.body).queries.map((q) => ({ vulns: OSV[`${q.package.name}@${q.version}`] ? [{ id: OSV[`${q.package.name}@${q.version}`][0] }] : [] })) });
    }
    if (String(url).startsWith("https://api.osv.dev/v1/vulns/")) {
      const [pinned, [id, fixed]] = Object.entries(OSV).find(([, [id]]) => String(url).endsWith(id));
      const name = pinned.slice(0, pinned.lastIndexOf("@"));
      return Response.json({ id, affected: [{ package: { name }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed }] }] }] });
    }
    return real(url, init);
  });
  onTestFinished(() => fetch.mockRestore());
  await seed(api, undefined, ["watchtower"]);
  const { token } = await api("POST", "/api/runners", { name: `scan-${crypto.randomUUID()}`, kinds: ["scan", "ingest-sarif", "index", "develop"], slots: 64 });
  // A scan runner ingests the seed's SARIF uploads, then scans each repo as Scan again queues it.
  for (let claim; (claim = await api("POST", "/api/work/claim", { kinds: ["ingest-sarif"], slots_free: 99 }, token));) {
    const results = JSON.parse(claim.payload.sarif).runs.flatMap((r) => r.results);
    await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done", findings: results.map((r) => ({ rule: r.ruleId, severity: "medium",
      file: r.locations[0].physicalLocation.artifactLocation.uri, line: r.locations[0].physicalLocation.region.startLine, fingerprint: `sha256:${r.ruleId}` })) }, token);
  }
  for (const repo of Object.keys(ADVISORIES)) await api("POST", `/api/repos/${repo}/watchtower/scans`);
  for (let claim; (claim = await api("POST", "/api/work/claim", { kinds: ["scan"], slots_free: 99 }, token));) {
    const repo = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(claim.job.repo_id).first("name");
    await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done", ...scanOf(SEED_SOURCES[repo]) }, token);
  }
  for (const repo of Object.keys(ADVISORIES)) {
    // An agent develops activity's change; its egress proxy denies the page the intent names when the agent's allowlist lacks it.
    const change = await api("POST", `/api/repos/${repo}/changes`, { intent: agentIntent(repo, "Bump the vulnerable dependency") });
    // The change waits for its target's index; a failed index job starts it from what is indexed.
    for (let index; (index = await api("POST", "/api/work/claim", { kinds: ["index"], slots_free: 99 }, token));) {
      await api("POST", `/api/work/jobs/${index.job.id}/report`, { status: "failed" }, token);
    }
    const develop = await api("POST", "/api/work/claim", { kinds: ["develop"], slots_free: 99 }, token);
    expect(develop.job.change_id).toBe(change.id);
    const host = new URL(change.intent.match(/https:\/\/[^\s)]+/)[0]).hostname;
    const denied = (develop.agent?.egress ?? develop.egress.allow).includes(host) ? {} : { [host]: 1 };
    await api("POST", `/api/work/jobs/${develop.job.id}/report`, { status: "failed", egress: { allowed: {}, denied } }, token);
  }
  for (const repo of Object.keys(ADVISORIES)) {
    const { findings, scans } = await api("GET", `/api/repos/${repo}/watchtower`);
    expect([...new Set(findings.map((f) => f.source))].sort(), repo).toEqual(["code", "dependency", "secret"]);
    expect(findings.filter((f) => f.source === "code").every((f) => f.line > 0), repo).toBe(true);
    expect(findings.find((f) => f.source === "dependency").rule, repo).toBe(ADVISORIES[repo]);
    expect(scans.map((s) => s.status), repo).toContain("passed");
    expect((await api("GET", `/api/repos/${repo}/sbom`)).components.length, repo).toBeGreaterThan(0);
    expect((await api("GET", `/api/repos/${repo}/egress`)).versions.flatMap((v) => v.denied.map((d) => d.host)), repo).toEqual(["osv.dev"]);
  }
}, 300000);

it("every seeded agent version runs on a tool-calling Workers AI model", async () => {
  // Only these two call tools and write files through opencode.
  const tools = ["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b"];
  for (const catalog of [[], ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/zai-org/glm-4.6", "@cf/qwen/qwen2.5-coder-32b-instruct", ...tools]]) {
    const locks = [];
    const fake = async (method, path) => (path === "/api/models/catalog" ? catalog.map((id) => ({ id, hosted: true })) : method === "GET" ? null : {});
    const push = async ({ lock }) => locks.push(lock);
    await seedAgents(fake, push);
    expect(locks.map((l) => `${l.name}@v${l.version}`)).toEqual(["developer@v2", "developer@v3", "dev-open@v1", "reviewer@v2", "resolver@v2"]);
    expect(locks.filter((l) => !tools.includes(l.model))).toEqual([]);
  }
});
