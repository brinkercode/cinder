import { readFileSync } from "node:fs";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { routes } from "./routes.jsx";

const render = async (path, init) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`, init));
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  return (await new Response(prelude).text()).replace(/<!-- -->| data-discover="true"/g, "");
};
const repos = JSON.parse(readFileSync(new URL("../../worker/src/api/fixtures/repos.json", import.meta.url), "utf8"));
const NEED = { id: "b1", kind: "Budget reached", repo: "account", change: null, text: "The 2026-10 token budget of 10000000 is reached: agent work is paused", actions: ["Raise budget", "Resume"] };
const AGENT = { name: "developer", role: "", tokens: 0, repos: 0, merged: 0, running: false, runs_24h: 0, tokens_24h: 0, cost_24h: 0, run: null };
// A live server with 10M tokens spent: the budget is 10M until a Raise budget post sets it, Resume resolves the item.
const live = (owner) => {
  const posts = [];
  let budget = 10e6;
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (path, init) => {
    if (init?.method === "POST") {
      posts.push([path, init.body]);
      budget = JSON.parse(init.body).amount ?? budget;
      return Response.json({});
    }
    const paused = budget <= 10e6;
    const body = { "/api/repos": repos, "/api/needs": posts.some(([, b]) => b.includes("Resume")) ? [] : [NEED], "/api/me": { email: "ana@x.dev", owner },
      "/api/account": { budget_tokens: budget, spent: 10e6, paused, when_reached: "pause", resets_at: "2026-11-01T00:00:00.000Z", owners: ["maya@x.dev"] },
      "/api/fleet": { canary_auto_promote: false, agents: [{ ...AGENT, paused: paused ? { reason: "budget", resumes_at: "2026-11-01T00:00:00.000Z" } : null }] } }[path];
    return body ? Response.json(body) : new Response("", { status: 404 });
  });
  return posts;
};
const post = (fields) => {
  const body = new FormData();
  for (const [k, v] of Object.entries({ id: "b1", repo: "account", ...fields })) body.set(k, v);
  return render("/needs", { method: "POST", body });
};
const button = (html, action) => new RegExp(`<button type="submit" value="${action}"[^>]*>`).exec(html)[0];

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("raising above spent resumes agents", async () => {
  const posts = live(true);
  const before = await render("/needs");
  expect(before).toMatch(/<span class="pill mono">.*?developer<\/span>/);
  expect(before).toContain('min="11" step="1" aria-label="New budget in millions of tokens" name="millions" value="11"');
  expect(button(before, "Resume")).toContain("disabled");

  const raised = await post({ action: "Raise budget", millions: "15" });
  expect(posts).toEqual([["/api/needs/b1/resolve", '{"action":"Raise budget","amount":15000000}']]);
  expect(button(raised, "Resume")).not.toContain("disabled");

  const resumed = await post({ action: "Resume", millions: "15" });
  expect(posts[1]).toEqual(["/api/needs/b1/resolve", '{"action":"Resume"}']);
  expect(resumed).not.toContain("Budget reached");
});

it("only owners see enabled controls", async () => {
  live(false);
  const html = await render("/needs");
  expect(html).toContain('step="1" disabled="" aria-label="New budget in millions of tokens"');
  expect(button(html, "Raise budget")).toContain("disabled");
  expect(button(html, "Resume")).toContain("disabled");
  expect(html).toContain("Only owners can raise the budget: maya@x.dev");
  expect(html).toContain('href="mailto:maya@x.dev?subject=Raise%20the%20token%20budget">Ask maya@x.dev</a>');

  vi.unstubAllGlobals();
  live(true);
  const owner = await render("/needs");
  expect(button(owner, "Raise budget")).not.toContain("disabled");
  expect(owner).not.toContain("Only owners can raise the budget");
});
