import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { validateFlowArtifact, validateFlowRunTree, validateFlowTests } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts, refSha } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

// Six stages, 15 jobs: a two-step build job, a 2-leg node matrix and a 3-shard e2e job among them. Stages without
// needs follow file order.
const SEED = `name: release
on: [manual]
stages:
  check: { needs: [build] }
  test: { needs: [check] }
steps:
  install: { stage: build, job: build, run: "npm ci", needs: [] }
  compile: { stage: build, job: build, run: "npm run build", needs: [install] }
  image: { stage: build, run: "docker build .", needs: [] }
  lint: { stage: check, run: "npm run lint", needs: [compile] }
  typecheck: { stage: check, run: "npm run typecheck", needs: [compile] }
  audit: { stage: check, run: "npm audit", needs: [compile] }
  unit: { stage: test, run: "npm test", matrix: { node: [20, 22] }, needs: [lint] }
  e2e: { stage: test, run: "npm run e2e", shard: 3, needs: [lint] }
  package: { stage: package, run: "npm pack", needs: [unit, e2e] }
  stage: { stage: staging, run: "npm run deploy:staging", needs: [package] }
  smoke: { stage: staging, run: "npm run smoke", needs: [stage] }
  approve: { stage: release, run: "npm run approve", needs: [smoke] }
  ship: { stage: release, run: "npm run ship", needs: [approve] }
`;
const OLD = `name: old
on: [manual]
steps:
  lint: { stage: build, run: "npm run lint", needs: [] }
  test: { stage: build, run: "npm test", needs: [lint] }
  ship: { stage: deploy, deploy: production, needs: [test] }
`;

let priority = 1e9;
// A repo holding flows at s1, a BYO runner that takes flow jobs, and helpers to start a run and work its flow jobs.
async function flowRepo(name, flows, e = { ...env }) {
  const fake = fakeArtifacts();
  e.ARTIFACTS = fake;
  const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), e);
  const repo = await (await call("POST", "/api/repos", { name })).json();
  Object.assign(fake.repos.get(name), { commits: [{ sha: "s1" }], files: Object.fromEntries(Object.entries(flows).map(([f, text]) => [`.cinder/flows/${f}.yml`, text])) });
  await env.DB.prepare("INSERT INTO byo_pools (id, name, labels, created_at) VALUES (?, ?, '[]', '2026-10-08T00:00:00Z')").bind(`bp-${name}`, `${name}-pool`).run();
  await env.DB.prepare("INSERT INTO byo_pool_kinds (pool_id, kinds) VALUES (?, '[\"flow\"]')").bind(`bp-${name}`).run();
  const { token } = await (await call("POST", "/api/runners", { name: `${name}-lab`, kinds: ["flow"], pool: `${name}-pool` })).json();
  const start = async (flow) => (await call("POST", `/api/repos/${name}/flows/${flow}/runs`)).json();
  // Claims job id (it outranks every other queued job); work also reports status.
  const claim = async (id) => {
    await env.DB.prepare("INSERT INTO job_priorities (job_id, priority) VALUES (?, ?)").bind(id, priority++).run();
    expect((await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json()).job.id).toBe(id);
  };
  const work = async (id, status = "done") => {
    await claim(id);
    expect((await call("POST", `/api/work/jobs/${id}/report`, { status }, token)).status).toBe(200);
  };
  const queued = async (run) => (await env.DB.prepare("SELECT id, payload FROM jobs WHERE json_extract(payload, '$.run_id') = ? AND status = 'queued' ORDER BY id").bind(run).all())
    .results.map((j) => ({ id: j.id, ...JSON.parse(j.payload) }));
  const statuses = async (run) => Object.fromEntries((await env.DB.prepare("SELECT key, status FROM flow_jobs WHERE run_id = ?").bind(run).all()).results.map((j) => [j.key, j.status]));
  return { call, repo, token, start, claim, work, queued, statuses };
}

