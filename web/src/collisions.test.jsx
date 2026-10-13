import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import changes from "../../worker/src/api/fixtures/changes.json";
import collisions from "../../worker/src/api/fixtures/collisions.json";
import leaseFixture from "../../worker/src/api/fixtures/lease-map.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

vi.mock("./monaco.jsx", () => ({ default: () => null, colorize: () => Promise.reject(new Error("no monaco in tests")) }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Code, codeLoader } = await import("./code.jsx");
const { Collisions } = await import("./collisions.jsx");
const { forgetTrees } = await import("./client.js");

const repo = repos[0];
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const mount = async (path, route) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  const sockets = [];
  vi.stubGlobal("WebSocket", class { constructor() { sockets.push(this); } close() {} });
  const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [route] }], { initialEntries: [path] });
  const root = doc.body.appendChild(new El("div"));
  const r = createRoot(root);
  onTestFinished(() => act(() => r.unmount())); // stops its live listeners, as leaving the page does
  await act(async () => r.render(<RouterProvider router={router} />));
  await settle();
  return { root, sockets, router };
};
afterEach(() => { vi.unstubAllEnvs(); forgetTrees(); });

const open = collisions.feed[0];
const leaseMap = (leases) => ({ conflicts: { merges: 4, conflicted: 1, days: 7 }, edges: [], leases,
  changes: [{ id: "c-1037", state: "in_queue", intent: "Matcher", seam: false, stacked_on: null }, { id: "c-1042", state: "developing", intent: "Headers", seam: false, stacked_on: null }] });

