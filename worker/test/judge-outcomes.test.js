import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { flakeQuestion, scoreFlakes } from "../src/flakes.js";
import { judge, recordJudgment, scoreMerge, scoreSeam } from "../src/judgments.js";
import { SEAM_QUESTIONS } from "../src/seam.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

// Every judge answers yes / flaky with p 0.9.
const AI = fakeClefAI(async (model, { questions }) => Object.fromEntries(Object.entries(questions).map(([n, q]) =>
  [n, q.kind === "choice" ? { infra: 0.05, flaky: 0.9, code: 0.05 } : 0.9])));
const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, {
  method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify(body),
}), { ...env, ARTIFACTS: fakeArtifacts(), AI });

// A repo with two changes recorded as the scheduler would have left them.
async function twoChanges(name) {
  await call("/api/repos", { name });
  const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?1, ?3, 'main', 'verifying', ?4), (?2, ?3, 'main', 'waiting', ?4)")
    .bind(a, b, repo, new Date().toISOString()).run();
  return { repo, a, b };
}

const judgment = (repo, change, kind, question, answer) => recordJudgment(env.DB, {
  repo, change, kind, backend: "clef-flash", model: "clef-flash@2", state_hash: "sha256:01", question, answer, p: 0.9,
});
const outcomeOf = async (id) => env.DB.prepare("SELECT actual, correct FROM outcomes WHERE judgment_id = ?").bind(id).first();
// b collided with a on fetch.js#request, and cinder stacked it.
const collided = (repo, a, b) => env.DB.prepare("INSERT INTO collisions (id, repo_id, conflict_id, ours, theirs, symbol, kind, severity, p, message, action, " +
  "detected_at) VALUES (?, ?, 'k1', ?, ?, 'fetch.js#request', 'body', 'low', 1, '', 'Stacked', ?)").bind(crypto.randomUUID(), repo, b, a, new Date().toISOString()).run();
const wrote = (change, kind) => env.DB.prepare("INSERT INTO change_writes VALUES (?, 'fetch.js#request', ?)").bind(change, kind).run();

describe("judges earn trust in shadow", () => {
  it("a seam judgment is scored when its stacked change verifies", async () => {
    const { repo, a, b } = await twoChanges("jo-seam");
    await collided(repo, a, b);
    const id = await judgment(repo, b, "seam", SEAM_QUESTIONS.seam.prompt, "no");
    // Both changed request's signature: the overlap was a shared interface after all, so the "no" was wrong.
    await wrote(a, "signature");
    await wrote(b, "signature");
    await scoreSeam(env.DB, b, new Date().toISOString());
    expect(await outcomeOf(id)).toEqual({ actual: "yes", correct: 0 });
  });

  it("a flake judgment is scored by its retry on the same sha", async () => {
    const { repo, a } = await twoChanges("jo-flake");
    const passed = await judgment(repo, a, "flake", flakeQuestion("retry waits"), "flaky");
    const failed = await judgment(repo, a, "flake", flakeQuestion("totals round"), "flaky");
    const tests = [{ test: "retry waits", status: "pass" }, { test: "totals round", status: "fail" }];
    await env.DB.prepare("INSERT INTO verify_runs (job, repo, change_id, sha, attempt) VALUES ('j1', ?1, ?2, 'abc', 1), ('j2', ?1, ?2, 'abc', 2)").bind(repo, a).run();
    // The first attempt settles nothing; the rerun on the same sha does.
    await scoreFlakes(env.DB, a, "j1", tests);
    expect(await outcomeOf(passed)).toBeNull();
    await scoreFlakes(env.DB, a, "j2", tests);
    expect(await outcomeOf(passed)).toEqual({ actual: "flaky", correct: 1 });
    expect(await outcomeOf(failed)).toEqual({ actual: "code", correct: 0 });
  });

  it("a split judgment is scored no when its change merges whole", async () => {
    const { repo, a } = await twoChanges("jo-split");
    const id = await judgment(repo, a, "split", "Does this intent ask for more than one independent change?", "yes");
    await scoreMerge(env.DB, { id: a, repo_id: repo, intent: "add a retry option" }, new Date().toISOString());
    expect(await outcomeOf(id)).toEqual({ actual: "no", correct: 0 });
  });

  it("an open guard judgment is scored no when its change merges clean", async () => {
    const { repo, a } = await twoChanges("jo-guard");
    const id = await judgment(repo, a, "guard", "Does this diff add secret-like content (keys, tokens, passwords)?", "no");
    await scoreMerge(env.DB, { id: a, repo_id: repo, intent: "add a retry option" }, new Date().toISOString());
    expect(await outcomeOf(id)).toEqual({ actual: "no", correct: 1 });
  });

  it("an untrusted judge becomes trusted after min_outcomes shadow outcomes", async () => {
    const { repo, a, b } = await twoChanges("jo-trust");
    await env.DB.prepare("INSERT OR REPLACE INTO repo_trust (repo, min_outcomes) VALUES (?, 2)").bind(repo).run();
    const ask = () => judge({ ...env, AI }, repo, "seam", { intents: ["x", "y"], symbols: ["fetch.js#request"] }, SEAM_QUESTIONS, b);
    expect((await ask()).seam.trusted).toBe(false);
    await collided(repo, a, b);
    await wrote(b, "signature");
    await ask();
    await scoreSeam(env.DB, b, new Date().toISOString());
    expect((await ask()).seam).toMatchObject({ answer: "yes", trusted: true });
  });
});
