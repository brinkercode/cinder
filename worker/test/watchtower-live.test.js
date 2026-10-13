// GET /api/repos/:name/watchtower, and the web Watchtower page rendered against this worker instead of fixtures.
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { routes } from "../../web/src/routes.jsx";
import { validateWatchtower } from "../src/api/contract.js";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const fake = fakeArtifacts({ creates: { "watchtower-live": {} } });
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake });
const auth = { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } };

beforeAll(async () => {
  await real("/api/repos", { method: "POST", ...auth, body: JSON.stringify({ name: "watchtower-live" }) });
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind("watchtower-live").first("id");
  const finding = env.DB.prepare("INSERT INTO findings (repo_id, target, source, rule, severity, path, fingerprint, state, first_sha, last_sha) " +
    "VALUES (?1, 'main', ?2, ?3, ?4, ?5, ?3, ?6, 's1', 's1')");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) VALUES (?1, ?2, 'scan', 'done', ?3, '{}'), (?4, ?2, 'scan', 'failed', ?5, '{}')")
      .bind("wt-job-2", repo, "2026-10-05T08:12:00Z", "wt-job-1", "2026-10-04T08:10:00Z"),
    env.DB.prepare("INSERT INTO scans (job_id, repo_id, target, source, sha, status, counts, started_at) VALUES " +
      "('wt-job-1', ?1, 'main', 'daily', 's0', 'failed', NULL, '2026-10-04T08:10:00Z'), " +
      "('wt-job-2', ?1, 'main', 'merge', 's1', 'done', '{\"secret\":1,\"dependency\":1,\"code\":1}', '2026-10-05T08:12:00Z')").bind(repo),
    finding.bind(repo, "dependency", "GHSA-lodash", "critical", "lodash@4.17.20", "open"),
    finding.bind(repo, "secret", "github_token", "high", "deploy/env.sh", "open"),
    finding.bind(repo, "code", "gosec-G104", "unknown", "", "open"),
    finding.bind(repo, "secret", "aws_key", "high", "old.js", "dismissed"),
  ]);
}, 120000); // seeds under every worker file starting at once; 30 s hook limit times out
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("watchtower (live)", () => {
  it("the route returns a payload that validates against the watchtower shape for a repo with seeded findings", async () => {
    const res = await real("/api/repos/watchtower-live/watchtower", auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateWatchtower(body)).toEqual({ ok: true, errors: [] });
    expect(body.findings.map((f) => [f.source, f.severity, f.title, f.location])).toEqual([
      ["dependency", "critical", "GHSA-lodash", "lodash@4.17.20"], ["secret", "high", "github_token", "deploy/env.sh"], ["code", "low", "gosec-G104", "main"],
    ]);
    expect(body.scans).toEqual([
      { id: "wt-job-2", ran_at: "2026-10-05T08:12:00Z", status: "passed", findings: 3 },
      { id: "wt-job-1", ran_at: "2026-10-04T08:10:00Z", status: "failed", findings: 0 },
    ]);
  });

  it("the Watchtower page renders live data (no error state) against a local worker", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("fetch", real);
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request("http://cinder.test/watchtower-live/watchtower"));
    const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
    const html = (await new Response((await prerender(el)).prelude).text()).replace(/<!-- -->/g, "");
    expect(html).not.toContain("Couldn&#x27;t load Watchtower");
    for (const s of ["Last scan", "Open advisories by severity", "Top advisories", "Denied egress · 24h"]) expect(html).toContain(s);
    // Dismissed findings are listed, tagged, so they can be reopened.
    expect(html).toMatch(/aws_key.*?Dismissed/);
  });

  it("the scans endpoint returns scan history for a repo", async () => {
    const res = await real("/api/repos/watchtower-live/watchtower/scans", auth);
    expect(res.status).toBe(200);
    expect((await res.json()).map((s) => [s.job_id, s.status, s.counts])).toEqual([
      ["wt-job-2", "done", { secret: 1, dependency: 1, code: 1 }], ["wt-job-1", "failed", null],
    ]);
  });

  it("the Watchtower overview renders with no failed requests", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    const failed = [];
    const record = async (url, init) => {
      const res = await real(url, init);
      if (!res.ok) failed.push(`${res.status} ${url}`);
      return res;
    };
    vi.stubGlobal("fetch", record);
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request("http://cinder.test/watchtower-live/watchtower"));
    const el = createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false });
    const html = await new Response((await prerender(el)).prelude).text();
    expect(html).toContain("Top advisories");
    // The live sweep's request for the overview's scans panel.
    await record("/api/repos/watchtower-live/watchtower/scans", auth);
    expect(failed).toEqual([]);
  });

  it("after POST watchtower/scans, GET scans lists a scan in state queued", async () => {
    expect((await real("/api/repos/watchtower-live/watchtower/scans", { method: "POST", ...auth })).status).toBe(202);
    const [scan] = await (await real("/api/repos/watchtower-live/watchtower/scans", auth)).json();
    expect([scan.status, scan.target, scan.source]).toEqual(["queued", "main", "daily"]);
    const wt = await (await real("/api/repos/watchtower-live/watchtower", auth)).json();
    expect(validateWatchtower(wt)).toEqual({ ok: true, errors: [] });
    expect([wt.scans[0].status, wt.scan_worker_online]).toEqual(["queued", false]);
  });
});
