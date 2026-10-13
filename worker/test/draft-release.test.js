import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { onPushes } from "../src/pushes.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const DRAFT = { harness: "claude-code", model: "claude-opus-5-5", effort: "default", tools: [], egress: ["pkg.go.dev"],
  limits: { max_cost_usd: 8, max_minutes: 120 }, prompt: "You are developer.\nStack on leased symbols.\n" };

// Agent `name` v1 (canary) and v2 (stable); returns a fetch against the Worker.
async function seed(name) {
  const fake = fakeArtifacts();
  (await fake.create("cinder-agents")).files[`agents/${name}/prompt.md`] = "You are developer.\n";
  await env.DB.batch([
    ...[1, 2].map((v) => env.DB.prepare("INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES (?, ?, ?, 'claude-code', 'claude-opus-5-5', 'default', 'sha256:abc', '[]', '{\"max_cost_usd\":8,\"max_minutes\":120}')").bind(`agent/${name}/v${v}`, name, v)),
    env.DB.prepare("INSERT INTO channels (agent_name, channel, version) VALUES (?1, 'stable', 2), (?1, 'canary', 1)").bind(name),
  ]);
  return (path, method = "GET", body) => worker.fetch(new Request(`http://cinder.test/api/agents/${name}${path}`,
    { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
}
const channels = (name) => env.DB.prepare("SELECT channel, version FROM channels WHERE agent_name = ? ORDER BY channel").bind(name).all().then((r) => r.results);

it("A draft never runs: a saved draft moves no channel and queues no job, and Discard draft deletes it", async () => {
  const call = await seed("drafty");
  expect((await call("/draft", "PUT", DRAFT)).status).toBe(200);
  expect(await channels("drafty")).toEqual([{ channel: "canary", version: 1 }, { channel: "stable", version: 2 }]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload, '$.name') = 'drafty'").first("n")).toBe(0);
  expect((await (await call("")).json()).draft).toEqual({ ...DRAFT, web: "markdown", saved_at: expect.any(String) });
  expect((await call("/draft", "DELETE")).status).toBe(204);
  expect((await (await call("")).json()).draft).toBeNull();
  expect((await call("/draft", "DELETE")).status).toBe(404);
  expect(await channels("drafty")).toEqual([{ channel: "canary", version: 1 }, { channel: "stable", version: 2 }]);
});

it("Release tags the version and points the chosen channel at it", async () => {
  const call = await seed("releaser");
  await call("/draft", "PUT", DRAFT);
  expect((await call("/release", "POST", { channel: "canary", note: 7 })).status).toBe(400);
  expect((await call("/release", "POST", { channel: "canary", note: " Stack on leased symbols " })).status).toBe(202);
  const job = JSON.parse(await env.DB.prepare("SELECT payload FROM jobs WHERE kind = 'release' AND json_extract(payload, '$.name') = 'releaser'").first("payload"));
  expect(job).toEqual({ name: "releaser", channel: "canary", note: "Stack on leased symbols", draft: { ...DRAFT, web: "markdown" } });
  // The job carries the draft, so the saved draft is gone and the page shows no draft card.
  expect((await (await call("")).json()).draft).toBeNull();
  // The runner tags agent/releaser/v3; its push records v3 and points canary at it, leaving stable on v2.
  const { prompt, ...lock } = job.draft;
  const message = JSON.stringify({ name: "releaser", version: 3, ...lock, prompt_hash: `sha256:${prompt.length}`, egress_mode: "enforce" });
  await env.DB.prepare("UPDATE jobs SET status = 'claimed', lease_expires_at = ? WHERE kind = 'release' AND json_extract(payload, '$.name') = ?")
    .bind(new Date(Date.now() + 60000).toISOString(), "releaser").run();
  await onPushes({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "cinder-agents" },
    payload: { ref: "refs/tags/agent/releaser/v3", after: "abc", commits: [{ message }] } } }] }, env);
  expect(await channels("releaser")).toEqual([{ channel: "canary", version: 3 }, { channel: "stable", version: 2 }]);
});
