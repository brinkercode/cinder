import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flowYaml, parseFlow, validateFlow, validateFlowList, validateFlowRun, validateFlowRunTree } from "../src/api/contract.js";
import { enqueueFlows, timeOutFlowJobs } from "../src/flows.js";
import worker from "../src/index.js";
import { fakeArtifacts, refSha, withRefs } from "./fakes/artifacts.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";

const FLOW = `name: release
on: [manual]
steps:
  lint: { stage: build, run: "npm run lint", needs: [] }
  test: { stage: build, run: "npm test", needs: [lint] }
  ship: { stage: deploy, deploy: production, needs: [test] }
`;

describe("flow runs", () => {
  it("a manual run executes on a worker and shows each step's status and logs", async () => {
    const fake = fakeArtifacts();
    const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
      { ...env, ARTIFACTS: fake },
    );
    await call("POST", "/api/repos", { name: "flow-run" });
    Object.assign(fake.repos.get("flow-run"), { commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": FLOW } });
    const { token } = await (await call("POST", "/api/runners", { name: "flow-lab", kinds: ["flow"] })).json();

    const started = await call("POST", "/api/repos/flow-run/flows/release/runs");
    expect(started.status).toBe(201);
    const run = await started.json();
    expect(run.steps.map((s) => `${s.name}:${s.status}`)).toEqual(["lint:queued", "test:queued", "ship:queued"]);

    const { job, payload } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    expect({ id: job.id, kind: job.kind, sha: payload.sha, steps: payload.steps.map((s) => s.needs) }).toEqual({ id: run.id, kind: "flow", sha: refSha("s1"), steps: [[], ["lint"], ["test"]] });
    for (const [name, status, logs] of [["lint", "passed", "0 problems\n"], ["test", "failed", "1 failing\n"], ["ship", "skipped", ""]]) {
      expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name, status, logs }, token)).status).toBe(204);
    }
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "lint", status: "passed" })).status).toBe(403);
    await call("POST", `/api/work/jobs/${job.id}/report`, { status: "failed" }, token);

    const shown = await (await call("GET", `/api/repos/flow-run/flow-runs/${run.id}`)).json();
    expect(validateFlowRun(shown).errors).toEqual([]);
    expect({ status: shown.status, steps: shown.steps.map(({ name, status, logs }) => [name, status, logs]) }).toEqual({
      status: "failed", steps: [["lint", "passed", "0 problems\n"], ["test", "failed", "1 failing\n"], ["ship", "skipped", ""]],
    });
  });

  it("the D1 row holds a key and the R2 fake holds the text: flow_steps.logs", async () => {
    const fake = fakeArtifacts();
    const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
      { ...env, ARTIFACTS: fake },
    );
    await call("POST", "/api/repos", { name: "flow-r2" });
    Object.assign(fake.repos.get("flow-r2"), { commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": FLOW } });
    const { token } = await (await call("POST", "/api/runners", { name: "flow-r2-lab", kinds: ["flow"] })).json();
    const run = await (await call("POST", "/api/repos/flow-r2/flows/release/runs")).json();
    const { job } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "lint", status: "passed", logs: "0 problems\n" }, token)).status).toBe(204);

    const row = await env.DB.prepare("SELECT logs FROM flow_steps WHERE job_id = ? AND name = 'lint'").bind(job.id).first();
    expect(row.logs).toBe(`flows/${job.id}/lint`);
    expect(await (await env.LOGS.get(row.logs)).text()).toBe("0 problems\n");
    const shown = await (await call("GET", `/api/repos/flow-r2/flow-runs/${run.id}`)).json();
    expect(shown.steps.map((s) => s.logs)).toEqual(["0 problems\n", "", ""]);
  });
});

