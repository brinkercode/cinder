import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { leaseCandidates, predictLease } from "../src/lease.js";
import { fakeClefAI } from "./fakes/ai.js";

async function setup(id, symbols, owners = []) {
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', '')")
    .bind(id, id).run();
  await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'lease', 'clef', 'clef@1')").bind(id).run();
  await env.DB.batch([
    ...symbols.map(([path, name]) => env.DB.prepare("INSERT INTO symbols VALUES (?, 'sha1', ?, ?, 'function', 1, 2)").bind(id, path, name)),
    ...owners.map(([path, owner]) => env.DB.prepare("INSERT INTO owners VALUES (?, ?, ?, 1)").bind(id, path, owner)),
  ]);
}

describe("lease prediction", () => {
  it("candidate cap is respected", async () => {
    await setup("lease-cap", Array.from({ length: 250 }, (_, i) => [`src/retry${i}.js`, `retryFetch${i}`]));
    const sent = [];
    const AI = fakeClefAI(async (model, body) => (sent.push(body), {}));
    await predictLease({ ...env, AI }, "lease-cap", "sha1", "Add retry to fetch");
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0].questions)).toHaveLength(200);
    expect(sent[0].state.candidates).toHaveLength(200);
  });

  it("candidates share a term with the intent or are owners' areas", async () => {
    await setup("lease-terms", [["src/http.js", "retryFetch"], ["src/log.js", "logLine"]],
      [["src/http.js", "ann"], ["src/backoff.js", "ann"], ["src/log.js", "bob"]]);
    expect(await leaseCandidates(env.DB, "lease-terms", "sha1", "Retry the HTTP call"))
      .toEqual(["src/http.js#retryFetch", "src/http.js", "src/backoff.js"]);
  });

  it("judgments recorded with kind lease", async () => {
    await setup("lease-judge", [["src/http.js", "retryFetch"]]);
    const AI = fakeClefAI(async (model, body) => Object.fromEntries(Object.keys(body.questions).map((n) => [n, 0.9])));
    await predictLease({ ...env, AI }, "lease-judge", "sha1", "Retry fetch");
    const { results } = await env.DB.prepare("SELECT kind, question, answer, probability FROM judgments WHERE repo_id = 'lease-judge' ORDER BY question").all();
    expect(results).toEqual([
      { kind: "lease", question: "Will this intent modify src/http.js#retryFetch?", answer: "yes", probability: 0.9 },
    ]);
  });

  it("untrusted judge uses the 0.3 default", async () => {
    await setup("lease-default", [["x.js", "retryA"], ["x.js", "retryB"], ["x.js", "retryC"], ["x.js", "retryD"]]);
    const AI = fakeClefAI(async () => ({ c0: 0.31, c1: 0.3, c2: 0.29, c3: 0.9 }));
    expect(await predictLease({ ...env, AI }, "lease-default", "sha1", "retry")).toEqual(["x.js#retryA", "x.js#retryD"]);
  });

  it("keeps every candidate when no lease judge answers", async () => {
    await setup("lease-none", [["a.js", "retryA"]]);
    await env.DB.prepare("DELETE FROM judge_config WHERE repo_id = 'lease-none'").run();
    expect(await predictLease(env, "lease-none", "sha1", "retry")).toEqual(["a.js#retryA"]);
  });
});
