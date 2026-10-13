import { prerender } from "react-dom/static";
import { repoAt } from "./fake-repos.js";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import egress from "../../worker/src/api/fixtures/egress.json";
import { routes } from "./routes.jsx";

const page = async (render, query = "") => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test/acme%2Fapi/watchtower${query}`));
  return render(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
};
// Waits for every <Await> to settle, like the browser once data arrives.
const settled = (el) => prerender(el).then(({ prelude }) => new Response(prelude).text());
const text = (html) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");
const dep = (name, status, vulns = [], auto_fix = false) => ({ ecosystem: "npm", name, version: "1.0.0", direct: true, license: "MIT", status, vulns, auto_fix });
const UNDICI = dep("undici", "vulnerable", [{ id: "GHSA-c76h", severity: "critical", fixed_in: "6.21.1", also_fixes: 0 }]);
const F = (id, source, severity, rule, path, more = {}) => ({ id, source, severity, title: rule, location: path, state: "open", rule, path, line: null,
  first_seen: new Date().toISOString(), dismiss_reason: null, fix_change: null, ...more });
const WT = { findings: [F("f-1", "dependency", "critical", "GHSA-c76h", "undici@1.0.0")],
  scans: [{ id: "s-1", ran_at: new Date().toISOString(), status: "passed", findings: 1 }], paused: false,
  scan_worker_online: true, fix_changes_open: 0 };
// Stubs the API: /watchtower answers wt with status, /dependencies deps, /egress the 24h fixture; sent records each write.
const sent = [];
const api = ({ status = 200, wt = WT, deps = [UNDICI, dep("zod", "current")] } = {}) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (url, init) => {
    const u = String(url);
    if (init?.method) sent.push([init.method, u, JSON.parse(init.body)]);
    if (u.endsWith("/watchtower?state=all")) return new Response(JSON.stringify(wt), { status });
    if (u.endsWith("/dependencies")) return Response.json(deps);
    if (u.includes("/egress")) return Response.json({ ...egress, window: "24h" });
    return Response.json(repoAt(u) ?? []);
  });
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); sent.length = 0; });

describe("watchtower page", () => {
  it("skeleton counts match the spec: Overview 4 tiles, a severity-bar bone, 4 advisory rows; Dependencies 8 table rows; Network 3 agent cards", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const count = (html, re) => html.match(re)?.length ?? 0;
    const overview = await page(renderToString, "?tab=overview");
    expect(count(overview, /<div class="tile flat">/g)).toBe(4);
    expect(overview).toContain("<div class=\"l\">Open advisories</div>");
    expect(count(overview, /class="bone"[^>]*width:100%;height:32px/g)).toBe(1);
    expect(count(overview, /<div class="act">/g)).toBe(4);
    const deps = await page(renderToString, "?tab=dependencies");
    expect(deps).toContain("<th>Package</th><th>Version</th>");
    expect(count(deps, /<tr style="height:44px">/g)).toBe(8);
    expect(deps).toMatch(/<button[^>]*value="sbom"[^>]*disabled=""/);
    expect(count(await page(renderToString, "?tab=network"), /<section class="card">/g)).toBe(3);
  });

  it("All 3 tabs are live, with one visible at a time", async () => {
    api();
    const MARK = { overview: "Top advisories", dependencies: "Inventory · 2 packages", network: "Egress per agent version" };
    for (const tab of Object.keys(MARK)) {
      const html = await page(settled, `?tab=${tab}`);
      expect(html).toMatch(new RegExp(`aria-selected="true"[^>]*>${tab[0].toUpperCase()}${tab.slice(1)}<`));
      for (const [other, mark] of Object.entries(MARK)) expect(text(html).includes(mark), `${tab} shows ${other}`).toBe(other === tab);
    }
    const over = text(await page(settled));
    for (const s of ["Dependencies 2", "Open advisories 1", "Critical 1", "undici 1.0.0 GHSA-c76h · fixed in 6.21.1 Critical Open fix change"]) expect(over).toContain(s);
  });

  it("Allowlist opens the agent's settings tab", async () => {
    api();
    expect(await page(settled, "?tab=network")).toMatch(/href="\/automation\/agents\/developer\/settings"[^>]*>Allowlist</);
  });

  it("The severity filter shows \"Nothing at this severity\" when empty", async () => {
    api();
    const high = text(await page(settled, "?tab=dependencies&sev=high"));
    expect(high).toContain("Nothing at this severity.");
    expect(high).not.toContain("undici");
    const critical = text(await page(settled, "?tab=dependencies&sev=critical"));
    expect(critical).toContain("undici 1.0.0 GHSA-c76h Critical 6.21.1");
    expect(critical).not.toContain("Nothing at this severity");
  });

  it("the auto-fix toggle PATCHes the package's auto_fix", async () => {
    api();
    expect(await page(settled, "?tab=dependencies")).toMatch(/role="switch"[^>]*aria-label="Auto-fix undici"/);
    const body = new FormData();
    for (const [k, v] of [["act", "auto"], ["ecosystem", "npm"], ["name", "undici"], ["on", "true"]]) body.set(k, v);
    await createStaticHandler(routes).query(new Request("http://cinder.test/acme%2Fapi/watchtower", { method: "POST", body }));
    expect(sent).toEqual([["PATCH", "/api/repos/acme%2Fapi/dependencies", { ecosystem: "npm", name: "undici", auto_fix: true }]]);
  });

  it("Pause scans PUTs scans_paused, and a paused repo offers Resume scans", async () => {
    api({ wt: { ...WT, paused: true } });
    expect(text(await page(settled))).toContain("Pause Watchtower scans Stops scheduled dependency and egress scans for acme/api. Open advisories stay listed. Resume scans");
    const body = new FormData();
    for (const [k, v] of [["act", "pause"], ["on", "true"]]) body.set(k, v);
    await createStaticHandler(routes).query(new Request("http://cinder.test/acme%2Fapi/watchtower", { method: "POST", body }));
    expect(sent).toEqual([["PUT", "/api/repos/acme%2Fapi/settings", { scans_paused: true }]]);
  });

  it("renders the clean state and the failing-scan banner with Retry", async () => {
    api({ wt: { ...WT, scans: [{ ...WT.scans[0], status: "failed" }] }, deps: [dep("zod", "current")] });
    const t = text(await page(settled));
    for (const s of ["Open advisories 0", "The last scan failed. Advisories are from the scan before it. Retry", "No open advisories."]) expect(t).toContain(s);
  });

  it("renders the per-tab loading skeletons and the error state", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    for (const tab of ["overview", "dependencies", "network"]) expect(await page(renderToString, `?tab=${tab}`)).toContain('<p role="status" class="sr-only">Loading Watchtower</p>');

    api({ status: 503, wt: { error: "unavailable" } });
    const t = text(await page(settled));
    expect(t).toContain("Couldn't load Watchtower: /api/repos/acme%2Fapi/watchtower?state=all: HTTP 503 Retry");
  });

  it("one package with 5 advisories (2 high, 3 medium) renders Open advisories 5, five Top advisories rows and High 2 · Medium 3", async () => {
    const v = (id, severity, fixed_in) => ({ id, severity, fixed_in, also_fixes: 0 });
    const lodash = { ...dep("lodash", "vulnerable", [v("GHSA-29mw", "medium", "4.17.21"), v("GHSA-35jh", "high", "4.17.21"),
      v("GHSA-f23m", "medium", "4.17.21"), v("GHSA-r5fr", "high", "4.17.23"), v("GHSA-xxjr", "medium", "4.18.0")]), version: "4.17.20" };
    api({ wt: { ...WT, findings: [] }, deps: [lodash] });
    const t = text(await page(settled));
    for (const s of ["Open advisories 5", "High 2", "Medium 3"]) expect(t).toContain(s);
    expect(t.match(/lodash 4\.17\.20 GHSA-\w+ · fixed in/g)).toHaveLength(5);
  });

  it("Auto-fix changes open shows 0 when auto_fix is on but the changes list is empty, and 1 with one open auto-fix change", async () => {
    const on = { ...UNDICI, auto_fix: true };
    api({ deps: [on] });
    expect(text(await page(settled))).toContain("Auto-fix changes open 0");
    api({ wt: { ...WT, fix_changes_open: 1 }, deps: [on] });
    expect(text(await page(settled))).toContain("Auto-fix changes open 1");
  });

  it("with a queued scan and no online scan worker, the Scan again button is busy and the page shows Waiting for a scan worker", async () => {
    const queued = { id: "s-2", ran_at: new Date().toISOString(), status: "queued", findings: 0 };
    api({ wt: { ...WT, scans: [queued, ...WT.scans], scan_worker_online: false } });
    const html = await page(settled);
    expect(html).toMatch(/<button type="submit" class="btn btn-primary" disabled="">.*Scanning…<\/button>/);
    expect(text(html)).toContain("Waiting for a scan worker");
    api({ wt: { ...WT, scans: [queued, ...WT.scans] } });
    expect(text(await page(settled))).not.toContain("Waiting for a scan worker");
  });

  const B09 = [F("s-1", "secret", "high", "stripe-secret-key", ".env.production", { line: 3 }), F("c-0", "code", "critical", "semgrep/js-0", "src/pay.js", { line: 12 }),
    F("c-1", "code", "high", "semgrep/js-1", "src/cart.js"), F("f-1", "dependency", "critical", "GHSA-c76h", "undici@1.0.0")];
  const post = async (fields) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    return createStaticHandler(routes).query(new Request("http://cinder.test/acme%2Fapi/watchtower", { method: "POST", body }));
  };

  it("Findings card shows Secrets 1 · Code 2 counts and a Secrets group row stripe-secret-key", async () => {
    api({ wt: { ...WT, findings: B09 } });
    const t = text(await page(settled));
    for (const s of ["Findings All 4 Dependencies 1 Secrets 1 Code 2", "Severity Finding Fix Age Secrets · 1 High stripe-secret-key .env.production —"]) expect(t).toContain(s);
    expect(t).toContain("Code · 2 Critical semgrep/js-0");
    expect(t).toContain("undici@1.0.0 · 1 · fix available Critical GHSA-c76h undici@1.0.0 6.21.1");
  });

  it("the Secrets source filter hides code and dependency rows; severity Critical leaves only semgrep/js-0", async () => {
    api({ wt: { ...WT, findings: B09 } });
    const secrets = text(await page(settled, "?source=secret"));
    expect(secrets).toContain("Secrets · 1 High stripe-secret-key");
    for (const gone of ["semgrep/js-0 src", "semgrep/js-1", "GHSA-c76h undici@1.0.0 6.21.1"]) expect(secrets).not.toContain(gone);
    const critical = text(await page(settled, "?source=code&fsev=critical"));
    expect(critical).toContain("Code · 1 Critical semgrep/js-0 src/pay.js");
    for (const gone of ["stripe-secret-key", "semgrep/js-1"]) expect(critical).not.toContain(gone);
    expect(text(await page(settled, "?source=secret&fsev=critical"))).toContain("No findings match these filters.");
  });

  it("clicking a code finding opens the rail with path:line, and Fix with an agent posts to /api/findings/<id>/fix", async () => {
    api({ wt: { ...WT, findings: B09 } });
    const html = await page(settled, "?finding=c-0");
    expect(html).toMatch(/<tr tabindex="0" class="sel">.*semgrep\/js-0/);
    const rail = text(html.slice(html.indexOf('aria-label="Finding detail"')));
    expect(rail).toContain("Location src/pay.js:12 Remediation Change the code so the rule no longer matches");
    expect(rail).toContain("Fix with an agent");
    await post({ act: "fix", id: "c-0" });
    expect(sent).toEqual([["POST", "/api/findings/c-0/fix", {}]]);
  });

  it("Dismiss with False positive posts {reason: false_positive}; a dismissed finding's rail shows Reopen, which posts to /reopen", async () => {
    api({ wt: { ...WT, findings: [...B09, F("c-2", "code", "low", "semgrep/js-2", "src/old.js", { state: "dismissed", dismiss_reason: "wont_fix" })] } });
    const open = text(await page(settled, "?finding=c-0"));
    expect(open).toContain("False positive Risk accepted Won't fix Not applicable Dismiss");
    expect(open).not.toContain("Reopen");
    await post({ act: "dismiss", id: "c-0", reason: "false_positive" });
    const dismissed = text(await page(settled, "?finding=c-2"));
    expect(dismissed).toContain("Dismissed · Won't fix");
    expect(dismissed).toContain("Reopen");
    expect(dismissed).not.toContain("Fix with an agent");
    await post({ act: "reopen", id: "c-2" });
    expect(sent).toEqual([["POST", "/api/findings/c-0/dismiss", { reason: "false_positive" }], ["POST", "/api/findings/c-2/reopen", {}]]);
  });
});
