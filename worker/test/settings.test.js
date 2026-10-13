import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { validateRepoSettings } from "../src/api/contract.js";
import { scanDaily } from "../src/scans.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, {
  ...init, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
}), { ...env, ARTIFACTS: fakeArtifacts() });
const put = (name, body) => call(`/api/repos/${name}/settings`, { method: "PUT", body: JSON.stringify(body) });

describe("repo settings", () => {
  it("setting min_races changes when a win rate becomes trusted", async () => {
    await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "set-races" }) });
    const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = 'set-races'").first()).id;
    await env.DB.batch(Array.from({ length: 5 }, (_, i) => [
      env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'closed', '2026-10-04T00:00:00Z')").bind(`set-${i}`, repo),
      env.DB.prepare("INSERT INTO race_legs (change_id, race_id, agent, started_at, won) VALUES (?, ?, 'developer@v1', '2026-10-04T00:00:00Z', ?)").bind(`set-${i}`, `set-race-${i}`, i < 3 ? 1 : 0),
    ]).flat());
    const winRates = async () => (await (await call("/api/repos/set-races/insights?from=2026-10-01T00:00:00Z&to=2026-10-05T00:00:00Z")).json()).win_rates;
    expect(await winRates()).toEqual([{ agent: "developer@v1", untrusted: true, count: 5 }]);

    expect((await put("set-races", { trust: { min_outcomes: 200, min_races: 5 }, flake_quarantine: 0.3, mirror_url: "https://github.com/o/r.git" })).status).toBe(204);
    expect(await winRates()).toEqual([{ agent: "developer@v1", value: 3 / 5, count: 5 }]);
    expect(await env.DB.prepare("SELECT flake_quarantine FROM repo_settings WHERE repo = ?").bind(repo).first("flake_quarantine")).toBe(0.3);
    expect(await env.DB.prepare("SELECT mirror_url FROM repo_mirrors WHERE repo_id = ?").bind(repo).first("mirror_url")).toBe("https://github.com/o/r.git");

    expect((await put("set-races", { trust: { min_outcomes: 200, min_races: 0 } })).status).toBe(400);
    expect((await put("missing", { flake_quarantine: 0.5 })).status).toBe(404);
  });

  it("scans_paused skips the repo's daily scan until it is turned off", async () => {
    await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "set-pause" }) });
    const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = 'set-pause'").first()).id;
    const daily = async () => {
      await env.DB.prepare("DELETE FROM jobs WHERE repo_id = ? AND kind = 'scan'").bind(repo).run();
      await scanDaily(env);
      return env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE repo_id = ? AND kind = 'scan'").bind(repo).first("n");
    };
    expect((await put("set-pause", { scans_paused: true })).status).toBe(204);
    expect(await daily()).toBe(0);
    expect((await (await call("/api/repos/set-pause/watchtower")).json()).paused).toBe(true);
    expect((await put("set-pause", { scans_paused: "yes" })).status).toBe(400);
    await put("set-pause", { scans_paused: false });
    expect(await daily()).toBe(1);
  });

  it("an http mirror_url returns 400", async () => {
    await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "set-mirror" }) });
    const res = await put("set-mirror", { mirror_url: "http://github.com/o/r.git" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/mirror_url/);
    expect(await env.DB.prepare("SELECT 1 FROM repo_mirrors m JOIN repos r ON r.id = m.repo_id WHERE r.name = 'set-mirror'").first()).toBeNull();
  });
});

it("repo settings carry no visibility", async () => {
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "set-novis" }) });
  const settings = await (await call("/api/repos/set-novis/settings")).json();
  expect(settings).not.toHaveProperty("visibility");
  expect(validateRepoSettings({ ...settings, visibility: undefined }).ok).toBe(true);
});
