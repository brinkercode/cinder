import deployFlow from "../../seed/repos/web-store/.cinder/flows/deploy.yml?raw";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity } from "../../seed/activity.mjs";
import { client } from "../../seed/seed.mjs";
import { parseFlow } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { SEED_SOURCES } from "./fakes/seed.js";

const fake = fakeArtifacts();
const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), { ...env, ARTIFACTS: fake }) });
// While the fake runner works a job, activity's polls wait, so they never see a job half reported.
let working = null;
const polled = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: async (url, init) => {
  while (working) await working;
  // The owner on Mine with a connected provider, which a test can't connect for real.
  if (url.endsWith("/api/me/models")) return Response.json({ source: "mine", providers: [{ source: "mine", status: "connected" }] });
  return worker.fetch(new Request(url, init), { ...env, ARTIFACTS: fake });
} });

// A runner that does each job without running anything: an index finds no symbols, a develop job fails, a flow passes
// every step, a scan is clean.
async function fakeRunner(token, stop) {
  while (!stop.done) {
    const claim = await api("POST", "/api/work/claim", { kinds: ["index", "develop", "flow", "scan"], slots_free: 1 }, token);
    if (!claim) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    const { job, payload } = claim;
    let done;
    working = new Promise((r) => { done = r; });
    if (job.kind === "index") await api("PUT", `/api/work/repos/${payload.repo}/symbols/${payload.sha}`, [], token);
    if (job.kind === "flow") for (const s of payload.steps) await api("POST", `/api/work/jobs/${job.id}/steps`, { name: s.name, status: "passed" }, token);
    await api("POST", `/api/work/jobs/${job.id}/report`, { status: job.kind === "develop" ? "failed" : "done" }, token);
    working = null;
    done();
  }
}

describe("seed activity", () => {
  // Durable Objects read env.ARTIFACTS, not the fetch env.
  beforeAll(() => { env.ARTIFACTS = fake; });
  afterAll(() => { delete env.ARTIFACTS; });

  it("stops naming runner pools and the flow executor when no worker is online", async () => {
    // A managed pool counts as able to take jobs (it scales from zero), so the migrated default pool is capped at 0 here.
    await env.DB.prepare("UPDATE worker_pools SET max_count = 0").run();
    try {
      await expect(activity(api, [])).rejects.toThrow(/missing runner pools .*; the flow executor/);
    } finally {
      await env.DB.prepare("UPDATE worker_pools SET max_count = 4").run();
    }
  });

  it("one issue becomes a change that reaches a terminal state, and one flow run completes", async () => {
    await api("POST", "/api/repos", { name: "web-store" });
    Object.assign(fake.repos.get("web-store"), { commits: [{ sha: "e1" }], files: { ".cinder/flows/deploy.yml": deployFlow } });
    const issue = await api("POST", "/api/repos/web-store/issues", { title: "Expire short links after 30 days" });
    const stop = { done: false };
    const { token } = await api("POST", "/api/runners", { name: "fake", kinds: ["index", "develop", "flow", "scan"] });
    // A claim records the runner's heartbeat, so it is online before activity's preflight; no job is queued yet.
    expect(await api("POST", "/api/work/claim", { kinds: ["index", "develop", "flow", "scan"], slots_free: 1 }, token)).toBeNull();
    const runner = fakeRunner(token, stop);
    const out = await activity(polled, ["web-store"], 20).finally(() => { stop.done = true; });
    await runner;
    expect(out.settled).toBe(true);
    expect(out.changes.map(({ repo, issue: n, state }) => ({ repo, n, state }))).toEqual([{ repo: "web-store", n: issue.number, state: "failed" }]);
    expect((await api("GET", "/api/repos/web-store/issues/1")).changes).toEqual([{ id: out.changes[0].id, state: "failed" }]);
    expect(out.runs.map((r) => [r.flow, r.status, r.steps.build])).toEqual([["deploy", "done", "passed"]]);
    expect(out.scans).toEqual([{ repo: "web-store", status: "done" }]);
  });

  it("activity waits for the open changes the seed filed as for its own", async () => {
    const states = { filed: "leased", merged: "merged", draft: "draft" };
    const fakeApi = async (method, path) => {
      if (path === "/api/workers") return [{ online: true, kinds: ["develop", "flow"] }];
      if (path === "/api/me/models") return { source: "mine", providers: [{ source: "mine", status: "connected" }] };
      if (path === "/api/repos/web-store/changes") return Object.entries(states).map(([id, state]) => ({ id, state }));
      // A pool merges the filed change after the first poll.
      if (path === "/api/changes/filed") {
        const state = states.filed;
        states.filed = "merged";
        return { state };
      }
      if (path.endsWith("/watchtower/scans")) return [{ started_at: "9999", status: "done" }];
      if (path === "/api/fleet") return { agents: [] };
      return method === "GET" ? [] : {};
    };
    const out = await activity(fakeApi, ["web-store"], 0);
    expect(out.changes.map((c) => [c.id, c.issue, c.state])).toEqual([["filed", null, "merged"]]);
  });

  it("stops naming My model access when the owner's source is not mine", async () => {
    const credits = cinder({ "/api/me/models": { source: "credits", providers: [{ source: "credits", status: "connected" }, { source: "mine", status: "connected" }] } });
    await expect(activity(credits.api, REPOS, 0)).rejects.toThrow(/^activity: missing the owner's own model credential \(.*My model access, \/me\/models\)$/);
    const unconnected = cinder({ "/api/me/models": { source: "mine", providers: [{ source: "mine", status: "missing" }] } });
    await expect(activity(unconnected.api, REPOS, 0)).rejects.toThrow(/My model access/);
  });

  it("activity calls no promote route and starts no flow with a deploy step", async () => {
    const { api: fakeApi, calls } = cinder();
    await activity(fakeApi, REPOS, 0);
    expect(calls.filter(([, p]) => /promote|environments/.test(p))).toEqual([]);
    for (const [, p] of calls.filter(([m, p]) => m === "POST" && p.includes("/flows/"))) {
      const [, , , repo, , flow] = p.split("/");
      expect(parseFlow(SEED_SOURCES[repo][`.cinder/flows/${flow}.yml`]).steps.filter((s) => s.deploy || s.approval), p).toEqual([]);
    }
  });

  it("runs each seed repo's flows once each", async () => {
    const { api: fakeApi, calls } = cinder();
    const out = await activity(fakeApi, REPOS, 0);
    expect(calls.filter(([m, p]) => m === "POST" && p.includes("/flows/")).map(([, p]) => p)).toEqual([
      ...["build", "ci", "daily", "deploy"].map((f) => `/api/repos/web-store/flows/${f}/runs`),
      ...["check", "ci", "daily", "deploy"].map((f) => `/api/repos/svc-orders-go/flows/${f}/runs`),
      ...["check", "daily", "deploy", "destroy"].map((f) => `/api/repos/infra-cloudflare-tf/flows/${f}/runs`),
    ]);
    expect(out.failures).toEqual([]);
  });

  it("accepts svc-orders-go ci failing only at its integration job", async () => {
    const { api: fakeApi } = cinder({}, (repo, flow) => repo === "svc-orders-go" && flow === "ci"
      && { status: "failed", steps: [{ name: "unit", status: "passed" }, { name: "integration", status: "failed" }] });
    const out = await activity(fakeApi, REPOS, 0);
    expect(out.runs.find((r) => r.repo === "svc-orders-go" && r.flow === "ci").status).toBe("failed");
    expect(out.failures).toEqual([]);
  });

  it("fails naming the step when any other flow step fails", async () => {
    // plan-aws failing on its missing AWS secrets, and a step failing in another repo.
    const { api: fakeApi } = cinder({}, (repo, flow) => (repo === "infra-cloudflare-tf" && flow === "deploy"
      && { status: "failed", steps: [{ name: "plan", status: "passed" }, { name: "plan-aws", status: "failed", missing_secrets: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] }] })
      || (repo === "svc-orders-go" && flow === "deploy" && { status: "failed", steps: [{ name: "test", status: "passed" }, { name: "image", status: "failed", missing_secrets: [] }] }));
    const out = await activity(fakeApi, REPOS, 0);
    expect(out.failures).toEqual([
      "svc-orders-go flow deploy run svc-orders-go-deploy failed at step image:\nlog of image",
      "infra-cloudflare-tf flow deploy run infra-cloudflare-tf-deploy failed at step plan-aws:\nlog of plan-aws",
    ]);
  });

  it("fails naming each page that stays empty after the work settles", async () => {
    const { api: fakeApi } = cinder({ "/change-web-store": { state: "merged" }, "/api/fleet": { agents: [{ runs_24h: 0 }] },
      "/watchtower/scans": [{ started_at: "9999", status: "failed" }], "/flow-runs": [] });
    const out = await activity(fakeApi, REPOS, 0);
    expect(out.failures).toEqual(["activity: empty pages: Changes (a picked change has no judgment); Agents (no run in the last 24 h); "
      + "Watchtower (a repo's scan is not done); Flows (a repo has no settled run)"]);
  });
});

