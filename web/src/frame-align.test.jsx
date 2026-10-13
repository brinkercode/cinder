import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./lib/markdown.jsx";
import { routes } from "./routes.jsx";

afterEach(() => { vi.unstubAllEnvs(); });

const render = async (path) => {
  vi.stubEnv("VITE_FIXTURES", "1");
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://cinder.test${path}`));
  const { prelude } = await prerender(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  return new Response(prelude).text();
};

// Tag-stack walk of the server HTML: each element's classes, inline style and parent.
const tree = (html) => {
  const els = [], stack = [];
  for (const [tag, close, name, attrs] of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
    if (close) { while (stack.length && stack.pop().name !== name); continue; }
    const el = { name, parent: stack.at(-1), cls: (/ class="([^"]*)"/.exec(attrs)?.[1] ?? "").split(" ").filter(Boolean), style: / style="([^"]*)"/.exec(attrs)?.[1] ?? "" };
    els.push(el);
    if (!tag.endsWith("/>") && !/^(input|img|br|hr|meta|link)$/.test(name)) stack.push(el);
  }
  return els;
};
const up = (el, cls) => { for (let n = el; n; n = n.parent) if (n.cls.includes(cls)) return n; };

const R = "/acme%2Fweb";
const ROUTES = ["/", "/needs", "/automation/agents", "/automation/judges", "/automation/workers", "/settings/access", "/settings/keystore", "/me/models",
  "/wiki/acme%2Fweb", `${R}/watchtower`, `${R}/code/develop`, `${R}/changes`, `${R}/releases`, `${R}/insights`,
  `${R}/environments`, `${R}/flows`, `${R}/settings`, `${R}/changes/new`];

describe("one content frame", () => {
  it.each(ROUTES)("every route, including /:repo/watchtower and /:repo/code, renders one .frame with the h1, toolbar and first body element in the same .fc container (%s)", async (path) => {
    const els = tree(await render(path));
    const frames = els.filter((e) => e.cls.includes("frame"));
    expect(frames).toHaveLength(1);
    const inFrame = els.filter((e) => up(e, "frame") === frames[0]);
    const h1 = inFrame.find((e) => e.name === "h1");
    const toolbar = inFrame.find((e) => e.cls.some((c) => ["tb", "tb-in", "toolbar"].includes(c)));
    const first = inFrame.find((e) => e.parent?.cls.includes("f-body"));
    const fc = up(first, "fc");
    expect(fc, "first body element inside a .fc").toBeTruthy();
    for (const el of [h1, toolbar].filter(Boolean)) expect(up(el, "fc"), `<${el.name}> in the body's .fc`).toBe(fc);
    expect(inFrame.filter((e) => e.cls.includes("fc"))).toEqual([fc]);
    expect(els.filter((e) => /max-width|margin[^;]*auto/.test(e.style)).map((e) => e.name)).toEqual([]);
  }, 30000);

  it("/:repo/watchtower renders the same frame class list as /:repo/code", async () => {
    // The frame's own classes and its containers', without the page's scope class (.wt, .cd and so on).
    const frame = async (path) => tree(await render(path)).filter((e) => up(e, "frame"))
      .flatMap((e) => e.cls.filter((c) => /^(frame|fc|ph|ph-in|f-.+)$/.test(c)).map((c) => `${e.name}.${c}`)).filter((c, i, a) => a.indexOf(c) === i);
    expect(await frame(`${R}/watchtower`)).toEqual(await frame(`${R}/code/develop`));
  });

  it("reading blocks (markdown, wiki page pane, change description) cap at 760px, left-aligned to the frame edge", async () => {
    // The wiki page pane renders through Markdown, so its .md root carries the cap.
    expect(renderToStaticMarkup(<Markdown text="Leases first." />)).toMatch(/^<div class="md">/);
    expect(await render(`${R}/changes/c_07`)).toMatch(/<div class="cmt-b cd-desc"><p><b>Intent<\/b>/);
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    for (const sel of [".md", ".cd-desc"]) {
      const body = [...css.matchAll(/(?:^|[}\n])([^{}]+)\{([^{}]*)\}/g)].find(([, s]) => s.trim() === sel)?.[2];
      expect(body, sel).toMatch(/(^|;)max-width:760px(;|$)/);
      expect(body, sel).not.toMatch(/margin[^;]*auto/);
    }
  });
});
