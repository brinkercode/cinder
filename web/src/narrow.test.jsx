import { readFileSync } from "node:fs";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { routes } from "./routes.jsx";

const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// Rules inside @media (max-width:900px) blocks, as [selector, body].
const narrow = [...css.matchAll(/@media \(max-width:900px\)\{((?:[^{}]+\{[^{}]*\})+)\}/g)]
  .flatMap(([, block]) => [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [sel.split(",").map((s) => s.trim()), body]));
const has = (sel, decl) => narrow.some(([sels, body]) => sels.includes(sel) && body.split(";").includes(decl));

const RUN = { id: "run-1", repo: "acme/api", change_id: "chg-12345678", state: "running", calls: [] };
const API = {
  "/api/repos": repos, "/api/repos/acme%2Fapi": repos.find((r) => r.name === "acme/api"), "/api/watchtower": { findings: [], scans: [], paused: false, scan_worker_online: true, fix_changes_open: 0 },
  "/api/agents": [{ name: "developer", versions: [{ id: "developer@1", name: "developer", version: 1, harness: "claude-code", model: "m", effort: "default", prompt_hash: "h",
    tools: [], limits: { max_cost_usd: 8, max_minutes: 120 }, released_at: null, egress: null, races: 0, wins: 0 }], channels: [{ channel: "stable", version: 1 }] }],
  "/api/fleet": { canary_auto_promote: false, agents: [{ name: "developer", role: "", tokens: 0, repos: 0, merged: 0, running: true, runs_24h: 1, tokens_24h: 0, cost_24h: 0, run: RUN, paused: null }] },
  "/api/keystore/usage": { used: 0, limit: 100 },
};
const page = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://x${path}`));
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />);
  return new Response(prelude).text();
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("390px overflow", () => {
  it("the shared seg and card-header styles below 900px set wrapping (flex-wrap: wrap / min-width: 0)", () => {
    for (const sel of [".seg", ".card-h", ".srow"]) expect(has(sel, "flex-wrap:wrap"), sel).toBe(true);
    for (const sel of [".seg>*", ".card-h>*", ".srow>*"]) expect(has(sel, "min-width:0"), sel).toBe(true);
    expect(has(".seg", "max-width:100%")).toBe(true);
  });

  it("the Watchtower severity seg, the agent run-card header and the Keystore Org model keys header render with those shared classes", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async (url) => Response.json(API[String(url).replace(/\/api\/repos\/[^/]+\/watchtower\?state=all$/, "/api/watchtower")] ?? []));
    // Each element's class must be one the narrow rules wrap, so reverting the CSS fails this too.
    const wraps = (html, re) => { const cls = html.match(re)?.[1]; expect(cls).toBeTruthy(); expect(has(`.${cls}`, "flex-wrap:wrap"), cls).toBe(true); };
    wraps(await page("/acme%2Fapi/watchtower?tab=dependencies"), /<div class="(\w+)" role="tablist" aria-label="Severity"/);
    wraps(await page("/automation/agents/developer/runs"), /<div class="([\w-]+)"><h3>Run <span class="mono">run-1<\/span>/);
    wraps(await page("/settings/keystore"), /<div class="(\w+)"><span class="act-i">(?:(?!<\/h3>).)*<h3>Org model keys<\/h3>/);
  });

  it("the Code toolbar and Issues column rules below 900px set wrapping / content height", () => {
    expect(has(".code-bar>[role=\"search\"]", "flex-basis:100%")).toBe(true);
    expect(has(".f-board .board", "flex:none")).toBe(true);
    expect(has(".col", "min-height:max-content")).toBe(true);
    expect(has(".col", "max-height:60vh")).toBe(false);
  });
});