const REPOS = ["web-store", "svc-orders-go", "infra-cloudflare-tf"];

// A deployment that feeds every page: the owner on Mine, a runner online, a published release per repo, each change merged
// with a judgment, each scan done. over: a GET path suffix and its answer. run(repo, flow): a started run's {status, steps}, or false for done.
function cinder(over = {}, run = () => false) {
  const calls = [];
  const started = [];
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    const repo = path.split("/")[3];
    const answer = Object.keys(over).find((k) => method === "GET" && path.endsWith(k));
    if (answer) return over[answer];
    if (path === "/api/workers") return [{ online: true, kinds: ["develop", "flow"] }];
    if (path === "/api/me/models") return { source: "mine", providers: [{ source: "mine", status: "connected" }] };
    if (path === "/api/fleet") return { agents: [{ runs_24h: 1 }] };
    if (path.startsWith("/api/changes/")) return { state: "merged", review: { route: "auto", p: 0.1 } };
    if (path.endsWith("/issues")) return [{ number: 1, state: "open", title: "A gap" }];
    if (method === "POST" && path.endsWith("/changes")) return { id: `change-${repo}` };
    if (path.endsWith("/releases")) return [{ id: `${repo}-v1.1.0`, tag: "v1.1.0", sha: "s1", state: "published" }];
    if (path.endsWith("/watchtower/scans") && method === "GET") return [{ started_at: "9999", status: "done" }];
    if (path.endsWith("/flows")) return Object.keys(SEED_SOURCES[repo]).filter((p) => p.startsWith(".cinder/flows/")).sort().map((p) => ({ flow: p.slice(14, -4) }));
    if (method === "POST" && path.includes("/flows/")) started.push({ repo, flow: path.split("/")[5] });
    if (path.endsWith("/flow-runs")) {
      return started.filter((r) => r.repo === repo).map(({ flow }) => ({ status: "done", steps: [], ...run(repo, flow), flow, id: `${repo}-${flow}`, created_at: "9999" }));
    }
    if (path.includes("/flow-runs/")) return { steps: ["image", "plan-aws"].map((name) => ({ name, logs: `log of ${name}\n` })) };
    return method === "GET" ? [] : {};
  };
  return { api, calls };
}