describe("collisions", () => {
  const page = `/${encodeURIComponent(repo.name)}/changes/collisions`;
  const route = { path: "changes/collisions", element: <Collisions /> };
  const text = (n) => n.textContent;
  const button = (root, label) => all(root).find((n) => n.nodeName === "BUTTON" && text(n) === label);
  const radio = (root, label) => all(root).find((n) => n.attrs.role === "radio" && text(n) === label);
  const merge = (root) => all(all(root).find((n) => n.attrs["aria-label"] === "Merge order after")).filter((n) => n.nodeName === "LI").map(text);

  it("each control resolves the collision and the page shows it resolved after the live event", async () => {
    const options = [["Stack", "Stack c-1042 on c-1037", "stack", "Stacked"], ["Seam", "Propose a seam", "seam", "Seam proposed"],
      ["Hand over", "Hand RouteMatcher to c-1042", "handover", "Handed over"], ["Go first", "Let c-1042 go first", "reprioritize", "Went first"]];
    for (const [short, label, action, done] of options) {
      let feed = collisions.feed;
      const posts = [];
      vi.stubGlobal("fetch", async (url, init) => {
        if (url === "/api/live-ticket") return Response.json({ ticket: "t1" });
        if (init?.method === "POST") { posts.push([url, JSON.parse(init.body)]); feed = feed.map((f) => (f === open ? { ...f, resolution: action, resolved_at: new Date().toISOString() } : f)); return Response.json({ resolution: action }); }
        if (url === `${base}/collisions?target=main`) return Response.json({ ...collisions, feed });
        if (url === `${base}/lease-map?target=main`) return Response.json(leaseMap([]));
        return new Promise(() => {});
      });
      const { root } = await mount(page, route);
      await act(async () => click(radio(root, short)));
      await act(async () => click(button(root, label)));
      await settle();
      expect(posts).toEqual([[`/api/changes/${open.ours}/collisions/resolve`, { action }]]);
      expect(button(root, label)).toBeUndefined();
      expect(text(root)).toContain(`${done}: ${open.ours} on ${open.theirs}`);
    }
  });

  it("a code-page warning appears when the live event brings an editing signal", async () => {
    let editing = [];
    const api = {
      [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", remote: "https://a.example/x.git", entries: [{ name: "app.js", path: "src/app.js", type: "blob" }] },
      [`${base}/changes`]: changes.filter((c) => c.id === "c_01"),
      [`${base}/branches`]: [],
      [`${base}/file?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", size: 3, content: "a\nb" },
      [`${base}/symbols?target=main`]: { sha: "m1", symbols: [] },
      [`${base}/authorship?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", lines: null },
      [`${base}/log?ref=main&path=src%2Fapp.js`]: { ref: "main", sha: "m1", path: "src/app.js", commits: [], more: false },
      [`${base}/log?ref=main&page=1`]: { ref: "main", sha: "m1", path: "", commits: [{ sha: "m1", message: "Add", author: "ana" }], more: false, total: 1 },
      [`${base}/lease-map`]: { ...leaseMap([{ symbol: "src/app.js#retryCapture", file: "src/app.js", holder: "c_01", mode: "exclusive", waiting: [] }]),
        changes: [{ id: "c_01", state: "draft", intent: "Run", seam: false, stacked_on: null }] },
      "/api/live-ticket": { ticket: "t1" },
    };
    vi.stubGlobal("fetch", (url) => (url === `${base}/collisions?target=main` ? Promise.resolve(Response.json({ feed: [], editing }))
      : api[url] ? Promise.resolve(Response.json(api[url])) : new Promise(() => {})));
    const { root, sockets } = await mount(`/${encodeURIComponent(repo.name)}/code/main/src/app.js`, { path: "code/:ref/*", element: <Code />, loader: codeLoader });
    const warns = () => all(root).filter((n) => n.attrs.class === "col-warn").map((n) => n.textContent);
    expect(warns()).toEqual([]);
    editing = [{ symbol: "src/app.js#retryCapture", change_id: "c-1041", kind: "signature", at: new Date().toISOString() }];
    await act(async () => sockets.forEach((s) => s.onmessage({ data: "{}" })));
    await settle();
    expect(warns()).toEqual(["c-1041 is changing the signature of retryCapture, which c_01 leases"]);
  });

  it("feed rows list every message", async () => {
    vi.stubGlobal("fetch", async (url) => {
      if (url === `${base}/collisions?target=main`) return Response.json(collisions);
      if (url === `${base}/lease-map?target=main`) return Response.json(leaseMap([]));
      return new Promise(() => {});
    });
    const { root } = await mount(page, route);
    const feed = all(root).find((n) => n.attrs["aria-label"] === "Collision diagnostics");
    const told = all(feed).filter((n) => n.nodeName === "DL");
    expect(told).toHaveLength(collisions.feed.length);
    collisions.feed.forEach((f, i) => expect(told[i].textContent).toContain(f.message));
  });

  // The lease map as the worker sends it: overlapping leases are "lease" edges, judged edges carry calibrated.
  const lease = { p: 1, judge: { name: "lease", count: 0, trusted: true } };
  const map = { ...leaseFixture, edges: [
    ...leaseFixture.edges.filter((e) => !(e.a === "c-1042" && e.b === "c-1050")).map((e) => (e.judge.trusted ? { ...e, calibrated: +(e.p - 0.04).toFixed(2) } : e)),
    { a: "c-1037", b: "c-1045", ...lease }, { a: "c-1042", b: "c-1050", ...lease }] };
  const server = (feed = collisions.feed, resolve = () => Response.json({ resolution: "seam" })) => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      if (url === "/api/live-ticket") return new Response(null, { status: 204 });
      calls.push([url, init?.method === "POST" ? JSON.parse(init.body) : undefined]);
      if (init?.method === "POST") return resolve();
      if (url.startsWith(`${base}/collisions?`)) return Response.json({ ...collisions, feed });
      if (url.startsWith(`${base}/lease-map?`)) return Response.json(map);
      return new Promise(() => {});
    });
    return calls;
  };
  const pairs = (root) => all(all(root).find((n) => n.attrs["aria-label"] === "Pairs at risk" && n.nodeName === "UL")).filter((n) => n.nodeName === "LI");

  it("pairs, lease chips and resolve options name changes by their repo key", async () => {
    const keyed = { ...map, changes: map.changes.map((c, i) => ({ ...c, key: `EDGE-${40 + i}` })) };
    const keyOf = Object.fromEntries(keyed.changes.map((c) => [c.id, c.key]));
    vi.stubGlobal("fetch", async (url) => {
      if (url === "/api/live-ticket") return new Response(null, { status: 204 });
      if (url.startsWith(`${base}/collisions?`)) return Response.json(collisions);
      if (url.startsWith(`${base}/lease-map?`)) return Response.json(keyed);
      return new Promise(() => {});
    });
    const { root } = await mount(page, route);
    // The untrusted pair sorts last (see the test below).
    expect(pairs(root).at(-1).textContent).toContain(`${keyOf["c-1044"]}×${keyOf["c-1051"]}`);
    expect(root.textContent).not.toContain("c-1044×c-1051");
  });

  it("one pair row per edge, lease edges first, untrusted last, no % on lease or untrusted", async () => {
    server();
    const { root } = await mount(page, route);
    expect(all(root).some((n) => n.nodeName === "svg" || n.attrs.class === "graph")).toBe(false);
    const rows = pairs(root);
    expect(rows).toHaveLength(map.edges.length);
    expect(rows.slice(0, 2).map(text)).toEqual([expect.stringContaining("leases overlap"), expect.stringContaining("leases overlap")]);
    expect(rows.at(-1).textContent).toContain("c-1044×c-1051untrusted: 64 outcomes");
    for (const r of [...rows.slice(0, 2), rows.at(-1)]) {
      expect(r.textContent).not.toMatch(/%/);
      expect(all(r).some((n) => n.attrs.class?.startsWith("pb"))).toBe(false);
    }
  });

  it("the % shown is calibrated when present", async () => {
    server();
    const { root } = await mount(page, route);
    const shown = pairs(root).slice(2, -1).map((r) => all(r).find((n) => n.nodeName === "B").textContent);
    expect(shown).toEqual(["44%", "29%", "18%", "10%", "8%", "5%", "2%"]);
    const pct = all(pairs(root)[2]).find((n) => n.nodeName === "B");
    expect(pct.attrs.title).toBe("raw 48%, calibrated 44%");
  });

  it("selecting Seam changes the preview text and the button label, and clicking posts {action: \"seam\"}", async () => {
    const calls = server();
    const { root } = await mount(page, route);
    expect(radio(root, "Stack").attrs["aria-checked"]).toBe("true");
    expect(button(root, "Stack c-1042 on c-1037")).toBeDefined();
    await act(async () => click(radio(root, "Seam")));
    expect(radio(root, "Seam").attrs["aria-checked"]).toBe("true");
    expect(text(all(root).find((n) => n.attrs.class === "rprev"))).toContain("An agent opens a small change that lands the new RouteMatcher on its own.");
    expect(merge(root)).toEqual(["seam change", "c-1042in parallelc-1037"]);
    await act(async () => click(button(root, "Propose a seam")));
    await settle();
    expect(calls.filter(([, body]) => body)).toEqual([["/api/changes/c-1042/collisions/resolve", { action: "seam" }]]);
  });

  it("the merge order for Stack and Go first follows stacked_on and waiting in the lease map", async () => {
    server();
    const { root } = await mount(page, route);
    expect(merge(root)).toEqual(["c-1037", "c-1042", "c-1050"]);
    await act(async () => click(radio(root, "Go first")));
    expect(merge(root)).toEqual(["c-1042", "c-1050", "c-1037", "c-1045"]);
  });

  it("the suggested mark renders only when suggested is present", async () => {
    server([{ ...open, suggested: null }, ...collisions.feed.slice(1)]);
    const plain = await mount(page, route);
    expect(text(plain.root)).not.toContain("Suggested");
    expect(all(plain.root).some((n) => n.attrs.class === "sug-dot")).toBe(false);
    const why = "c-1037 is in queue and is a seam change; stacking waits the least.";
    server([{ ...open, suggested: { action: "handover", why } }, ...collisions.feed.slice(1)]);
    const { root } = await mount(page, route);
    expect(radio(root, "Hand over").attrs["aria-checked"]).toBe("true");
    expect(all(radio(root, "Hand over")).some((n) => n.attrs.class === "sug-dot")).toBe(true);
    expect(text(root)).toContain(`Suggested ${why}`);
  });

  it("a 409 renders \"no longer in conflict\" inline and refetches; another error keeps the .col-err line", async () => {
    let status = 409;
    const calls = server(collisions.feed, () => Response.json({ error: { code: "change_moved", message: "change c-1042 is no longer in conflict" } }, { status }));
    const { root } = await mount(page, route);
    const gets = (p) => calls.filter(([url, body]) => !body && url.startsWith(`${base}/${p}?`)).length;
    const before = [gets("collisions"), gets("lease-map")];
    await act(async () => click(button(root, "Stack c-1042 on c-1037")));
    await settle();
    const card = all(root).find((n) => n.attrs["aria-label"] === "Open collision");
    expect(text(all(card).find((n) => n.attrs.class === "errst sm"))).toContain("c-1042 is no longer in conflict: cinder or another person settled it");
    expect([gets("collisions"), gets("lease-map")]).toEqual([before[0] + 1, before[1] + 1]);
    status = 500;
    await act(async () => click(button(root, "Stack c-1042 on c-1037")));
    await settle();
    expect(all(root).some((n) => n.attrs.class === "errst sm")).toBe(false);
    expect(text(all(root).find((n) => n.attrs.class === "col-err"))).toContain("→ 500");
  });

  it("switching the target branch refetches both requests with ?target=", async () => {
    const calls = server();
    const { router } = await mount(page, route);
    expect(calls.map(([url]) => url)).toEqual(expect.arrayContaining([`${base}/collisions?target=main`, `${base}/lease-map?target=main`]));
    await act(async () => router.navigate(`${page}?target=release%2F2.4`));
    await settle();
    expect(calls.map(([url]) => url)).toEqual(expect.arrayContaining([`${base}/collisions?target=release%2F2.4`, `${base}/lease-map?target=release%2F2.4`]));
  });
});