describe("step secrets", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("a step's secrets round-trip through parseFlow and flowYaml and pass validateFlow", () => {
    const f = parseFlow("name: infra\non: [manual]\nsteps:\n  aws: { stage: deploy, run: \"terraform apply\", secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY], needs: [] }\n");
    expect(f.steps[0].secrets).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect(parseFlow(flowYaml(f))).toEqual(f);
    expect(validateFlow(f).errors).toEqual([]);
    expect(validateFlow({ ...f, steps: [{ ...f.steps[0], secrets: ["aws-key"] }] }).errors).toEqual([expect.stringContaining("steps.aws.secrets")]);
  });

  it("a step report with missing_secrets is stored and listed on the flow run", async () => {
    const fake = fakeArtifacts();
    const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
      { ...env, ARTIFACTS: fake },
    );
    await call("POST", "/api/repos", { name: "flow-secret" });
    Object.assign(fake.repos.get("flow-secret"), { commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": FLOW.replace("needs: [test] }", "secrets: [AWS_KEY], needs: [test] }") } });
    const { token } = await (await call("POST", "/api/runners", { name: "flow-secret-lab", kinds: ["flow"] })).json();
    await call("POST", "/api/repos/flow-secret/flows/release/runs");
    const { job, payload } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    expect(payload.steps.map((s) => s.secrets)).toEqual([undefined, undefined, ["AWS_KEY"]]);
    const report = (missing) => call("POST", `/api/work/jobs/${job.id}/steps`, { name: "ship", status: "failed", logs: "missing secret AWS_KEY: save it in Keystore\n", missing_secrets: missing }, token);
    expect((await report(["bad name"])).status).toBe(400);
    expect((await report(["AWS_KEY"])).status).toBe(204);

    const [shown] = await (await call("GET", "/api/repos/flow-secret/flow-runs")).json();
    expect(validateFlowRun(shown).errors).toEqual([]);
    expect(shown.steps.map((s) => [s.name, s.status, s.missing_secrets])).toEqual([["lint", "running", []], ["test", "running", []], ["ship", "failed", ["AWS_KEY"]]]);
  });

  it("run list lists missing secrets of every step in a job", async () => {
    const fake = fakeArtifacts();
    const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
      { ...env, ARTIFACTS: fake },
    );
    await call("POST", "/api/repos", { name: "flow-job-secrets" });
    Object.assign(fake.repos.get("flow-job-secrets"), { commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": `name: release
on: [manual]
steps:
  install: { stage: build, job: build, run: "npm ci", secrets: [NPM_TOKEN], needs: [] }
  compile: { stage: build, job: build, run: "npm run build", secrets: [AWS_KEY, NPM_TOKEN], needs: [install] }
` } });
    const { token } = await (await call("POST", "/api/runners", { name: "flow-job-secrets-lab", kinds: ["flow"] })).json();
    await call("POST", "/api/repos/flow-job-secrets/flows/release/runs");
    const { job } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "install", status: "failed", missing_secrets: ["NPM_TOKEN"] }, token)).status).toBe(204);
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "compile", status: "failed", missing_secrets: ["AWS_KEY", "NPM_TOKEN"] }, token)).status).toBe(204);

    const [shown] = await (await call("GET", "/api/repos/flow-job-secrets/flow-runs")).json();
    expect(validateFlowRun(shown).errors).toEqual([]);
    expect(shown.steps.map((s) => [s.name, s.missing_secrets])).toEqual([["build", ["AWS_KEY", "NPM_TOKEN"]]]);
  });

  it("a job's missing secrets include every step's", async () => {
    const fake = fakeArtifacts();
    const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
      { ...env, ARTIFACTS: fake },
    );
    await call("POST", "/api/repos", { name: "flow-skipped-secrets" });
    Object.assign(fake.repos.get("flow-skipped-secrets"), { commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": `name: release
on: [manual]
steps:
  one: { stage: build, job: build, run: "true", secrets: [QA_NOPE_ONE], needs: [] }
  two: { stage: build, job: build, run: "true", secrets: [QA_NOPE_THREE], needs: [one] }
` } });
    const { token } = await (await call("POST", "/api/runners", { name: "flow-skipped-secrets-lab", kinds: ["flow"] })).json();
    await call("POST", "/api/repos/flow-skipped-secrets/flows/release/runs");
    const { job } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "one", status: "failed", missing_secrets: ["QA_NOPE_ONE"] }, token)).status).toBe(204);
    // The runner skips "two" before asking for its secrets, so it reports none.
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "two", status: "skipped", logs: "needs one, which did not pass" }, token)).status).toBe(204);

    const [shown] = await (await call("GET", "/api/repos/flow-skipped-secrets/flow-runs")).json();
    expect(shown.steps.map((s) => [s.name, s.missing_secrets])).toEqual([["build", ["QA_NOPE_ONE", "QA_NOPE_THREE"]]]);
  });

  it("a flow job still receives its scoped secret", async () => {
    const fake = fakeArtifacts();
    const cf = fakeCloudflare();
    vi.stubGlobal("fetch", withRefs(cf.fetch));
    const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
      { ...env, ARTIFACTS: fake, ...cf.env },
    );
    await call("POST", "/api/repos", { name: "flow-scoped" });
    Object.assign(fake.repos.get("flow-scoped"), { commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": FLOW.replace("needs: [test] }", "secrets: [AWS_KEY], needs: [test] }") } });
    expect((await call("POST", "/api/keystore", { name: "AWS_KEY", kind: "flow_secret", scope: "repo", repo: "flow-scoped", owner: "ana@x.dev", value: "aws-s3cret" })).status).toBe(201);
    const { token } = await (await call("POST", "/api/runners", { name: "flow-scoped-lab", kinds: ["flow"] })).json();
    await call("POST", "/api/repos/flow-scoped/flows/release/runs");
    const { job, payload } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    expect(payload.steps.at(-1).secrets).toEqual(["AWS_KEY"]);
    expect(await (await call("GET", `/api/work/jobs/${job.id}/secrets/AWS_KEY`, null, token)).json()).toEqual({ value: "aws-s3cret" });
  });
});

describe("flow step logs", () => {
  it("reportStep stores no token-shaped string", async () => {
    const fake = fakeArtifacts();
    const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
      { ...env, ARTIFACTS: fake },
    );
    await call("POST", "/api/repos", { name: "flow-mask" });
    Object.assign(fake.repos.get("flow-mask"), { commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": FLOW } });
    const { token } = await (await call("POST", "/api/runners", { name: "flow-mask-lab", kinds: ["flow"] })).json();
    const run = await (await call("POST", "/api/repos/flow-mask/flows/release/runs")).json();
    const { job } = await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json();
    const logs = "remote https://x:art_v2_abc123?expires=1767225600@git\nsk-proj-abcdefghij0123456789\nghp_abcdefghijklmnopqrstuvwxyz0123456789\nAKIAIOSFODNN7EXAMPLE\n";
    expect((await call("POST", `/api/work/jobs/${job.id}/steps`, { name: "lint", status: "passed", logs }, token)).status).toBe(204);

    const shown = await (await call("GET", `/api/repos/flow-mask/flow-runs/${run.id}`)).json();
    expect(shown.steps[0].logs).toBe("remote https://x:***@git\n***\n***\n***\n");
  });
});

describe("flow run list", () => {
  it("a repo's Flows page lists its flow runs, newest first", async () => {
    const fake = fakeArtifacts();
    const call = (method, path, body) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
    await call("POST", "/api/repos", { name: "flow-list" });
    expect(await (await call("GET", "/api/repos/flow-list/flow-runs")).json()).toEqual([]);
    Object.assign(fake.repos.get("flow-list"), { commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": FLOW } });
    const first = await (await call("POST", "/api/repos/flow-list/flows/release/runs")).json();
    const second = await (await call("POST", "/api/repos/flow-list/flows/release/runs")).json();

    const runs = await (await call("GET", "/api/repos/flow-list/flow-runs")).json();
    expect(runs.map((r) => validateFlowRun(r).errors)).toEqual([[], []]);
    expect(runs.map((r) => r.id)).toEqual([second.id, first.id]);
    expect((await call("GET", "/api/repos/nope/flow-runs")).status).toBe(404);
  });

  // The repo has only `branch`, so a run that reads any other branch finds no commits and 404s.
  async function runOn(repo, branch, body) {
    const fake = fakeArtifacts();
    const call = (method, path, b) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: b && JSON.stringify(b) }), { ...env, ARTIFACTS: fake });
    await call("POST", "/api/repos", { name: repo });
    Object.assign(fake.repos.get(repo), { branches: [branch], commits: [{ sha: "s1" }], files: { ".cinder/flows/release.yml": FLOW } });
    const res = await call("POST", `/api/repos/${repo}/flows/release/runs`, body);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    return JSON.parse(await env.DB.prepare("SELECT payload FROM jobs WHERE id = ?").bind(id).first("payload"));
  }

  it("startRun with ref develop reads the flow file from develop and records the run on develop", async () => {
    expect(await runOn("flow-dev", "develop", { ref: "develop" })).toMatchObject({ flow: "release", sha: refSha("s1"), ref: "develop" });
  });

  it("startRun without a ref still uses the default branch", async () => {
    expect(await runOn("flow-main", "main")).toMatchObject({ flow: "release", sha: refSha("s1"), ref: "main" });
  });

  it("a manual run of a protected branch name ignores a tag with that name", async () => {
    const { e, call } = await flowRepo("flow-tag", { release: FLOW });
    // Branch main is at s1 and tag main at tag1; a bare "main" resolves to the tag, as git ranks refs/tags above refs/heads.
    e.ARTIFACTS.repos.get("flow-tag").tags = { main: "tag1" };
    const run = await (await call("POST", "/api/repos/flow-tag/flows/release/runs", { ref: "main" })).json();
    expect(JSON.parse(await env.DB.prepare("SELECT payload FROM jobs WHERE id = ?").bind(run.id).first("payload"))).toMatchObject({ sha: refSha("s1"), ref: "main" });
  });
});

// A repo whose default branch holds `flows` at commit s1, a runner that takes flow jobs, and `call` as in the tests above.
async function flowRepo(name, flows) {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake, CF_ACCOUNT_ID: "acct", CF_DEPLOY_TOKEN: "deploy-token" };
  const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), e);
  const repo = await (await call("POST", "/api/repos", { name })).json();
  Object.assign(fake.repos.get(name), { commits: [{ sha: "s1" }], files: Object.fromEntries(Object.entries(flows).map(([f, text]) => [`.cinder/flows/${f}.yml`, text])) });
  const { token } = await (await call("POST", "/api/runners", { name: `${name}-lab`, kinds: ["flow"], slots: 8 })).json();
  return { e, call, repo, token };
}
// The worker claims run: flow jobs other tests left queued are set aside first, as their repos aren't in this test's fake.
async function claimRun(call, token, run) {
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'flow' AND status = 'queued' AND id <> ?").bind(run.id).run();
  expect((await (await call("POST", "/api/work/claim", { kinds: ["flow"], slots_free: 99 }, token)).json()).job.id).toBe(run.id);
}
const flowJobs = (repoId) => env.DB.prepare("SELECT payload FROM jobs WHERE repo_id = ? AND kind = 'flow'").bind(repoId).all().then((r) => r.results.map((j) => JSON.parse(j.payload)));

it("a run with a step cancelled by concurrency passes validateFlowRun", () => {
  const run = { id: "r1", flow: "cancel", sha: "a".repeat(40), status: "failed", created_at: new Date().toISOString(),
    steps: [{ name: "first", status: "passed", logs: "" }, { name: "second", status: "cancelled", logs: "" }] };
  expect(validateFlowRun(run).errors).toEqual([]);
});

describe("flow triggers and step types", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("flows.test.js: a push to the default branch with on: [push] inserts one flow job", async () => {
    const { e, repo } = await flowRepo("flow-push", {
      ci: "name: ci\non: [push]\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n",
      release: "name: release\non: [manual]\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n",
    });
    const pushed = (ref) => ({ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "flow-push" }, payload: { ref, before: "s0", after: "s1", commits: [] } } });
    // The topic push reads the branch policy from the repo's fake.
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("flow-push")), (i) => { i.env = { ...i.env, ARTIFACTS: e.ARTIFACTS }; });
    // cinder wrote main (a direct push to it is rolled back instead).
    await env.DB.prepare("INSERT INTO ref_writes (repo, ref, sha) VALUES ('flow-push', 'refs/heads/main', 's1')").run();
    await worker.queue({ messages: [pushed("refs/heads/main"), pushed("refs/heads/main"), pushed("refs/heads/topic")] }, e);

    expect((await flowJobs(repo.id)).map((p) => [p.flow, p.trigger, p.sha])).toEqual([["ci", "push", "s1"]]);
  });

  it("the cron handler enqueues a cron flow once per tick", async () => {
    vi.stubGlobal("fetch", withRefs(async () => new Response("{}", { status: 404 }))); // the cron's other jobs call out
    const { e, repo } = await flowRepo("flow-cron", { nightly: "name: nightly\non: [cron]\ncron: \"5 3 * * *\"\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n" });
    const tick = async (at) => {
      let done;
      worker.scheduled({ scheduledTime: Date.parse(at) }, e, { waitUntil: (p) => { done = p; } });
      await done.catch(() => {});
    };
    await tick("2026-10-06T03:10:00Z"); // 03:05 fell in (03:00, 03:10]
    await tick("2026-10-06T03:10:00Z"); // the same tick again
    await tick("2026-10-06T03:20:00Z");

    expect((await flowJobs(repo.id)).map((p) => [p.flow, p.trigger])).toEqual([["nightly", "cron"]]);
  });

  it("a flow with cron \"0 3 * * *\" gets a run when the scheduled handler fires at 03:00", async () => {
    vi.stubGlobal("fetch", withRefs(async () => new Response("{}", { status: 404 })));
    const { e, repo } = await flowRepo("flow-cron3", { daily: "name: daily\non: [cron]\ncron: \"0 3 * * *\"\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n" });
    let done;
    worker.scheduled({ scheduledTime: Date.parse("2026-10-12T03:00:00Z") }, e, { waitUntil: (p) => { done = p; } });
    await done;

    expect(await env.DB.prepare("SELECT flow, trigger FROM flow_runs WHERE id = ?").bind(`cron-${repo.id}-daily-1791774000000`).first()).toEqual({ flow: "daily", trigger: "cron" });
  });

  it("a run started by a push to a change records the change id and its ref", async () => {
    const { e, call, repo } = await flowRepo("flow-chg", { ci: "name: ci\non: [change]\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n" });
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("flow-chg")), (i) => { i.env = { ...i.env, ARTIFACTS: e.ARTIFACTS }; });
    const change = await (await call("POST", "/api/repos/flow-chg/changes", { intent: "Retry declined cards" })).json();
    Object.assign(e.ARTIFACTS.repos.get(change.fork), { commits: [{ sha: "s1" }], files: e.ARTIFACTS.repos.get("flow-chg").files });
    const push = { body: { type: "cf.artifacts.repo.pushed", source: { repoName: change.fork }, payload: { ref: "refs/heads/retry", before: "s0", after: "s1", commits: [] } } };
    await worker.queue({ messages: [push] }, e);

    expect(await env.DB.prepare("SELECT change_id, ref FROM flow_runs WHERE repo_id = ?").bind(repo.id).first()).toEqual({ change_id: change.id, ref: "retry" });
    const [run] = await (await call("GET", "/api/repos/flow-chg/flow-runs")).json();
    expect(run).toMatchObject({ ref: "retry", change: { id: change.id, title: "Retry declined cards" } });
    expect(validateFlowRun(run).errors).toEqual([]);
    const tree = await (await call("GET", `/api/repos/flow-chg/flow-runs/${run.id}`)).json();
    expect(tree).toMatchObject({ ref: "retry", change: { id: change.id, title: "Retry declined cards" } });
    expect(validateFlowRunTree(tree).errors).toEqual([]);
  });

  it("a cloudflare/workflow step calls the flow Workflow fake and reports wf-id · step n of m and each Workflow step", async () => {
    const calls = [];
    vi.stubGlobal("fetch", withRefs(async (url, init = {}) => {
      if (String(url).startsWith("https://api.cloudflare.com/")) calls.push([init.method ?? "GET", String(url), init.body && JSON.parse(init.body)]);
      return Response.json({ success: true, result: { status: "running", steps: [{ name: "a", end: "t" }, { name: "b" }, { name: "c" }] } });
    }));
    const { call, token } = await flowRepo("flow-wf", { infra: "name: infra\non: [manual]\nsteps:\n  provision: { stage: deploy, uses: cloudflare/workflow, workflow: provision-db, needs: [] }\n" });
    const run = await (await call("POST", "/api/repos/flow-wf/flows/infra/runs")).json();
    await claimRun(call, token, run);

    const res = await call("POST", `/api/work/jobs/${run.id}/steps/provision/start`, null, token);
    expect(res.status).toBe(200);
    const { status, logs } = await res.json();
    const [wf] = logs.split(" · ");
    expect({ status, logs }).toEqual({ status: "running", logs: `${wf} · step 1 of 3\na · done\nb · pending\nc · pending` });
    expect(calls.map(([m, u]) => `${m} ${u}`)).toEqual([
      "POST https://api.cloudflare.com/client/v4/accounts/acct/workflows/provision-db/instances",
      `GET https://api.cloudflare.com/client/v4/accounts/acct/workflows/provision-db/instances/${wf}`,
    ]);
    expect(calls[0][2]).toEqual({ instance_id: wf, params: { repo: "flow-wf", sha: refSha("s1"), flow: "infra", step: "provision" } });
    expect((await (await call("GET", `/api/repos/flow-wf/flow-runs/${run.id}`)).json()).steps[0]).toMatchObject({ status: "running", logs });
  });

  it("an approval step creates a needs row and blocks dependants", async () => {
    const { call, token } = await flowRepo("flow-gate", {
      ship: "name: ship\non: [manual]\nsteps:\n  gate: { stage: release, approval: maintainers, needs: [] }\n  prod: { stage: deploy, deploy: production, needs: [gate] }\n",
    });
    const run = await (await call("POST", "/api/repos/flow-gate/flows/ship/runs")).json();
    await claimRun(call, token, run);
    const start = (step) => call("POST", `/api/work/jobs/${run.id}/steps/${step}/start`, null, token);

    expect(await (await start("gate")).json()).toEqual({ status: "running", logs: "waiting on Needs you for maintainers" });
    const need = (await (await call("GET", "/api/needs")).json()).find((n) => n.repo === "flow-gate");
    expect(need).toMatchObject({ kind: "Flow approval", actions: ["Approve", "Reject"] });
    expect((await start("prod")).status).toBe(409);

    await call("POST", `/api/needs/${need.id}/resolve`, { action: "Approve" });
    expect(await (await start("gate")).json()).toEqual({ status: "passed", logs: "Approve on Needs you" });
    // Unblocked: the repo declares no production environment, so the deploy itself fails.
    expect(await (await start("prod")).json()).toEqual({ status: "failed", logs: "no branch environment production in flow-gate" });
  });

  it("the runs list counts runs waiting on an approval need and their median duration", async () => {
    const { call, token } = await flowRepo("flow-tiles", {
      ship: "name: ship\non: [manual]\nsteps:\n  gate: { stage: release, approval: maintainers, needs: [] }\n",
      ci: "name: ci\non: [manual]\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n",
    });
    const gated = await (await call("POST", "/api/repos/flow-tiles/flows/ship/runs")).json();
    await claimRun(call, token, gated);
    await call("POST", `/api/work/jobs/${gated.id}/steps/gate/start`, null, token);
    const done = await (await call("POST", "/api/repos/flow-tiles/flows/ci/runs")).json();
    await claimRun(call, token, done);
    await call("POST", `/api/work/jobs/${done.id}/steps`, { name: "test", status: "passed" }, token);
    await env.DB.prepare("UPDATE flow_step_runs SET started_at = '2026-10-08T10:00:00.000Z', finished_at = '2026-10-08T10:01:30.000Z' WHERE run_id = ?").bind(done.id).run();
    const list = async () => (await (await call("GET", "/api/repos/flow-tiles/flow-runs")).json()).map((r) => [r.flow, r.waiting_approval, r.step_ms]);

    expect(await list()).toEqual([["ci", false, 90000], ["ship", true, null]]);
    const need = (await (await call("GET", "/api/needs")).json()).find((n) => n.repo === "flow-tiles");
    await call("POST", `/api/needs/${need.id}/resolve`, { action: "Approve" });
    expect((await list())[1]).toEqual(["ship", false, null]);
  });
});

