import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { onPushes } from "../src/pushes.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// Agent `name` v1 and v2, stable at v2 with egress `egress`; returns a POST to /api/agents/<name>/egress.
async function seed(name, egress) {
  const fake = fakeArtifacts();
  (await fake.create("cinder-agents")).files[`agents/${name}/prompt.md`] = "You are developer.";
  await env.DB.batch([
    ...[1, 2].map((v) => env.DB.prepare("INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES (?, ?, ?, 'claude-code', 'claude-opus-5-5', 'default', 'sha256:abc', '[]', '{\"max_cost_usd\":8,\"max_minutes\":120}')").bind(`agent/${name}/v${v}`, name, v)),
    env.DB.prepare("INSERT INTO agent_releases (name, version, egress, released_at) VALUES (?, 2, ?, '2026-10-08T00:00:00.000Z')").bind(name, JSON.stringify(egress)),
    env.DB.prepare("INSERT INTO channels (agent_name, channel, version) VALUES (?1, 'stable', 2), (?1, 'canary', 1)").bind(name),
  ]);
  return (body) => worker.fetch(new Request(`http://cinder.test/api/agents/${name}/egress`,
    { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
}

const releaseJobs = async (name) => (await env.DB.prepare("SELECT payload FROM jobs WHERE kind = 'release' AND json_extract(payload, '$.name') = ?")
  .bind(name).all()).results.map((r) => JSON.parse(r.payload));

it("allowing a host releases developer v(n+1) with the host in its allowlist on the given channel", async () => {
  const post = await seed("developer", ["pkg.go.dev"]);
  const res = await post({ host: "*.github.com", verdict: "allow", channel: "stable" });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ version: 3, channel: "stable", egress: ["pkg.go.dev", "*.github.com"] });
  const [job] = await releaseJobs("developer");
  expect(job).toEqual({ name: "developer", channel: "stable", draft: { harness: "claude-code", model: "claude-opus-5-5", effort: "default", tools: [],
    egress: ["pkg.go.dev", "*.github.com"], limits: { max_cost_usd: 8, max_minutes: 120 }, web: "raw", prompt: "You are developer." } });
  // The runner's tag push records v3 and points the job's channel at it.
  const { harness, model, effort, tools, egress, limits } = job.draft;
  const message = JSON.stringify({ name: "developer", version: 3, harness, model, effort, tools, egress, limits, prompt_hash: "sha256:def", egress_mode: "enforce" });
  await env.DB.prepare("UPDATE jobs SET status = 'claimed', lease_expires_at = ? WHERE kind = 'release' AND json_extract(payload, '$.name') = ?")
    .bind(new Date(Date.now() + 60000).toISOString(), "developer").run();
  await onPushes({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "cinder-agents" },
    payload: { ref: "refs/tags/agent/developer/v3", after: "abc", commits: [{ message }] } } }] }, env);
  expect(await env.DB.prepare("SELECT version FROM channels WHERE agent_name = 'developer' AND channel = 'stable'").first("version")).toBe(3);
  expect(JSON.parse(await env.DB.prepare("SELECT egress FROM agent_releases WHERE name = 'developer' AND version = 3").first("egress")))
    .toEqual(["pkg.go.dev", "*.github.com"]);
});

it("denying a host removes it from the next version's allowlist", async () => {
  const post = await seed("deny-dev", ["pkg.go.dev", "evil.example"]);
  const res = await post({ host: "evil.example", verdict: "deny", channel: "stable" });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ version: 3, channel: "stable", egress: ["pkg.go.dev"] });
  expect((await releaseJobs("deny-dev")).map((j) => [j.channel, j.draft.egress])).toEqual([["stable", ["pkg.go.dev"]]]);
});

it("an invalid host pattern answers 400 and releases nothing", async () => {
  const post = await seed("bad-dev", ["pkg.go.dev"]);
  for (const host of ["[bad", "a\\", "", "evil.example/x", 7]) {
    const res = await post({ host, verdict: "allow", channel: "stable" });
    expect(res.status, String(host)).toBe(400);
  }
  expect(await releaseJobs("bad-dev")).toEqual([]);
});

it("the allowlist editor's draft: GET shows the released egress until a draft saves one, and a bad host answers 400", async () => {
  await seed("list-dev", ["pkg.go.dev"]);
  const fake = fakeArtifacts();
  (await fake.create("cinder-agents")).files["agents/list-dev/prompt.md"] = "You are developer.";
  const call = (method, path, body) => worker.fetch(new Request(`http://cinder.test/api/agents/list-dev${path}`,
    { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
  const draftEgress = async () => (await (await call("GET", "")).json()).draft_egress;
  expect(await draftEgress()).toEqual(["pkg.go.dev"]);
  const draft = { harness: "claude-code", model: "claude-opus-5-5", effort: "default", tools: [], limits: { max_cost_usd: 8, max_minutes: 120 }, prompt: "p" };
  expect((await call("PUT", "/draft", { ...draft, egress: ["pkg.go.dev", "evil.example/x"] })).status).toBe(400);
  expect((await call("PUT", "/draft", { ...draft, egress: ["pkg.go.dev", "*.github.com"] })).status).toBe(200);
  expect(await draftEgress()).toEqual(["pkg.go.dev", "*.github.com"]);
});
