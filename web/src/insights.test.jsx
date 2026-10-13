import { readFileSync } from "node:fs";
import { repoAt } from "./fake-repos.js";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import insights from "../../worker/src/api/fixtures/insights.json";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const PATH = "/acme%2Fapi/insights";
const app = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  return <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />;
};
const settled = async (path) => new Response((await prerender(await app(path))).prelude).text();
const text = (html) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
// Live mode: the shell's repos still come back, /api/insights answers with `res`.
const api = (res) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("fetch", vi.fn(async (path) => (repoAt(path) ? Response.json(repoAt(path)) : res instanceof Response ? res.clone() : res)));
};
const zero = (b) => ({ ...b, merged: 0, passed: 0, failed: 0, tokens: 0, cost_usd: 0 });
const empty = { ...insights, series: insights.series.map(zero), calibration: { count: 0, brier: null, bins: [] }, lease_conflicts: { conflicts: 0, leases: 0 },
  usage: { tokens: 0, cost_usd: 0, by_agent: [], by_person: [], by_change: [] } };

describe("insights page", () => {
  it("there are no chart libraries: the charts are hand-drawn bars and an inline SVG", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) expect(dep).not.toMatch(/chart|d3|recharts|victory|nivo|plotly|echarts|visx|apex/i);
    const imports = [...readFileSync(new URL("insights.jsx", import.meta.url), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((m) => !m.startsWith("./"))).toEqual(["react", "react-router"]);
    vi.stubEnv("VITE_FIXTURES", "1");
    const html = await settled(PATH);
    // Changes merged (and its dialog copy) and Verifier runs are BarCharts; calibration is the reliability diagram with a dashed diagonal.
    expect(html.match(/<div class="bc">/g)).toHaveLength(3);
    expect(html).toContain('<svg class="reldiag" viewBox="0 0 260 260" role="img" aria-label="Reliability diagram">');
    expect(html).toContain('stroke-dasharray="4 4"');
    expect(html).toContain('<dialog class="dlg full" aria-label="Changes merged">');
    const t = text(html);
    for (const s of ["Changes merged 97", "Verifier runs 579", "Agent tokens 2.9M", "Brier score 0.082 n=412", "Lease conflicts 6 of 214 leases",
      "acme/api → main 97", "Passed 510 Failed 69", "Brier 0.082 · n=412", "Time (UTC)", "developer@v7 1.4M"]) expect(t).toContain(s);
  });

  it("the usage lens includes runs from outside cinder, tagged", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const html = await settled(`${PATH}?lens=usage`);
    expect(html).toMatch(/<div class="lens" hidden="">.*Tokens by agent/);
    const t = text(html);
    for (const s of ["Tokens 2.9M", "Cost $29.45", "Cost per merged change $0.30", "Change failure rate 3.1% n=161",
      "claude-code outside cinder 220k $2.95", "sam outside cinder 220k $2.95", "maya 310k $4.10", "c-1030 $3.40", "top 5 by cost"]) expect(t).toContain(s);
    expect(html).toContain('href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"');
    expect(t).toContain("Observability › Agents");
  });

  it("every link lands on the filtered target", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const html = await settled("/acme%2Fweb/insights?range=Last%207%20days&target=develop");
    const links = Object.fromEntries([...html.matchAll(/<a class="go" href="([^"]+)"[^>]*>([^<]+)/g)].map(([, href, label]) => [`${label.trim()} ${href.replaceAll("&amp;", "&")}`, true]));
    expect(Object.keys(links).toSorted()).toEqual([
      "Open collisions /acme%2Fweb/changes/collisions?target=develop",
      "Open judge /automation/judges",
      "Open runs /acme%2Fweb/flows?range=168&target=develop",
      "View failing changes /acme%2Fweb/changes?state=failed&target=develop",
    ]);
    // Open judge twice: the Brier tile and the Calibration header.
    expect(html.match(/<a class="go" href="\/automation\/judges"/g)).toHaveLength(2);
    // The failing-changes link opens the board on the failed changes only.
    const board = text(await settled("/acme%2Fweb/changes?state=failed&target=develop"));
    expect(board).toContain("c-1041");
    for (const id of ["c-1042", "c-1043", "c-1039"]) expect(board).not.toContain(id);
    // Each agent version row has its menu; the outside-cinder row has none.
    const usage = text(await settled("/acme%2Fweb/insights?lens=usage"));
    expect(usage).toContain("Set a token limit Swap model Open agent");
    expect(html).toContain('href="/automation/agents/developer/settings"');
    expect(html).toContain('href="/automation/agents/developer"');
    expect(html).not.toContain('aria-label="Actions for claude-code"');
  });

  it("the token limit dialog prefills the current limits", async () => {
    const [v7, ...rest] = insights.usage.by_agent;
    api(Response.json({ ...insights, usage: { ...insights.usage, by_agent: [{ ...v7, limits: { max_tokens: 200000, max_tokens_month: 5000000 } }, ...rest] } }));
    const html = await settled(`${PATH}?lens=usage`);
    const dialog = html.match(/<dialog class="dlg" aria-label="Token limit for developer@v7">.*?<\/dialog>/)[0];
    expect(dialog).toMatch(/name="run"[^>]*value="200"/);
    expect(dialog).toMatch(/name="month"[^>]*value="5"/);
  });

  it("Insights Overview and Usage both render inside the same frame class", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const frame = (html) => html.match(/<div class="(frame[^"]*)"/)[1];
    expect(frame(await settled(PATH))).toBe("frame");
    expect(frame(await settled(`${PATH}?lens=usage`))).toBe("frame");
  });

  it("the By person card header renders before (outside) the body's centred empty band", async () => {
    api(Response.json({ ...insights, usage: { ...insights.usage, by_person: [] } }));
    const html = await settled(`${PATH}?lens=usage`);
    expect(html).toContain('<div class="card"><div class="card-h"><h3>By person</h3></div><div class="card-b"><div class="empty">');
  });

  it("Tokens by agent renders the outside cinder tag on the outside row and not on the cinder row", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const rows = (await settled(PATH)).match(/<div class="hb">.*?<\/span><\/div>/g).map(text);
    expect(rows).toContain(" claude-code outside cinder 220k ");
    expect(rows).toContain(" developer@v7 1.4M ");
  });

  it("the Insights branch popover lists both develop and main from the fixture", async () => {
    vi.stubEnv("VITE_FIXTURES", "1");
    const html = await settled("/acme%2Fweb/insights");
    const buttons = [...html.matchAll(/<button type="button" class="btn btn-ghost">([^<]+)<\/button>/g)].map((m) => m[1]);
    expect(buttons.slice(0, 2)).toEqual(["develop", "main"]);
  });

  it("loading shows tile and chart skeletons, then no data in range and calibration under 20 outcomes show their empty states", async () => {
    api(new Promise(() => {}));
    const stop = new AbortController();
    const pending = prerender(await app(PATH), { signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    const loading = await new Response((await pending).prelude).text();
    expect(loading).toContain('<div aria-busy="true"><p role="status" class="sr-only">Loading insights</p>');

    api(Response.json(empty));
    expect(text(await settled(PATH))).toContain("No activity in this range");

    api(Response.json({ ...insights, calibration: { ...insights.calibration, count: 12 } }));
    const few = await settled(PATH);
    expect(text(few)).toContain("untrusted: 12 outcomes Not enough outcomes Calibration shows once the verifier has 20 merged-or-rejected outcomes");
    expect(few).not.toContain('<div class="card-b card-sub"><svg class="reldiag"');
  });

  it("skeleton counts match the spec: 5 tiles, a 220px chart, two 180px charts with calibration's real axes and diagonal, 5 bar rows", async () => {
    api(new Promise(() => {}));
    const stop = new AbortController();
    const pending = prerender(await app(PATH), { signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    const html = await new Response((await pending).prelude).text();
    const count = (re) => html.match(re)?.length ?? 0;
    expect(count(/<div class="tile flat">/g)).toBe(5);
    expect(html).toContain('<div class="l">Brier score</div>');
    expect(count(/<div class="chart-skel" style="height:220px">/g)).toBe(1);
    expect(count(/<div class="chart-skel" style="height:180px">/g)).toBe(1);
    expect(html).toMatch(/<div class="card-b card-sub skel-cal"><svg class="reldiag"[^>]*>.*stroke-dasharray="4 4".*predicted p\(merge\)/);
    expect(count(/<div class="hb">/g)).toBe(5);
  });

  it("an API error shows the error state with Retry", async () => {
    api(new Response("", { status: 503 }));
    const error = await settled(PATH);
    expect(text(error)).toContain("Couldn't load insights");
    expect(error).toMatch(/<pre>GET \/api\/repos\/acme%2Fapi\/insights\?from=[^<]+: HTTP 503<\/pre>/);
    expect(error).toMatch(/<button[^>]*>.*Retry<\/button>/);
  });

  it("insights page: no color literal or font-family outside tokens.css", () => {
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    const tokens = readFileSync(new URL("styles/tokens.css", import.meta.url), "utf8");
    const defined = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
    const rules = css.slice(css.indexOf("/* Insights"), css.indexOf("/* Needs you"));
    expect(rules).toContain(".hb{");
    for (const [name, src] of [["app.css insights rules", rules], ["insights.jsx", readFileSync(new URL("insights.jsx", import.meta.url), "utf8")]]) {
      expect(src, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/);
      expect(src, name).not.toMatch(/font-family:\s*(?!var\(--font-)|fontFamily/);
      for (const [, v] of src.matchAll(/var\((--[\w-]+)/g)) expect(defined, `${name} ${v}`).toContain(v);
    }
  });
});