describe("step retries and flow concurrency", () => {
  // Claims the one queued flow job of repoId (others' set aside) and reports status; returns its id.
  const runJob = async (call, token, repoId, status) => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'flow' AND status = 'queued' AND repo_id <> ?").bind(repoId).run();
    const { job } = await (await call("POST", "/api/work/claim", { kinds: ["flow"], slots_free: 99 }, token)).json();
    await call("POST", `/api/work/jobs/${job.id}/report`, { status }, token);
    return job.id;
  };

  it("a step retries up to its retries", async () => {
    const { call, token, repo } = await flowRepo("flow-retry", { ci: "name: ci\non: [manual]\nsteps:\n  test: { stage: build, run: \"npm test\", retries: \"2\", needs: [] }\n" });
    const run = await (await call("POST", "/api/repos/flow-retry/flows/ci/runs")).json();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await runJob(call, token, repo.id, "failed"));
    expect(ids).toEqual([`${run.id}-0`, `${run.id}-0-2`, `${run.id}-0-3`]);
    const tree = await (await call("GET", `/api/repos/flow-retry/flow-runs/${run.id}`)).json();
    expect([tree.status, tree.stages[0].jobs[0].attempt]).toEqual(["failed", 3]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE repo_id = ? AND status = 'queued'").bind(repo.id).first("n")).toBe(0);
  });

  it("concurrency queue starts a run only after the flow's older run finished", async () => {
    const { call, token, repo } = await flowRepo("flow-queue", { ci: "name: ci\non: [manual]\nconcurrency: queue\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n" });
    const first = await (await call("POST", "/api/repos/flow-queue/flows/ci/runs")).json();
    const second = await (await call("POST", "/api/repos/flow-queue/flows/ci/runs")).json();
    const queued = () => env.DB.prepare("SELECT id FROM jobs WHERE repo_id = ? AND status = 'queued'").bind(repo.id).all().then((r) => r.results.map((j) => j.id));
    expect(await queued()).toEqual([`${first.id}-0`]);
    await runJob(call, token, repo.id, "done");
    expect(await queued()).toEqual([`${second.id}-0`]);
  });

  it("concurrency cancel cancels the flow's older unfinished run", async () => {
    const { call } = await flowRepo("flow-cancel", { ci: "name: ci\non: [manual]\nconcurrency: cancel\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n" });
    const first = await (await call("POST", "/api/repos/flow-cancel/flows/ci/runs")).json();
    await call("POST", "/api/repos/flow-cancel/flows/ci/runs");
    expect(await env.DB.prepare("SELECT status FROM flow_jobs WHERE run_id = ?").bind(first.id).first("status")).toBe("cancelled");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM job_cancels WHERE job_id = ?").bind(`${first.id}-0`).first("n")).toBe(1);
  });

  it("a change's new head cancels the check run of its older head", async () => {
    const { e, repo } = await flowRepo("flow-supersede", { check: "name: check\non: [change]\nsteps:\n  test: { stage: build, run: \"go test ./...\", needs: [] }\n" });
    await enqueueFlows(e, repo, repo.name, "s1", "change", "s1");
    await enqueueFlows(e, repo, repo.name, "s1", "change", "s2");
    const old = `change-${repo.id}-check-s1`;
    expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE id = ?").bind(old).first("status")).toBe("failed");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM job_cancels WHERE job_id = ?").bind(old).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE id = ?").bind(`change-${repo.id}-check-s2`).first("status")).toBe("queued");
  });

  it("a flow job running past its limit fails as timed out and its runner hears cancel", async () => {
    const { e, call, token } = await flowRepo("flow-timeout", { ci: "name: ci\non: [manual]\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n" });
    const run = await (await call("POST", "/api/repos/flow-timeout/flows/ci/runs")).json();
    await claimRun(call, token, run);
    await env.DB.prepare("UPDATE flow_jobs SET started_at = ? WHERE run_id = ?").bind(new Date(Date.now() - 3 * 3600_000).toISOString(), run.id).run();
    await timeOutFlowJobs(e);
    expect(await env.DB.prepare("SELECT status FROM flow_jobs WHERE run_id = ?").bind(run.id).first("status")).toBe("failed");
    expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE id = ?").bind(run.id).first("status")).toBe("failed");
    expect((await (await call("POST", `/api/work/jobs/${run.id}/heartbeat`, {}, token)).json()).cancel).toBe(true);
  });
});

