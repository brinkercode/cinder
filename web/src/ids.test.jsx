import { renderToString } from "react-dom/server";
import { prerender } from "react-dom/static";
import { createMemoryRouter, createStaticHandler, createStaticRouter, RouterProvider, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repoAt } from "./fake-repos.js";
import { routes } from "./routes.jsx";
import { CollisionCard, warnings } from "./collisions.jsx";
import { WorkspaceStrip } from "./workspace-strip.jsx";

const A = "0b4f8c2e-5d6a-4e1b-9c3f-7a8b9c0d1e2f";
const B = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const at = new Date().toISOString();
const REPO = { id: "r", name: "web", default_branch: "main", strategy: "trunk", branch_policy: { integration: ["main"], release: [], check: "make check", stack: "code@v1" }, created_at: at };
const API = {
  "/api/needs": [{ id: "n1", kind: "Lease takeover", repo: "web", change: A, text: `maya wants lines 7–19, leased by ${B}.`, actions: ["Open change"] }],
  "/api/repos/web/work": { items: [{ kind: "change", n: null, change_id: A, title: "Retry", lane: "progress", priority: null, labels: [], author: "developer@v7",
    assignee: null, why: `Waits on ${B}`, updated_at: at }], tiles: { intents: 0, in_flight: 1, review: 0, merged_24h: 0, needs_you: 0, verifier: { pass: 0, n: 0, trusted: false } }, can_write: true },
  "/api/repos/web/flow-runs": [{ id: `change-r-ci-${A}`, flow: "ci", sha: "a".repeat(40), status: "done", created_at: at, steps: [] }],
  "/api/keystore": { secrets: [], wanted: [] },
};
const COLLISION = { id: "x1", ours: A, theirs: B, symbol: "src/a.js#f", kind: "signature", severity: "high", p: 1, message: `${B} leases f and your change changes its signature.`,
  action: "Stopped", detected_at: at, resolution: "stack", resolved_at: at };

// The rendered text with markup (and so the title and href attributes that carry the full id) removed.
const text = (html) => html.replace(/<[^>]*>/g, " ");
const page = async (path) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  return text(await new Response(prelude).text());
};
const inRepo = (el) => renderToString(<RouterProvider router={createMemoryRouter([{ path: "/:repo", element: el }], { initialEntries: ["/web"] })} />);
afterEach(() => vi.unstubAllEnvs());

describe("change ids", () => {
  it("no rendered text outside the short-id component contains a 36-character change id", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("fetch", async (url) => Response.json(repoAt(url, [REPO]) ?? API[url] ?? []));
    const leases = [{ symbol: "f", file: "src/a.js", holder: B, mode: "exclusive", waiting: [] }];
    const shown = {
      needs: await page("/needs"),
      board: await page("/web/changes"),
      flows: await page("/web/flows?view=runs"),
      lease: text(renderToString(<WorkspaceStrip ws={{ id: A, intent: "Retry" }} symbols={[]} driving={false} setDriving={() => {}} />)),
      collision: text(inRepo(<CollisionCard f={COLLISION} id={A} />)),
      warning: text(renderToString(<>{warnings({ editing: [{ symbol: "src/a.js#f", change_id: A, kind: "body" }] }, leases, "src/a.js")[0].text}</>)),
    };
    // Each surface did render the short id.
    for (const t of Object.values(shown)) expect(t).toMatch(/0b4f8c2e|7c1d2e3f/);
    expect(Object.entries(shown).filter(([, t]) => t.includes(A) || t.includes(B)).map(([k]) => k)).toEqual([]);
  });
});
