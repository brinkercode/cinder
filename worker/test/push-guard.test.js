import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

const AI = fakeClefAI(async () => ({ secret: 0, agent_instructions: 0, file_type: 0 }));

// A push to a change's fork, the guard job it queues claimed by a runner, and that runner's report.
async function pushAndGuard(name, report) {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake, AI };
  const call = (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), e);
  await call("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  await env.DB.prepare("DELETE FROM jobs WHERE change_id = ?").bind(change.id).run();
  const after = "b".repeat(40);
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: change.fork },
    payload: { ref: "refs/heads/main", before: "a".repeat(40), after, commits: [{ message: "x" }] } } }] }, e);
  const token = (await (await call("/api/runners", { name: "lab", kinds: ["guard"] })).json()).token;
  const claim = await (await call("/api/work/claim", { kinds: ["guard"] }, token)).json();
  // The runner clones the fork to scan the push, so the claim must carry a read token for it, and never a write token.
  expect(claim).toMatchObject({ job: { kind: "guard", change_id: change.id }, payload: { after }, token: null });
  expect(claim.read_token).toBeTruthy();
  expect(fake.calls.find((c) => c.method === "createToken" && c.args[0] === change.fork && c.args[1] === "read")).toBeTruthy();
  expect((await call(`/api/work/jobs/${claim.job.id}/report`, report, token)).status).toBe(200);
  const detail = await (await call(`/api/changes/${change.id}`, undefined, env.OWNER_TOKEN, "GET")).json();
  const { results: needs } = await env.DB.prepare("SELECT kind FROM needs WHERE change_id = ?").bind(change.id).all();
  return { detail, needs: needs.map((n) => n.kind) };
}

describe("push guard", () => {
  it("a guard that fails without findings is recorded on the change and queued once more", async () => {
    const { detail } = await pushAndGuard("pg-failed", { status: "failed", detail: "guard: git merge-base: fatal: Not a valid commit name" });
    expect(detail.events.find((e) => e.kind === "guard_failed")).toMatchObject({ result: "failed", reason: expect.stringContaining("Not a valid commit name") });
    const { results } = await env.DB.prepare("SELECT status, payload FROM jobs WHERE change_id = ? AND kind = 'guard'").bind(detail.id).all();
    expect(results.map((j) => [j.status, JSON.parse(j.payload).retry ?? false])).toEqual([["failed", false], ["queued", true]]);
    await env.DB.prepare("DELETE FROM jobs WHERE change_id = ?").bind(detail.id).run();
  });

  it("a pushed diff with a live secret token blocks the change with a guard result", async () => {
    const { detail, needs } = await pushAndGuard("pg-secret", { status: "done", diff: "+key = sk_live_x",
      findings: [{ rule: "stripe_secret_key", file: "pay.js", line: 1 }, { rule: "github_pat", file: "ci.sh", line: 2 }] });
    expect(detail.guard).toMatchObject({ status: "quarantined", reason: "deterministic: stripe_secret_key, github_pat" });
    expect(detail.blocked).toBe("Blocked: quarantined (deterministic: stripe_secret_key, github_pat)");
    expect(needs).toContain("Change quarantined");
  });

  it("a push adding a dependency raises Dependency needs approval and blocks merge", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ results: [{ vulns: [] }] }));
    onTestFinished(() => fetch.mockRestore());
    const { detail, needs } = await pushAndGuard("pg-deps", { status: "done", diff: "+\"left-pad\": \"1.3.0\"", findings: [],
      deps: [{ ecosystem: "npm", name: "left-pad", version: "1.3.0", license: "MIT", class: "permissive" }] });
    expect(detail.guard.status).toBe("clear");
    expect(detail.blocked).toBe("Blocked: new dependency left-pad 1.3.0 needs approval");
    expect(detail.blockers.map((b) => b.code)).toContain("dependency_unapproved");
    expect(needs).toContain("Dependency needs approval");
  });
});