describe("flow runs", () => {
  it("starting a six-stage flow queues only the first stage's jobs, one jobs row per leg and shard", async () => {
    const { start, queued, statuses } = await flowRepo("fr-start", { release: SEED });
    const run = await start("release");
    expect(run).toMatchObject({ number: 1, status: "queued", wall_ms: 0 });
    const jobs = await queued(run.id);
    expect(jobs.map((j) => [j.key, j.steps.map((s) => s.name), j.steps.map((s) => s.needs)])).toEqual([
      ["build/build", ["install", "compile"], [[], ["install"]]], ["build/image", ["image"], [[]]],
    ]);
    expect(jobs[0]).toMatchObject({ run_id: run.id, sha: refSha("s1"), flow: "release", env: {}, secrets: [] });
    const all = await statuses(run.id);
    expect(Object.keys(all)).toHaveLength(15);
    expect(Object.values(all).every((s) => s === "queued")).toBe(true);
    expect((await start("release")).number).toBe(2);
  });

  it("when every job of a stage passes, the next stage's jobs are queued", async () => {
    const { start, work, queued } = await flowRepo("fr-next", { release: SEED });
    const run = await start("release");
    const [build, image] = await queued(run.id);
    await work(build.id);
    expect((await queued(run.id)).map((j) => j.key)).toEqual(["build/image"]);
    await work(image.id);
    expect((await queued(run.id)).map((j) => j.key)).toEqual(["check/lint", "check/typecheck", "check/audit"]);
    for (const j of await queued(run.id)) await work(j.id);
    expect((await queued(run.id)).map((j) => [j.key, j.leg ?? ""]).sort()).toEqual([
      ["test/e2e/1/3", "1/3"], ["test/e2e/2/3", "2/3"], ["test/e2e/3/3", "3/3"], ["test/unit/node 20", "node 20"], ["test/unit/node 22", "node 22"],
    ]);
  });

  it("a failed job marks the jobs of dependent stages skipped and fails the run", async () => {
    const { call, start, work, queued, statuses } = await flowRepo("fr-fail", { release: SEED });
    const run = await start("release");
    const [build, image] = await queued(run.id);
    await work(build.id, "failed");
    const after = await statuses(run.id);
    expect([after["build/build"], after["build/image"]]).toEqual(["failed", "queued"]);
    expect(Object.entries(after).filter(([k]) => !k.startsWith("build/")).every(([, s]) => s === "skipped")).toBe(true);
    expect((await queued(run.id)).map((j) => j.key)).toEqual(["build/image"]);
    await work(image.id);
    const tree = await (await call("GET", `/api/repos/fr-fail/flow-runs/${run.id}`)).json();
    expect(tree.stages.map((s) => s.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect([tree.status, typeof tree.finished_at]).toEqual(["failed", "string"]);
  });

  it("a run with 6 stages and 15 jobs including a 2-leg matrix and 3 shards round-trips through the tree route and passes validateFlowRunTree", async () => {
    const { call, start, work, queued } = await flowRepo("fr-tree", { release: SEED });
    const run = await start("release");
    for (let open = await queued(run.id); open.length; open = await queued(run.id)) for (const j of open) await work(j.id);
    const tree = await (await call("GET", `/api/repos/fr-tree/flow-runs/${run.id}`)).json();
    expect(validateFlowRunTree(tree).errors).toEqual([]);
    expect(tree.stages.map((s) => [s.id, s.jobs.length])).toEqual([["build", 2], ["check", 3], ["test", 5], ["package", 1], ["staging", 2], ["release", 2]]);
    expect(tree.stages[2].jobs.map((j) => j.leg)).toEqual(["node 20", "node 22", "1/3", "2/3", "3/3"]);
    const jobs = tree.stages.flatMap((s) => s.jobs);
    expect(jobs.every((j) => j.status === "passed" && j.instance === "byo" && j.attempt === 1 && j.started_at && j.finished_at)).toBe(true);
    expect(tree.stages[0].jobs[0].steps.map((s) => [s.idx, s.name])).toEqual([[0, "install"], [1, "compile"]]);
    expect(tree).toMatchObject({ number: 1, status: "passed", trigger: "manual", actor: "owner", annotations_count: { error: 0, warning: 0 } });
    expect(tree.wall_ms).toBe(Date.parse(tree.finished_at) - Date.parse(tree.started_at));
    expect(tree.sandbox_ms).toBe(jobs.reduce((t, j) => t + Date.parse(j.finished_at) - Date.parse(j.started_at), 0));
    expect(JSON.stringify(tree)).not.toContain("logs");
  });

  it("an old flow with no job keys runs unchanged", async () => {
    const { start, work, statuses } = await flowRepo("fr-old", { old: OLD });
    const run = await start("old");
    const { results } = await env.DB.prepare("SELECT id, payload FROM jobs WHERE repo_id = (SELECT id FROM repos WHERE name = 'fr-old')").all();
    expect(results.map((j) => j.id)).toEqual([run.id]);
    const payload = JSON.parse(results[0].payload);
    expect(payload).toMatchObject({ flow: "old", sha: refSha("s1"), ref: "main", trigger: "manual" });
    expect(payload.run_id).toBeUndefined();
    expect(payload.steps.map((s) => [s.name, s.needs])).toEqual([["lint", []], ["test", ["lint"]], ["ship", ["test"]]]);
    expect(await statuses(run.id)).toEqual({ "build/lint": "queued", "build/test": "queued", "deploy/ship": "queued" });
    await work(run.id);
    expect(await statuses(run.id)).toEqual({ "build/lint": "passed", "build/test": "passed", "deploy/ship": "passed" });
    expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE id = ?").bind(run.id).first("status")).toBe("passed");
  });

  it("the legacy step endpoint still records a step of a one-step job", async () => {
    const { call, token, start, statuses } = await flowRepo("fr-step", { old: OLD });
    const run = await start("old");
    await env.DB.prepare("INSERT INTO job_priorities (job_id, priority) VALUES (?, ?)").bind(run.id, priority++).run();
    expect((await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json()).job.id).toBe(run.id);
    expect((await call("POST", `/api/work/jobs/${run.id}/steps`, { name: "lint", status: "passed", logs: "0 problems\n" }, token)).status).toBe(204);

    const step = await env.DB.prepare("SELECT job_key, idx, status, finished_at FROM flow_step_runs WHERE run_id = ? AND name = 'lint'").bind(run.id).first();
    expect(step).toMatchObject({ job_key: "build/lint", idx: 0, status: "passed" });
    expect(await (await env.LOGS.get(`flows/${run.id}/lint`)).text()).toBe("0 problems\n");
    expect(await statuses(run.id)).toEqual({ "build/lint": "passed", "build/test": "running", "deploy/ship": "running" });
    const tree = await (await call("GET", `/api/repos/fr-step/flow-runs/${run.id}`)).json();
    expect(tree.stages[0].jobs[0].steps).toMatchObject([{ idx: 0, name: "lint", status: "passed" }]);
  });

  it("the run list returns number, stage statuses and wall_ms without per-run queries", async () => {
    const queries = [];
    const e = { ...env };
    e.DB = new Proxy(env.DB, { get: (db, k) => (k === "prepare" ? (q) => { queries.push(q); return db.prepare(q); } : db[k].bind(db)) });
    const { call, start, work, queued } = await flowRepo("fr-list", { release: SEED, old: OLD }, e);
    const list = async () => {
      queries.length = 0;
      const runs = await (await call("GET", "/api/repos/fr-list/flow-runs")).json();
      return [runs, queries.length];
    };
    const first = await start("release");
    const [, one] = await list();
    for (const j of await queued(first.id)) await work(j.id);
    await start("old");
    await start("release");
    const [runs, three] = await list();
    expect(three).toBe(one);
    expect(runs.map((r) => [r.flow, r.number])).toEqual([["release", 2], ["old", 1], ["release", 1]]);
    expect(runs[2].stages).toEqual([{ id: "build", status: "passed" }, { id: "check", status: "queued" }, { id: "test", status: "queued" },
      { id: "package", status: "queued" }, { id: "staging", status: "queued" }, { id: "release", status: "queued" }]);
    expect(runs[1].stages).toEqual([{ id: "build", status: "queued" }, { id: "deploy", status: "queued" }]);
    expect(runs[2].wall_ms).toBeGreaterThanOrEqual(0);
    expect(runs[0].wall_ms).toBe(0);
    expect(runs[1].steps.map((s) => s.name)).toEqual(["lint", "test", "ship"]);
  });

  it("a job status change publishes run.updated with stage and job statuses only", async () => {
    const sent = [];
    const e = { ...env };
    const { start, work, queued } = await flowRepo("fr-live", { release: SEED }, e);
    const run = await start("release");
    const [build] = await queued(run.id);
    e.REPO_DO = { idFromName: (n) => env.REPO_DO.idFromName(n), get: () => ({ broadcast: async (m) => sent.push(m) }) };
    await work(build.id, "failed");
    expect(sent.map((m) => m.kind)).toEqual(["run.updated", "run.updated"]);
    expect(Object.keys(sent[1]).sort()).toEqual(["at", "id", "kind", "repo", "stages"]);
    expect(sent[0]).toMatchObject({ repo: "fr-live", id: run.id, stages: [{ id: "build", status: "running" }, { id: "check", status: "queued" },
      { id: "test", status: "queued" }, { id: "package", status: "queued" }, { id: "staging", status: "queued" }, { id: "release", status: "queued" }] });
    expect(sent[1].stages[0].jobs).toEqual([{ key: "build/build", status: "failed" }, { key: "build/image", status: "queued" }]);
    expect(sent[1].stages.map(({ id, status }) => ({ id, status }))).toEqual([{ id: "build", status: "failed" }, { id: "check", status: "skipped" }, { id: "test", status: "skipped" },
      { id: "package", status: "skipped" }, { id: "staging", status: "skipped" }, { id: "release", status: "skipped" }]);
  });

  it("cancel marks queued and running jobs cancelled, and the runner's next heartbeat says cancel", async () => {
    const { call, token, start, claim, statuses } = await flowRepo("fr-cancel", { release: SEED });
    const run = await start("release");
    await claim(`${run.id}-0`);
    expect((await call("POST", `/api/repos/fr-cancel/flow-runs/${run.id}/cancel`)).status).toBe(202);
    expect(Object.values(await statuses(run.id)).every((s) => s === "cancelled")).toBe(true);
    expect(await (await call("POST", `/api/work/jobs/${run.id}-0/heartbeat`, {}, token)).json()).toMatchObject({ cancel: true });
    const tree = await (await call("GET", `/api/repos/fr-cancel/flow-runs/${run.id}`)).json();
    expect([tree.status, tree.stages[0].status, typeof tree.finished_at]).toEqual(["failed", "cancelled", "string"]);
  });

  it("rerun failed re-queues only failed and skipped jobs and keeps passed ones", async () => {
    const { call, token, start, claim, work, queued, statuses } = await flowRepo("fr-rerun", { release: SEED });
    const run = await start("release");
    const logged = async (id, status) => {
      await claim(id);
      expect((await call("POST", `/api/work/jobs/${id}/steps/0/log`, { seq: 1, lines: [{ at: "t", text: status }] }, token)).status).toBe(204);
      expect((await call("POST", `/api/work/jobs/${id}/report`, { status }, token)).status).toBe(200);
    };
    await logged(`${run.id}-0`, "failed");
    await logged(`${run.id}-1`, "done");
    const res = await call("POST", `/api/repos/fr-rerun/flow-runs/${run.id}/rerun`, { scope: "failed" });
    expect([res.status, await res.json()]).toEqual([201, { id: run.id, attempt: 2 }]);
    const after = await statuses(run.id);
    expect(after["build/image"]).toBe("passed");
    expect(Object.entries(after).filter(([k]) => k !== "build/image").every(([, s]) => s === "queued")).toBe(true);
    expect((await queued(run.id)).map((j) => [j.id, j.key])).toEqual([[`${run.id}-0-2`, "build/build"]]);
    const logs = await env.DB.prepare("SELECT job_key FROM flow_step_logs WHERE run_id = ?").bind(run.id).all();
    expect(logs.results.map((l) => l.job_key)).toEqual(["build/image"]);
    const attempts = await env.DB.prepare("SELECT key, attempt FROM flow_jobs WHERE run_id = ? AND key LIKE 'build/%' ORDER BY key").bind(run.id).all();
    expect(attempts.results).toEqual([{ key: "build/build", attempt: 2 }, { key: "build/image", attempt: 1 }]);
    await work(`${run.id}-0-2`);
    expect((await queued(run.id)).map((j) => j.key)).toEqual(["check/lint", "check/typecheck", "check/audit"]);
    expect((await call("POST", `/api/repos/fr-rerun/flow-runs/${run.id}/rerun`, { scope: "all" })).status).toBe(409);
  });

  it("rerun job re-queues one job by key", async () => {
    const { call, start, work, queued, statuses } = await flowRepo("fr-rerun-job", { release: SEED });
    const run = await start("release");
    for (let open = await queued(run.id); open.length; open = await queued(run.id)) for (const j of open) await work(j.id);
    expect((await call("POST", `/api/repos/fr-rerun-job/flow-runs/${run.id}/rerun`, { scope: "job" })).status).toBe(400);
    const res = await call("POST", `/api/repos/fr-rerun-job/flow-runs/${run.id}/rerun`, { scope: "job", key: "test/e2e/2/3" });
    expect([res.status, await res.json()]).toEqual([201, { id: run.id, attempt: 2 }]);
    expect((await queued(run.id)).map((j) => j.key)).toEqual(["test/e2e/2/3"]);
    expect(Object.entries(await statuses(run.id)).filter(([, s]) => s !== "passed")).toEqual([["test/e2e/2/3", "queued"]]);
    expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE id = ?").bind(run.id).first("status")).toBe("running");
  });

  it("cancel and rerun need repo.write", async () => {
    serveCerts();
    const { start } = await flowRepo("fr-perm", { release: SEED }, { ...ACCESS });
    const run = await start("release");
    await env.DB.batch(["viewer", "developer"].map((role) => env.DB.prepare("INSERT INTO person_roles VALUES (?, ?)").bind(`${role}@fr-perm.test`, role)));
    const post = async (role, action, body) => (await worker.fetch(new Request(`http://cinder.test/api/repos/fr-perm/flow-runs/${run.id}/${action}`,
      { method: "POST", headers: await as(`${role}@fr-perm.test`), body: body && JSON.stringify(body) }), ACCESS)).status;
    expect(await post("viewer", "cancel")).toBe(403);
    expect(await post("viewer", "rerun", { scope: "all" })).toBe(403);
    expect(await post("developer", "cancel")).toBe(202);
    expect(await post("developer", "rerun", { scope: "all" })).toBe(201);
    vi.restoreAllMocks();
  });

  it("tests posted by the runner are listed per suite with their failures", async () => {
    const { call, token, start, claim } = await flowRepo("fr-tests", { release: SEED });
    const run = await start("release");
    await claim(`${run.id}-0`);
    const post = (body, t = token) => call("POST", `/api/work/jobs/${run.id}-0/tests`, body, t);
    expect((await post({ suite: "unit.xml", passed: 3, failed: 1, skipped: 1, failures: ["orders.TestPatch"] })).status).toBe(204);
    expect((await post({ suite: "api.xml", passed: 2, failed: 0, skipped: 0, failures: [] })).status).toBe(204);
    expect((await post({ suite: "bad.xml", passed: -1, failed: 0, skipped: 0, failures: [] })).status).toBe(400);
    expect((await post({ suite: "x.xml", passed: 1, failed: 0, skipped: 0, failures: [] }, env.OWNER_TOKEN)).status).toBe(403);
    const tests = await (await call("GET", `/api/repos/fr-tests/flow-runs/${run.id}/tests`)).json();
    expect(validateFlowTests(tests).errors).toEqual([]);
    expect(tests).toEqual([
      { suite: "api.xml", job_key: "build/build", passed: 2, failed: 0, skipped: 0, failures: [] },
      { suite: "unit.xml", job_key: "build/build", passed: 3, failed: 1, skipped: 1, failures: ["orders.TestPatch"] },
    ]);
  });

  it("an uploaded artifact is listed and its download is byte-identical", async () => {
    const { call, token, start, claim } = await flowRepo("fr-artifacts", { release: SEED });
    const run = await start("release");
    await claim(`${run.id}-0`);
    const bytes = crypto.getRandomValues(new Uint8Array(60_000));
    const put = (name, body, length = String(body.length)) => worker.fetch(new Request(`http://cinder.test/api/work/jobs/${run.id}-0/artifacts/${name}`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Length": length }, body }), env);
    expect((await put("svc-orders-go", bytes)).status).toBe(204);
    expect((await put(".env", bytes)).status).toBe(400);
    const list = await (await call("GET", `/api/repos/fr-artifacts/flow-runs/${run.id}/artifacts`)).json();
    expect(list.map((a) => validateFlowArtifact(a).errors)).toEqual([[]]);
    expect(list[0]).toMatchObject({ name: "svc-orders-go", job_key: "build/build", size: 60_000, url: `/api/repos/fr-artifacts/flow-runs/${run.id}/artifacts/svc-orders-go` });
    expect(Date.parse(list[0].expires_at) - Date.now()).toBeGreaterThan(29 * 864e5);
    const got = await call("GET", list[0].url);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    expect((await call("GET", `/api/repos/fr-artifacts/flow-runs/${run.id}/artifacts/missing`)).status).toBe(404);
  });
});
