import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { channelAgent } from "../src/canary.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const fake = fakeArtifacts();
const call = (path, body, method = "POST") => worker.fetch(
  new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }),
  { ...env, ARTIFACTS: fake },
);

async function versions(agent, n) {
  for (let v = 1; v <= n; v++) {
    await env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES (?, ?, ?, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{}')").bind(`agent/${agent}/v${v}`, agent, v).run();
  }
}

const outcomes = (version, list) => env.DB.batch(list.map((outcome, i) => env.DB.prepare(
  "INSERT INTO agent_outcomes (id, agent_version, outcome, change_id, at) VALUES (?, ?, ?, ?, '2026-10-08T00:00:00Z')",
).bind(`seed:${version}:${i}`, version, outcome, `seed-${i}`)));

// dev v1 is stable with a 50% merge rate; v2 is the canary at 50% share with 3 of 3 merged. A change developed by dev@v2
// is closed, adding a fourth canary outcome (3 of 4 = 75%), in a repo whose trust threshold is minOutcomes.
async function closeCanaryChange(repo, agent, minOutcomes) {
  await versions(agent, 2);
  expect((await call(`/api/agents/${agent}/channels/stable`, { version: 1 }, "PUT")).status).toBe(200);
  expect((await call(`/api/agents/${agent}/channels/canary`, { version: 2, share: 50 }, "PUT")).status).toBe(200);
  await outcomes(`${agent}@v1`, ["merged", "merged", "failed", "closed"]);
  await outcomes(`${agent}@v2`, ["merged", "merged", "merged"]);
  expect((await call("/api/fleet", { canary_auto_promote: true }, "PUT")).status).toBe(204);
  const { id } = await (await call("/api/repos", { name: repo })).json();
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(repo)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  await env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, ?)").bind(id, minOutcomes).run();
  const change = await (await call(`/api/repos/${repo}/changes`, { intent: "x", agent_version: `${agent}@v2` })).json();
  expect((await call(`/api/changes/${change.id}/close`)).status).toBe(200);
  const channels = Object.fromEntries((await env.DB.prepare("SELECT channel, version FROM channels WHERE agent_name = ?").bind(agent).all()).results
    .map((c) => [c.channel, c.version]));
  const share = await env.DB.prepare("SELECT share FROM canary_shares WHERE agent_name = ?").bind(agent).first("share");
  const promoted = (await env.DB.prepare("SELECT agent_version, change_id FROM agent_outcomes WHERE outcome = 'agent_promoted' AND agent_version LIKE ?")
    .bind(`${agent}@%`).all()).results;
  const closed = await env.DB.prepare("SELECT outcome FROM agent_outcomes WHERE change_id = ? AND agent_version = ? AND outcome <> 'agent_promoted'").bind(change.id, `${agent}@v2`).first("outcome");
  return { change, channels, share, promoted, closed };
}

describe("canary", () => {
  it("a 30% canary share sends the hashed 30% of new changes to the canary version", async () => {
    await versions("reviewer", 2);
    expect((await call("/api/agents/reviewer/channels/stable", { version: 1 }, "PUT")).status).toBe(200);
    const put = await call("/api/agents/reviewer/channels/canary", { version: 2, share: 30 }, "PUT");
    expect(await put.json()).toEqual({ channel: "canary", version: 2, share: 30 });
    expect((await call("/api/agents/reviewer/channels/canary", { version: 2, share: 101 }, "PUT")).status).toBe(400);
    expect((await call("/api/agents/reviewer/channels/stable", { version: 1, share: 30 }, "PUT")).status).toBe(400);

    const ids = Array.from({ length: 400 }, (_, i) => `change-${i}`);
    const bucket = async (id) => new DataView(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))).getUint32(0) % 100;
    const expected = [];
    for (const id of ids) if (await bucket(id) < 30) expected.push(id);
    const canary = [];
    for (const id of ids) {
      const { agent_version: v } = await channelAgent(env, "review", id);
      if (v === "reviewer@v2") canary.push(id);
      else expect(v).toBe("reviewer@v1");
    }
    expect(canary).toEqual(expected);
    expect(canary.length).toBeGreaterThan(90);
    expect(canary.length).toBeLessThan(150);
    // Stable per change: asking again picks the same version.
    expect(await channelAgent(env, "review", canary[0])).toEqual({ agent_version: "reviewer@v2" });
  });

  it("a share of new changes pin the developer canary", async () => {
    await versions("developer", 2);
    expect((await call("/api/agents/developer/channels/stable", { version: 1 }, "PUT")).status).toBe(200);
    expect((await call("/api/agents/developer/channels/canary", { version: 2, share: 50 }, "PUT")).status).toBe(200);
    await call("/api/repos", { name: "canary-pin" });
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("canary-pin")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const bucket = async (id) => new DataView(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))).getUint32(0) % 100;
    const pins = new Set();
    for (let i = 0; i < 20; i++) {
      const change = await (await call("/api/repos/canary-pin/changes", { intent: `x${i}`, draft: true })).json();
      expect(change.agent_version).toBe(await bucket(change.id) < 50 ? "developer@v2" : "developer@v1");
      pins.add(change.agent_version);
    }
    expect([...pins].sort()).toEqual(["developer@v1", "developer@v2"]);
  });

  it("a canary that out-merges stable past the trust threshold is promoted when auto-promote is on", async () => {
    const { change, channels, share, promoted, closed } = await closeCanaryChange("canary-promote", "canarydev", 4);
    expect(closed).toBe("closed");
    expect(channels).toEqual({ stable: 2, canary: 2 });
    expect(share).toBe(0);
    expect(promoted).toEqual([{ agent_version: "canarydev@v2", change_id: change.id }]);
  });

  it("auto-promote records a channel event", async () => {
    const promotedEvents = async (agent) => (await (await call(`/api/agents/${agent}/history`, undefined, "GET")).json())
      .filter((e) => e.kind === "promoted").map(({ version, by }) => ({ version, by }));
    // By merge rate, when a change closes.
    await closeCanaryChange("canary-event", "canaryevt", 4);
    expect(await promotedEvents("canaryevt")).toEqual([{ version: 2, by: "auto-promote" }, { version: 1, by: "owner" }]);
    // By race wins, when the fleet setting is saved.
    await versions("racerevt", 2);
    expect((await call("/api/agents/racerevt/channels/stable", { version: 1 }, "PUT")).status).toBe(200);
    expect((await call("/api/agents/racerevt/channels/canary", { version: 2 }, "PUT")).status).toBe(200);
    await env.DB.batch(Array.from({ length: 30 }, (_, i) => env.DB.prepare(
      "INSERT INTO race_legs (change_id, race_id, agent, started_at, won) VALUES (?, 'r', 'racerevt@v2', '2026-10-08T00:00:00Z', 1)").bind(`racerevt-${i}`)));
    expect((await call("/api/fleet", { canary_auto_promote: true }, "PUT")).status).toBe(204);
    expect(await promotedEvents("racerevt")).toEqual([{ version: 2, by: "auto-promote" }, { version: 1, by: "owner" }]);
    expect((await call("/api/fleet", { canary_auto_promote: true }, "PUT")).status).toBe(204);
    expect(await promotedEvents("racerevt")).toHaveLength(2);
  });

  it("a canary below the trust threshold is never promoted", async () => {
    const { channels, share, promoted, closed } = await closeCanaryChange("canary-untrusted", "canaryfew", 5);
    expect(closed).toBe("closed");
    expect(channels).toEqual({ stable: 1, canary: 2 });
    expect(share).toBe(50);
    expect(promoted).toEqual([]);
  });
});
