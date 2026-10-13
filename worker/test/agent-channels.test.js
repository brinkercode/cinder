import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";
import { validateAgentHistory } from "../src/api/contract.js";

// The risk judge answers medium and is trusted (below), so every verified change goes to agent review.
const AI = fakeClefAI(async () => ({ risk: { low: 0.05, medium: 0.9, high: 0.05 } }));

// A change in verifying with its verify job claimed by a runner that takes every job kind; reviewer and resolver
// have versions 1-3.
async function verifying(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake, AI },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake, AI }; });
  for (const agent of ["reviewer", "resolver"]) for (const v of [1, 2, 3]) {
    await env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES (?, ?, ?, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{}')").bind(`agent/${agent}/v${v}`, agent, v).run();
  }
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const judgment = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, 1)").bind(change.repo_id),
    env.DB.prepare("INSERT INTO judgments (id, repo_id, kind, backend, model_version, state_hash, question, answer, probability, made_at) VALUES (?, ?, 'risk', 'clef', 'clef@2', 'h', 'q', 'low', 0.1, '')").bind(judgment, change.repo_id),
    env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) VALUES (?, 'low', 1, '')").bind(judgment),
  ]);
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed') AND change_id <> ?").bind(change.id).run();
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop", "verify", "review", "resolve"] })).json()).token;
  const dev = (await (await call("/api/work/claim", { kinds: ["develop"] }, runner)).json()).job.id;
  expect((await (await call(`/api/work/jobs/${dev}/report`, { status: "done" }, runner)).json()).change.state).toBe("verifying");
  await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: change.id, result: "ok" }, { head: "h1" });
  const verify = (await (await call("/api/work/claim", { kinds: ["verify"] }, runner)).json()).job.id;
  return { call, change, runner, verify };
}

const stable = (call, agent, version) => call(`/api/agents/${agent}/channels/stable`, { version }, env.OWNER_TOKEN, "PUT");
const payloadOf = async (change, kind) => JSON.parse(await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = ? AND status = 'queued'")
  .bind(change.id, kind).first("payload"));

// Drives a verified change into a git conflict and claims its resolve job.
async function resolveJob(name) {
  const s = await verifying(name);
  return {
    ...s,
    run: async () => {
      // Verified and reviewed, it queues; the target moved and its converge hits a git conflict.
      await s.call(`/api/work/jobs/${s.verify}/report`, { status: "done" }, s.runner);
      const review = (await (await s.call("/api/work/claim", { kinds: ["review"] }, s.runner)).json()).job.id;
      expect((await (await s.call(`/api/work/jobs/${review}/report`, { status: "done" }, s.runner)).json()).change.state).toBe("in_queue");
      await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'converge', ?, 'queued', ?, '{}')")
        .bind(crypto.randomUUID(), s.change.repo_id, s.change.id, new Date().toISOString()).run();
      const conv = (await (await s.call("/api/runners", { name: "conv", kinds: ["converge"] })).json()).token;
      const converge = (await (await s.call("/api/work/claim", { kinds: ["converge"] }, conv)).json()).job.id;
      const conflict = { files: ["a.js"], hunks: [{ file: "a.js", ours: "x()", theirs: "y()" }] };
      expect((await (await s.call(`/api/work/jobs/${converge}/report`, { status: "failed", conflict }, conv)).json()).change.state).toBe("conflict");
      const payload = await payloadOf(s.change, "resolve");
      const claim = await (await s.call("/api/work/claim", { kinds: ["resolve"] }, s.runner)).json();
      return { payload, agent: claim.agent };
    },
  };
}

describe("agent channels", () => {
  it("promoting reviewer v3 to stable makes the next review job run reviewer v3", async () => {
    const { call, change, runner, verify } = await verifying("channels-review");
    expect((await stable(call, "reviewer", 2)).status).toBe(200);
    expect((await stable(call, "reviewer", 3)).status).toBe(200);
    expect((await (await call(`/api/work/jobs/${verify}/report`, { status: "done" }, runner)).json()).change.state).toBe("verifying");
    expect(await payloadOf(change, "review")).toMatchObject({ agent_version: "reviewer@v3" }); // the payload also carries the verified base sha
    const claim = await (await call("/api/work/claim", { kinds: ["review"] }, runner)).json();
    expect(claim.job.kind).toBe("review");
    expect(claim.agent).toMatchObject({ agent: "reviewer", version: 3 });
  });

  it("a resolve job records the resolver's stable version on its payload", async () => {
    const { call, run } = await resolveJob("channels-resolve");
    expect((await stable(call, "resolver", 2)).status).toBe(200);
    const { payload, agent } = await run();
    expect(payload.agent_version).toBe("resolver@v2");
    expect(agent).toMatchObject({ agent: "resolver", version: 2 });
  });

  it("rolling back resolver to v1 moves new resolve jobs to v1", async () => {
    const before = await resolveJob("channels-rollback-a");
    expect((await stable(before.call, "resolver", 3)).status).toBe(200);
    const { payload: kept } = await before.run();
    const after = await resolveJob("channels-rollback-b");
    expect((await stable(after.call, "resolver", 1)).status).toBe(200);
    const { payload, agent } = await after.run();
    expect(kept.agent_version).toBe("resolver@v3");
    expect(payload.agent_version).toBe("resolver@v1");
    expect(agent).toMatchObject({ agent: "resolver", version: 1 });
  });

  it("Rollback moves the stable channel. Runs in flight finish on the old version", async () => {
    const { call, change, run } = await resolveJob("channels-rollback-flight");
    expect((await stable(call, "resolver", 3)).status).toBe(200);
    const { agent } = await run();
    expect(agent).toMatchObject({ agent: "resolver", version: 3 });
    expect((await stable(call, "resolver", 1)).status).toBe(200);
    expect((await stable(call, "resolver", 1)).status).toBe(200);
    // The claimed resolve job keeps v3; stable now points at v1.
    const inFlight = await env.DB.prepare("SELECT status, payload FROM jobs WHERE change_id = ? AND kind = 'resolve'").bind(change.id).first();
    expect([inFlight.status, JSON.parse(inFlight.payload).agent_version]).toEqual(["claimed", "resolver@v3"]);
    const versions = await (await call("/api/agents/resolver/versions", undefined, env.OWNER_TOKEN, "GET")).json();
    expect(versions.find((v) => v.channel === "stable").version).toBe(1);
    const history = await (await call("/api/agents/resolver/history", undefined, env.OWNER_TOKEN, "GET")).json();
    expect(history.map((e) => validateAgentHistory(e).errors).flat()).toEqual([]);
    expect(history.filter((e) => e.kind !== "released").slice(0, 2).map(({ kind, version, by }) => ({ kind, version, by })))
      .toEqual([{ kind: "rolled_back", version: 1, by: "owner" }, { kind: "promoted", version: 3, by: "owner" }]);
  });
});
