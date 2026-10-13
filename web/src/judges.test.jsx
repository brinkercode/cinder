import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { pool, worstBin } from "./judges.jsx";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const app = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  return <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />;
};
// prerender waits for the deferred judges data.
const settled = async (path) => new Response((await prerender(await app(path))).prelude).text();
const text = (html) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
// Live mode: the shell's repos still come back, every repo's judges answer with `res()`.
const api = (res) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(async (path) => (path === "/api/repos" ? Response.json(repos) : res(path))));
};
// Three judges, on the first repo only.
const judge = (model_version, count, brier, health, fallbacks, reason, kind = "risk") => ({ kind, backend: "clef", model_version, count, trusted: count >= 200, brier,
  bins: [{ lo: 0, hi: 1, count, mean_p: 0.5, observed: 0.5 }], health, reason, fallbacks, recent: [] });
const JUDGES = [
  judge("claude-sonnet-5", 412, 0.082, "healthy", 0, null, "risk"),
  judge("gpt-5-mini", 188, 0.11, "degraded", 7, "Model ID not found on 7 calls; fell back to the default verdict", "lease"),
  judge("GLM 4.6", 9, 0.2, "failing", 23, "Vectorize index unbound; every call used the default verdict", "guard"),
];
const body = (judges) => ({ airlock: false, trust: { min_outcomes: 200, min_races: 30 }, judges });