describe("flow list for the rail", () => {
  it("the flows list returns each flow's triggers, last run and health", async () => {
    const { call } = await flowRepo("flow-rail", { release: FLOW, nightly: "name: nightly\non: [cron]\ncron: \"0 3 * * *\"\nsteps:\n  e2e: { stage: build, run: \"npm run e2e\", needs: [] }\n" });
    const run = await (await call("POST", "/api/repos/flow-rail/flows/release/runs")).json();
    const list = await (await call("GET", "/api/repos/flow-rail/flows?ref=main")).json();
    expect(list).toEqual([
      { flow: "release", head: "s1", trigger: "manual", on: ["manual"], health: { passed: 0, failed: 0, n: 0, trusted: false }, last_run: { id: run.id, status: "queued", number: 1 },
        file: { yaml: FLOW, def: parseFlow(FLOW), last_run_steps: {} } },
      { flow: "nightly", head: "s1", trigger: "cron", on: ["cron"], health: { passed: 0, failed: 0, n: 0, trusted: false } },
    ]);
  });

  it("the flows list response carries Server-Timing and reads flow files concurrently", async () => {
    const { e, call } = await flowRepo("flow-timing", { release: FLOW, nightly: FLOW.replace("release", "nightly") });
    const binding = e.ARTIFACTS.get, open = { now: 0, max: 0 };
    // Every readFile stays in flight for a tick, so reads that overlap count above one.
    e.ARTIFACTS.get = async (name) => {
      const r = await binding(name);
      return r && { ...r, readFile: async (a) => { open.max = Math.max(open.max, ++open.now); await new Promise((ok) => setTimeout(ok, 1)); open.now--; return r.readFile(a); } };
    };
    const res = await call("GET", "/api/repos/flow-timing/flows?ref=main");
    expect(res.headers.get("Server-Timing")).toMatch(/^head;dur=[\d.]+, tree;dur=[\d.]+, files;dur=[\d.]+$/);
    expect(validateFlowList(await res.json()).errors).toEqual([]);
    expect(open.max).toBe(2);
  });
});
