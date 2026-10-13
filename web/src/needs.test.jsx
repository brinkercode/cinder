import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import needs from "../../worker/src/api/fixtures/needs.json";
import { NEED_KINDS } from "../../worker/src/api/shapes/need.js";
import { routes } from "./routes.jsx";

// prerender waits for the sidebar's and bell's deferred counts.
const render = async (path, init) => {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`, init));
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  return (await new Response(prelude).text()).replace(/<!-- -->| data-discover="true"/g, "");
};
const repos = JSON.parse(readFileSync(new URL("../../worker/src/api/fixtures/repos.json", import.meta.url), "utf8"));
// GET /api/needs answers needsRes(posts so far); a POST is recorded and answered 200.
const live = (needsRes) => {
  const posts = [];
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (path, init) => {
    if (init?.method === "POST") return posts.push([path, init.body]) && Response.json({});
    return path === "/api/repos" ? Response.json(repos) : needsRes(posts);
  });
  return posts;
};
const cards = (html) => html.match(/<form [^>]*class="lc"/g) ?? [];
const count = (html) => /<span>Needs you<\/span><!--\$-->(?:<span class="count">(\d+)<\/span>)?<!--\/\$-->/.exec(html)?.[1];

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("needs you page", () => {
  it("the counts in the sidebar, the bell dot and the page agree, before and after an action resolves an item", async () => {
    const posts = live((p) => Response.json(p.length ? needs.slice(1) : needs));
    const html = await render("/needs");
    expect([cards(html).length, count(html)]).toEqual([4, "4"]);
    expect(html).toContain('<span class="bell-dot"></span>');
    expect(html).toContain('<span class="lc-ico warn">');
    expect(html).toContain('Judges disagree<span class="tag">edge-router</span><span class="ch"><span class="mono" title="c-1101">c-1101</span></span>');
    expect(html).toContain('value="Merge" class="btn btn-primary btn-sm" name="action">Merge</button><button type="submit" value="Reject" class="btn btn-secondary btn-sm" name="action">Reject</button>');
    expect(html.match(/value="Dismiss" class="btn btn-ghost btn-sm" name="action">Dismiss<\/button>/g)).toHaveLength(4);

    const body = new FormData();
    for (const [k, v] of Object.entries({ id: "n1", repo: "edge-router", change: "c-1101", action: "Merge" })) body.set(k, v);
    const after = await render("/needs", { method: "POST", body });
    expect(posts).toEqual([["/api/needs/n1/resolve", '{"action":"Merge"}']]);
    expect([cards(after).length, count(after)]).toEqual([3, "3"]);
    expect(after).not.toContain("Judges disagree");
  });

  it("clicking Open change navigates to the change detail path and makes no resolve request", async () => {
    const posts = live(() => Response.json(needs));
    const body = new FormData();
    for (const [k, v] of Object.entries({ id: "n1", repo: "edge-router", change: "c-1101", action: "Open change" })) body.set(k, v);
    const handler = createStaticHandler(routes);
    const res = await handler.query(new Request("http://cinder.test/needs", { method: "POST", body }));
    expect([res.status, res.headers.get("Location")]).toEqual([302, "/edge-router/changes/c-1101"]);
    expect(posts).toEqual([]);
  });

  it("a need kind the page doesn't know renders in the list instead of crashing", async () => {
    live(() => Response.json([{ id: "n9", kind: "Stale wiki page", repo: "edge-router", change: null, page: "p1", text: "Config is stale", actions: ["Mark reviewed"] }]));
    const html = await render("/needs");
    expect(cards(html)).toHaveLength(1);
    expect(html).toContain('<span class="lc-ico info">');
    expect(html).toContain("Stale wiki page<span class=\"tag\">edge-router</span>");
    expect(html).toContain('<input type="hidden" name="page" value="p1"/>');
  });

  it("Open page and Open Insights navigate and make no resolve request", async () => {
    const posts = live(() => Response.json(needs));
    const go = async (action) => {
      const body = new FormData();
      for (const [k, v] of Object.entries({ id: "n9", repo: "edge-router", page: "p1", action })) body.set(k, v);
      return (await createStaticHandler(routes).query(new Request("http://cinder.test/needs", { method: "POST", body }))).headers.get("Location");
    };
    expect([await go("Open page"), await go("Open Insights")]).toEqual(["/wiki/edge-router/p1", "/insights"]);
    expect(posts).toEqual([]);
  });

  // Budget alert, Wiki comment and Stale wiki page items, and one agent for the Hand to an agent picker.
  const NEW = [
    { id: "n7", kind: "Budget alert", repo: "account", change: null, text: "80% of the token budget used", actions: ["Raise budget", "Open Insights", "Edit alerts"] },
    { id: "n8", kind: "Wiki comment", repo: "edge-router", change: null, page: "p1", text: "jon commented on Config: typo", actions: ["Open page", "Resolve"] },
    { id: "n9", kind: "Stale wiki page", repo: "edge-router", change: "c-1101", page: "p1", text: "Config names code c-1101 changed", actions: ["Mark reviewed", "Edit", "Hand to agent"] },
  ];
  const AGENTS = [{ name: "developer", versions: [{ id: "developer@7", name: "developer", version: 7, harness: "claude-code", model: "m", effort: "default", prompt_hash: "h",
    tools: [], limits: { max_cost_usd: 8, max_minutes: 120 }, released_at: null, egress: null, races: 0, wins: 0 }], channels: [{ channel: "stable", version: 7 }] }];
  const liveNew = () => live((p) => Response.json(p.length ? [] : NEW));
  const submit = (fields) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    return { method: "POST", body };
  };

  it("budget alert, wiki comment and stale wiki page: each action resolves or navigates as labelled", async () => {
    vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
    const posts = liveNew();
    const fetch0 = globalThis.fetch;
    vi.stubGlobal("fetch", (path, init) => (path === "/api/agents" ? Response.json(AGENTS) : fetch0(path, init)));
    const html = await render("/needs");
    expect(html).toContain('<button type="submit" value="developer@v7" class="btn btn-ghost mono" name="agent">developer@v7</button>');
    for (const a of ["Raise budget", "Open Insights", "Edit alerts", "Open page", "Resolve", "Mark reviewed", "Edit", "Reply", "Hand to an agent"]) expect(html).toContain(`>${a}</button>`);

    const go = async (fields) => (await createStaticHandler(routes).query(new Request("http://cinder.test/needs", submit(fields)))).headers?.get("Location");
    const at = (n) => ({ id: n.id, kind: n.kind, repo: n.repo, ...(n.page && { page: n.page }) });
    expect([await go({ ...at(NEW[0]), action: "Raise budget" }), await go({ ...at(NEW[0]), action: "Open Insights" }), await go({ ...at(NEW[0]), action: "Edit alerts" }),
      await go({ ...at(NEW[1]), action: "Open page" }), await go({ ...at(NEW[2]), action: "Edit" })])
      .toEqual(["/", "/insights", "/", "/wiki/edge-router/p1", "/wiki/edge-router/p1?v=edit"]);
    expect(posts).toEqual([]);

    await go({ ...at(NEW[1]), action: "Resolve" });
    await go({ ...at(NEW[2]), action: "Mark reviewed" });
    await go({ ...at(NEW[2]), agent: "developer@v7" });
    expect(posts).toEqual([["/api/needs/n8/resolve", '{"action":"Resolve"}'], ["/api/needs/n9/resolve", '{"action":"Mark reviewed"}'],
      ["/api/needs/n9/resolve", '{"action":"Hand to agent","agent":"developer@v7"}']]);
  });

  it("a reply on a Wiki comment item posts to the wiki page's comment thread and leaves the item open", async () => {
    const posts = live(() => Response.json(NEW));
    const html = await render("/needs", submit({ id: "n8", kind: "Wiki comment", repo: "edge-router", page: "p1", action: "Reply", body: " on it " }));
    expect(posts).toEqual([["/api/repos/edge-router/wiki/pages/p1/comments", '{"body":"on it"}']]);
    expect(html).toContain('<span role="status">Replied “on it”</span>');
    expect(html).toContain("Wiki comment<span class=\"tag\">edge-router</span>");
  });

  it("Dependency needs approval shows its why with Approve, Reject with a reason and Open change; Test quarantined says what Release and Keep do", async () => {
    vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
    const why = "Blocked: new dependency p-retry 6.2.1 needs approval";
    const items = [{ id: "n10", kind: "Dependency needs approval", repo: "edge-router", change: "c-1044", text: `${why} · guarded 2026-10-08T09:00:00.000Z`, actions: ["Approve", "Reject", "Open change"] },
      { id: "n11", kind: "Test quarantined", repo: "edge-router", change: null, text: "t1 is quarantined: its failures no longer fail verify", actions: ["Release", "Keep"] }];
    const posts = live(() => Response.json(items));
    const html = await render("/needs");
    expect(html).toContain(why);
    expect(html).toContain('aria-label="Reason"');
    for (const a of ["Approve", "Reject", "Open change", "Release", "Keep"]) expect(html).toContain(`>${a}</button>`);
    expect(html).toContain("Release: it counts in the verdict again. Keep: it stays out of verdicts.");
    await render("/needs", submit({ id: "n10", kind: items[0].kind, repo: "edge-router", change: "c-1044", action: "Reject", reason: "We retry in-house" }));
    expect(posts).toEqual([["/api/needs/n10/resolve", '{"action":"Reject","reason":"We retry in-house"}']]);
  });

  it("needs you: loading, empty and error states (stubbed fetch) render skeleton cards, Nothing needs you and a card error with Retry", async () => {
    const route = routes[0].children.find((r) => r.path === "/needs");
    expect(renderToString((await route.lazy()).hydrateFallbackElement).match(/class="card skel-card"/g)).toHaveLength(3);

    live(() => Response.json([]));
    const empty = await render("/needs");
    expect(empty).toContain("<h3>Nothing needs you</h3><p>The verifier is merging on its own. New judge disagreements, lease requests and critical advisories land here.</p>");
    expect([cards(empty).length, count(empty), empty.includes("bell-dot")]).toEqual([0, undefined, false]);

    live(() => new Response("", { status: 503 }));
    const error = await render("/needs");
    expect(error).toContain('<div class="lc"><div class="err" role="alert"><span class="dot bad"></span><span>Couldn&#x27;t load Needs you: /api/needs: HTTP 503</span><button type="button" class="btn btn-secondary">Retry</button>');
  });

  it("needs you page: no color literal or font-family outside tokens.css", () => {
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    const page = readFileSync(new URL("needs.jsx", import.meta.url), "utf8");
    const rules = css.slice(css.indexOf("/* Needs you"), css.indexOf("/* Code. */"));
    expect(rules).toContain(".lc{");
    for (const [name, src] of [["app.css needs rules", rules], ["needs.jsx", page]]) {
      expect(src, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/);
      expect(src, name).not.toMatch(/font-family:\s*(?!var\(--font-)|fontFamily/);
    }
  });
});

describe("needs you tabs", () => {
  const tabs = (html) => [...html.matchAll(/<button type="button" role="tab" aria-selected="(true|false)"[^>]*>([^<]+)<span class="nd-n">(\d+)<\/span>/g)].map((m) => [m[2], m[3], m[1] === "true"]);

  it("tabs filter items by kind and show each tab's count", async () => {
    live(() => Response.json(needs));
    const all = await render("/needs");
    expect(tabs(all)).toEqual([["All", "4", true], ["Judges", "2", false], ["Security", "1", false], ["Leases", "1", false]]);
    expect(cards(all)).toHaveLength(4);
    const judges = await render("/needs?tab=judges");
    expect(cards(judges)).toHaveLength(2);
    expect(judges).not.toContain("Lease takeover<span");
    expect(judges).not.toContain("Critical advisory<span");
    const wiki = await render("/needs?tab=wiki");
    expect(tabs(wiki).find(([l]) => l === "Wiki")).toEqual(["Wiki", "0", true]);
    expect([cards(wiki).length, wiki.includes("<h3>Nothing here</h3>")]).toEqual([0, true]);
  });

  it("the selected tab is kept in ?tab= across a reload", async () => {
    live(() => Response.json(needs));
    for (let i = 0; i < 2; i++) {
      const html = await render("/needs?tab=leases");
      expect(tabs(html).filter(([, , on]) => on)).toEqual([["Leases", "1", true]]);
      expect(cards(html)).toHaveLength(1);
    }
    expect(tabs(await render("/needs?tab=nope")).filter(([, , on]) => on)).toEqual([["All", "4", true]]);
  });
});

describe("needs you approvals", () => {
  const flow = (can_resolve) => ({ id: "f1", kind: "Flow approval", repo: "edge-router", change: null, text: "Approve step approve-prod of flow deploy",
    actions: ["Approve", "Reject"], approvers: "production owners", approver_names: ["maya", "jon"], can_resolve });
  const action = (html, a) => new RegExp(`<button type="submit"[^>]*value="${a}"[^>]*>`).exec(html)[0];

  it("disabled state comes from can_resolve and the gate role: a Flow approval the caller can't resolve disables Approve and Reject", async () => {
    live(() => Response.json([flow(false)]));
    const html = await render("/needs");
    expect(action(html, "Approve")).toContain('disabled=""');
    expect(action(html, "Reject")).toContain('disabled=""');
    live(() => Response.json([flow(true)]));
    const ok = await render("/needs");
    expect(action(ok, "Approve")).not.toContain("disabled");
    expect(ok).not.toContain("can approve:");
  });

  it("who can approve is listed by name on a Flow approval the caller can't resolve", async () => {
    live(() => Response.json([flow(false)]));
    expect(await render("/needs")).toContain("Only <b>production owners</b> can approve: maya, jon");
  });
});

it("docs list matches shipped need kinds", () => {
  const doc = readFileSync(new URL("../../docs/testing/pages/needs-you.md", import.meta.url), "utf8");
  const checks = doc.match(/^\| NEED-[\d.]+ \|.*$/gm).join("\n");
  expect(NEED_KINDS.filter((k) => !checks.includes(k))).toEqual([]);
  expect(doc).not.toMatch(/no raiser/);
});
