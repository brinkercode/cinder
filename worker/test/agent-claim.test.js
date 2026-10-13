import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

it("a develop claim carries the version's prompt and limits from its release lock", async () => {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  // The release job's tag push, its commit message the lock (runner release.go).
  const lock = { name: "prompted", version: 1, harness: "claude-code", model: "claude-opus-5-5", effort: "high", prompt_hash: "sha256:abc",
    prompt: "You are cinder's developer.", tools: ["bash"], limits: { max_cost_usd: 3, max_minutes: 120, max_repairs: 1 }, egress: [] };
  await env.DB.prepare("INSERT OR IGNORE INTO ref_writes (repo, ref, sha) VALUES ('cinder-agents', ?, ?)").bind("refs/tags/agent/prompted/v1", "d".repeat(40)).run();
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "cinder-agents" },
    payload: { ref: "refs/tags/agent/prompted/v1", before: "0".repeat(40), after: "d".repeat(40), commits: [{ id: "e".repeat(40), message: JSON.stringify(lock) }] } } }] }, env);
  expect((await call("/api/repos", { name: "agent-claim" })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("agent-claim")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  const change = await (await call("/api/repos/agent-claim/changes", { intent: "x" })).json();
  await env.DB.prepare("UPDATE jobs SET payload = ? WHERE change_id = ? AND kind = 'develop'").bind(JSON.stringify({ agent: "prompted@v1" }), change.id).run();
  const claim = await (await call("/api/work/claim", { kinds: ["develop"], slots_free: 1 }, runner)).json();
  expect(claim.job.change_id).toBe(change.id);
  expect(claim.agent).toMatchObject({ name: "prompted", version: 1, prompt: "You are cinder's developer.", limits: { max_spend: 3, max_repairs: 1 } });
});

it("a develop claim on a repo with repo-scoped secrets carries no secrets field", async () => {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  const lock = { name: "sealed", version: 1, harness: "claude-code", model: "claude-opus-5-5", effort: "high", prompt_hash: "sha256:abc",
    prompt: "p", tools: ["bash"], limits: { max_cost_usd: 3, max_minutes: 120, max_repairs: 1 }, egress: [] };
  await env.DB.prepare("INSERT OR IGNORE INTO ref_writes (repo, ref, sha) VALUES ('cinder-agents', ?, ?)").bind("refs/tags/agent/sealed/v1", "a".repeat(40)).run();
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "cinder-agents" },
    payload: { ref: "refs/tags/agent/sealed/v1", before: "0".repeat(40), after: "a".repeat(40), commits: [{ id: "b".repeat(40), message: JSON.stringify(lock) }] } } }] }, env);
  expect((await call("/api/repos", { name: "sealed-claim" })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("sealed-claim")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  await env.DB.prepare("INSERT INTO keystore_secrets (id, name, kind, scope, repo, owner, store_id, store_secret_id, store_secret_name, created_at) " +
    "VALUES ('ks-sealed', 'API_KEY', 'agent_secret', 'repo', 'sealed-claim', 'ana@x.dev', 's', 'i', 'n', '2026-10-08T00:00:00Z')").run();
  const runner = (await (await call("/api/runners", { name: "sealed-lab", kinds: ["develop"] })).json()).token;
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  const change = await (await call("/api/repos/sealed-claim/changes", { intent: "x" })).json();
  await env.DB.prepare("UPDATE jobs SET payload = ? WHERE change_id = ? AND kind = 'develop'").bind(JSON.stringify({ agent: "sealed@v1" }), change.id).run();
  const claim = await (await call("/api/work/claim", { kinds: ["develop"], slots_free: 1 }, runner)).json();
  expect(claim.job.change_id).toBe(change.id);
  expect(claim.agent.name).toBe("sealed");
  expect(claim.agent).not.toHaveProperty("secrets");
  expect(JSON.stringify(claim)).not.toContain("API_KEY");
});
