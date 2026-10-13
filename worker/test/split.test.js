import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { acceptSplit, judgeIntentSplit } from "../src/split.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET", headers: OWNER, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  await call("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "Add retries and rename the logger" })).json();
  const split = () => runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)), (i) => i.ctx.storage.get("split"));
  return { call, change, split, fake };
}

describe("split", () => {
  it("judgment recorded with kind split", async () => {
    const { change } = await setup("split-judge");
    await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'split', 'clef', 'clef@1')").bind(change.repo_id).run();
    const sent = [];
    const AI = fakeClefAI(async (model, body) => (sent.push(body), { mixed: 0.8 }));
    expect(await judgeIntentSplit({ ...env, AI }, change)).toEqual({ answer: "yes", p: 0.8, trusted: false });
    expect(sent[0].state).toEqual({ intent: change.intent });
    expect(sent[0].questions.mixed.kind).toBe("noul");
    const list = (await env.DB.prepare("SELECT * FROM judgments WHERE repo_id = ? AND kind = 'split'").bind(change.repo_id).all()).results;
    expect(list.map((j) => [j.kind, j.question, j.answer, j.probability]))
      .toEqual([["split", "Does this intent ask for more than one independent change?", "yes", 0.8]]);
  });

  it("accepted proposal creates stacked changes in order", async () => {
    const { change, fake } = await setup("split-accept");
    const parts = await acceptSplit({ ...env, ARTIFACTS: fake }, change, ["Add retries", "Rename the logger", "Log each retry"]);
    expect(parts.map((p) => [p.intent, p.state, p.stacked_on, p.target_branch])).toEqual([
      ["Add retries", "planned", null, change.target_branch],
      ["Rename the logger", "waiting", parts[0].id, change.target_branch],
      ["Log each retry", "waiting", parts[1].id, change.target_branch],
    ]);
    const { results } = await env.DB.prepare("SELECT change_id, json_extract(payload, '$.wait_for') AS wait_for FROM jobs WHERE kind = 'develop' AND change_id IN (?, ?, ?)")
      .bind(...parts.map((p) => p.id)).all();
    expect(results.map((j) => [j.change_id, j.wait_for]).sort()).toEqual([[parts[1].id, parts[0].id], [parts[2].id, parts[1].id]].sort());
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).get()).state).toBe("closed");
    await expect(acceptSplit({ ...env, ARTIFACTS: fake }, change, ["only one"])).rejects.toThrow("at least two");
  });

  it("a split part records its parent's requester", async () => {
    const { change, fake } = await setup("split-requester");
    const person = await env.DB.prepare("SELECT person FROM change_requesters WHERE change_id = ?").bind(change.id).first("person");
    expect(person).toBeTruthy();
    const parts = await acceptSplit({ ...env, ARTIFACTS: fake }, change, ["Add retries", "Rename the logger"]);
    const { results } = await env.DB.prepare("SELECT r.person FROM jobs j JOIN job_requesters r ON r.job_id = j.id WHERE j.change_id = ?").bind(parts[1].id).all();
    expect(results).toEqual([{ person }]);
    expect(await env.DB.prepare("SELECT person FROM change_requesters WHERE change_id = ?").bind(parts[0].id).first("person")).toBe(person);
  });

  it("a split part's develop job carries the pinned agent", async () => {
    const { change, fake } = await setup("split-agent");
    const parts = await acceptSplit({ ...env, ARTIFACTS: fake }, { ...change, agent_version: "developer@v3" }, ["Add retries", "Rename the logger"]);
    expect(parts.map((p) => p.agent_version)).toEqual(["developer@v3", "developer@v3"]);
    const agent = await env.DB.prepare("SELECT json_extract(payload, '$.agent') AS agent FROM jobs WHERE kind = 'develop' AND change_id = ?").bind(parts[1].id).first("agent");
    expect(agent).toBe("developer@v3");
  });
});