describe("judges page", () => {
  const mine = (js) => (path) => Response.json(body(path.includes(encodeURIComponent(repos[0].name)) ? js : []));
  const tabs = (html) => [...html.matchAll(/<button type="button" role="tab" aria-selected="(true|false)"[^>]*><span class="mono">([^<]+)<\/span> <span class="ct">(\d+)<\/span>/g)].map((m) => [m[2], m[3], m[1] === "true"]);
  const rows = (html) => [...html.match(/<tbody>(.*?)<\/tbody>/)[1].matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => text(m[1]).trim());

  it("tabs list only kinds with a judge with matching counts, and ?kind= selects the tab", async () => {
    api(mine([...JUDGES, judge("clef@2", 30, 0.1, "healthy", 0, null, "guard")]));
    const html = await settled("/automation/judges?kind=guard");
    expect(tabs(html)).toEqual([["lease", "1", false], ["risk", "1", false], ["guard", "2", true]]);
    expect(rows(html)).toHaveLength(2);
    // With no ?kind=, the first kind with an untrusted or unhealthy judge opens.
    expect(tabs(await settled("/automation/judges")).find(([, , on]) => on)[0]).toBe("lease");
  });

  it("fallbacks to the default verdict are always visible with a count and a reason", async () => {
    api(mine(JUDGES));
    const html = await settled("/automation/judges?kind=lease");
    const t = text(html);
    expect(t).toContain("Judges & calibration");
    expect(html).toMatch(/<button type="button" class="btn btn-primary" disabled="">.*Add judge<\/button>/);
    expect(rows(html)).toEqual(["clef@gpt-5-mini gpt-5-mini learning: 188 of 200 outcomes, all time 188 — — Model degraded Model ID not found on 7 calls; fell back to the default verdict 7 default verdicts"]);
    expect(html).toContain('<span class="dot warn"></span> Model <!-- -->degraded');
    expect(rows(await settled("/automation/judges?kind=risk"))[0]).toContain("Model healthy");
    expect(await settled("/automation/judges?kind=risk")).not.toContain("default verdicts");
    expect(text(await settled("/automation/judges?kind=risk"))).toContain("The only judge answering this question, so nothing to rank it against.");
  });

  it("each judge's curve uses its own bins; an untrusted judge is dashed and dimmed, shows no Brier and sorts last", async () => {
    const own = { lo: 0.2, hi: 0.3, count: 9, mean_p: 0.25, observed: 0.3 };
    const kev = { ...judge("kev@2026-09", 48, 0.073, "healthy", 0, null), trusted: false, bins: [own] };
    api(mine([kev, judge("claude-sonnet-5", 412, 0.082, "healthy", 0, null)]));
    const html = await settled("/automation/judges?kind=risk");
    expect(rows(html).map((r) => r.split(" ")[0])).toEqual(["clef@claude-sonnet-5", "clef@kev@2026-09"]);
    // X = 30 + 300p, Y = 4 + 300(1 − observed) on the 300px chart.
    expect(html).toContain('<polyline class="pl-line" style="stroke:var(--chart)" points="180.0,154.0">');
    expect(html).toContain('<polyline class="pl-line dash" style="stroke:var(--neutral-fill);opacity:0.45" points="105.0,214.0">');
    expect(text(html)).toContain("Dashed = untrusted, shown for shape only.");
    expect(text(html)).not.toMatch(/\.073|0\.073/);
    expect(rows(html)[1]).toContain("learning: 48 of 200 outcomes");
  });

  it("the trend shows a gap for a week with no outcomes, and — with no trend data", async () => {
    const trend = [0.1, null, 0.12].map((brier, i) => ({ week: `2026-09-${String(7 * i + 7).padStart(2, "0")}`, count: brier == null ? 0 : 5, brier }));
    api(mine([{ ...judge("claude-sonnet-5", 412, 0.082, "healthy", 0, null), trend }]));
    const html = await settled("/automation/judges?kind=risk");
    const d = html.match(/<svg class="pl"[^>]*aria-label="Brier score over time">.*?<path class="pl-line" style="stroke:var\(--chart\)" d="([^"]*)"/)[1];
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).not.toContain("L");

    api(mine([judge("claude-sonnet-5", 412, 0.082, "healthy", 0, null)]));
    expect(text(await settled("/automation/judges?kind=risk"))).toContain("Brier over 12 weeks lower is better —");
  });

  it("largest miss reads from the bin furthest from the diagonal, and — while untrusted", async () => {
    const bins = [{ lo: 0, hi: 0.1, count: 50, mean_p: 0.05, observed: 0.1 }, { lo: 0.4, hi: 0.5, count: 20, mean_p: 0.45, observed: 0.3 }, { lo: 0.9, hi: 1, count: 9, mean_p: 0.95, observed: 0.9 }];
    expect(worstBin(bins)).toBe(bins[1]);
    api(mine([{ ...judge("claude-sonnet-5", 412, 0.082, "healthy", 0, null), bins }, { ...judge("kev", 40, 0.1, "healthy", 0, null), trusted: false, bins }]));
    const [trusted, untrusted] = rows(await settled("/automation/judges?kind=risk"));
    expect(trusted).toContain("said 45%, happened 30%");
    expect(untrusted).not.toContain("said");
    expect(untrusted).toContain("— — Model healthy");
  });

  it("pool() merges one model's series from two repos count-weighted, matching a hand calculation", () => {
    const a = { ...judge("clef@2", 100, 0.1, "healthy", 0, null), trusted: true, bins: [{ lo: 0, hi: 0.1, count: 60, mean_p: 0.05, observed: 0.1 }],
      trend: [{ week: "2026-09-07", count: 10, brier: 0.1 }, { week: "2026-09-14", count: 0, brier: null }], min_outcomes: 200 };
    const b = { ...judge("clef@2", 300, 0.2, "degraded", 3, "slow"), bins: [{ lo: 0, hi: 0.1, count: 20, mean_p: 0.09, observed: 0.02 }, { lo: 0.5, hi: 0.6, count: 5, mean_p: 0.55, observed: 0.6 }],
      trend: [{ week: "2026-09-07", count: 30, brier: 0.2 }, { week: "2026-09-14", count: 0, brier: null }], min_outcomes: 200 };
    const p = pool([a, b]);
    expect(p).toMatchObject({ count: 400, trusted: true, health: "degraded", fallbacks: 3, min_outcomes: 400 });
    expect(p.brier).toBeCloseTo(0.175); // (100 × .1 + 300 × .2) / 400
    expect(p.bins).toHaveLength(2);
    expect(p.bins[0]).toMatchObject({ lo: 0, count: 80 });
    expect(p.bins[0].mean_p).toBeCloseTo(0.06); // (60 × .05 + 20 × .09) / 80
    expect(p.bins[0].observed).toBeCloseTo(0.08); // (60 × .1 + 20 × .02) / 80
    expect(p.trend[0].count).toBe(40);
    expect(p.trend[0].brier).toBeCloseTo(0.175); // (10 × .1 + 30 × .2) / 40
    expect(p.trend[1]).toEqual({ week: "2026-09-14", count: 0, brier: null });
  });

  it("a model running on two repos is one leaderboard row with the pooled count", async () => {
    api(() => Response.json(body([judge("claude-sonnet-5", 412, 0.082, "healthy", 0, null)])));
    const r = rows(await settled("/automation/judges?kind=risk"));
    expect(r).toHaveLength(1);
    expect(r[0]).toContain(`clef@claude-sonnet-5 claude-sonnet-5 .082 ${412 * repos.length}`);
  });

  it("empty, loading and error states render as the doc describes", async () => {
    api(() => Response.json(body([])));
    const empty = text(await settled("/automation/judges"));
    expect(empty).toContain("No judges yet");
    expect(empty).toContain("Judges are added when a repo is imported.");

    api(() => new Promise(() => {}));
    const stop = new AbortController();
    const pending = prerender(await app("/automation/judges"), { signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    const loading = await new Response((await pending).prelude).text();
    expect(text(loading)).toContain("Judges & calibration");
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/class="card skel-card"/g)).toHaveLength(3);

    api(() => new Response("", { status: 503 }));
    const error = await settled("/automation/judges");
    expect(error).toContain('role="alert"');
    expect(text(error)).toContain("Couldn't load judges: /api/repos/acme%2Fapi/judges: HTTP 503");
    expect(error).toMatch(/<button[^>]*>Retry<\/button>/);
  });
});
