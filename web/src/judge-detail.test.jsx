import { afterEach, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Judges, judgesLoader } = await import("./judges.jsx");

const judge = (model_version) => ({ kind: "risk", backend: "clef", model_version, count: 412, trusted: true, brier: 0.082,
  bins: [{ lo: 0, hi: 0.5, count: 200, mean_p: 0.25, observed: 0.3 }, { lo: 0.5, hi: 1, count: 212, mean_p: 0.75, observed: 0.7 }], health: "healthy", reason: null, fallbacks: 0,
  recent: [{ repo: "edge-router", change_id: "c_01", p: 0.18, correct: true }, { repo: "edge-router", change_id: null, p: 0.4, correct: null }] });

const CONFIG = { kind: "risk", airlock: false, min_outcomes: 50, min_confidence: null };
// extra overrides the judge's fields (or is a function of the request URL, to differ per repo); names are the repos, each serving the same judge; the airlock PUT answers with the setting it was asked for.
const mount = async (path, extra = {}, names = ["edge-router"]) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => Response.json(url === "/api/repos" ? names.map((name) => ({ ...repos[0], name }))
    : url.endsWith("/airlock") ? { ...CONFIG, airlock: JSON.parse(init.body).on }
      : { airlock: false, trust: { min_outcomes: 200, min_races: 30 }, judges: [{ ...judge("clef-2"), config: CONFIG,
        history: [{ backend: "clef", model_version: "clef-1", count: 412, trusted: true, brier: 0.082 }], ...(typeof extra === "function" ? extra(url) : extra) }] })));
  const router = createMemoryRouter([{ path: "/automation/judges/:id?", element: <Judges />, loader: judgesLoader }], { initialEntries: [path] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return { root, router, find: (pred) => all(root).find(pred) };
};
const ONE = "/automation/judges/edge-router%3Arisk%3Aclef%40clef-2";
const heading = (find) => find((n) => n.nodeName === "H2" && n.attrs.class === "mono")?.textContent;
const chart = (find) => find((n) => n.nodeName === "SVG" && n.attrs["aria-label"] === "Reliability diagram");
const recentRows = (root) => all(root).filter((n) => n.nodeName === "TBODY").at(-1).textContent;
const curves = (root) => all(root).filter((n) => n.nodeName === "POLYLINE" && n.attrs.class?.startsWith("pl-line"));

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

it("routing to /automation/judges/edge-router%3Arisk%3Aclef%40clef-2 renders that judge's detail heading and calibration chart", async () => {
  const { root, find } = await mount("/automation/judges/edge-router%3Arisk%3Aclef%40clef-2");
  expect(heading(find)).toBe("clef · edge-router");
  expect(find((n) => n.nodeName === "SPAN" && n.attrs.class === "lc-s mono").textContent).toBe("clef-2");
  expect(chart(find)).toBeTruthy();
  expect(recentRows(root)).toBe("edge-routerc_01.180correctedge-routerno change.400pending");
  expect(find((n) => n.nodeName === "TABLE" && n.parentNode.parentNode.textContent.startsWith("Reliability"))).toBeUndefined();
});

it("Judge detail renders recent verdicts from the API", async () => {
  const { root } = await mount(ONE);
  expect(recentRows(root)).toBe("edge-routerc_01.180correctedge-routerno change.400pending");
});

it("clicking a judge's leaderboard row on the list navigates to and renders its detail", async () => {
  const { find, router } = await mount("/automation/judges");
  expect(heading(find)).toBeUndefined();
  const row = all(find((n) => n.nodeName === "A" && n.textContent === "clef@clef-2"))[0];
  await act(async () => click(row));
  expect(router.state.location.pathname).toBe(ONE);
  expect(heading(find)).toBe("clef · edge-router");
  expect(chart(find)).toBeTruthy();
});

it("Add and swap open a .cinder.yml change", async () => {
  Object.assign(El.prototype, { showModal() { this.attrs.open = ""; }, close() {} });
  const props = (n) => n[Object.keys(n).find((k) => k.startsWith("__reactProps"))];
  const intent = (router) => router.state.location.state.intent;
  const add = await mount("/automation/judges");
  await act(async () => click(add.find((n) => n.nodeName === "BUTTON" && n.textContent === "Add judge")));
  await act(async () => props(add.find((n) => n.nodeName === "SELECT" && n.parentNode.textContent.startsWith("Question"))).onChange({ target: { value: "route" } }));
  await act(async () => props(add.find((n) => n.nodeName === "INPUT" && props(n).value === "clef-flash@1")).onChange());
  expect(add.find((n) => n.nodeName === "OUTPUT").textContent).toBe("edge-router:route:clef-flash@clef-flash@1");
  await act(async () => click(add.find((n) => n.nodeName === "A" && n.textContent === "Add judge")));
  expect(add.router.state.location.pathname).toBe("/edge-router/changes/new");
  expect(intent(add.router)).toBe("Set judges.route in .cinder.yml to { backend: clef-flash, model_version: clef-flash@1, min_confidence: 0.7 }");

  const swap = await mount("/automation/judges/edge-router%3Arisk%3Aclef%40clef-2");
  await act(async () => click(swap.find((n) => n.nodeName === "A" && n.textContent === "jev@1")));
  expect(swap.router.state.location.pathname).toBe("/edge-router/changes/new");
  expect(intent(swap.router)).toBe("Set judges.risk in .cinder.yml to { backend: jev, model_version: jev@1, min_outcomes: 50 }");
});

it("a judge kind is one leaderboard row, and its earlier model is history on the detail, not a separate judge", async () => {
  const { root } = await mount("/automation/judges");
  expect(all(all(root).find((n) => n.nodeName === "TBODY")).filter((n) => n.nodeName === "TR")).toHaveLength(1);
  const detail = await mount(ONE);
  expect(all(detail.root).filter((n) => n.nodeName === "H2" && n.attrs.class === "mono")).toHaveLength(1);
  expect(detail.find((n) => n.nodeName === "TBODY").textContent).toContain("clef@clef-1412.082");
});

it("a swapped judge draws two curves, the dashed one history[0].bins; with no history, one", async () => {
  const before = [{ lo: 0, hi: 0.5, count: 300, mean_p: 0.2, observed: 0.4 }];
  const swapped = await mount(ONE, { history: [{ backend: "clef", model_version: "clef-1", count: 300, trusted: true, brier: 0.09, bins: before }] });
  const [dashed, now] = curves(swapped.root);
  // X = 30 + 340p, Y = 4 + 340(1 − observed) on the 340px chart.
  expect(dashed.attrs).toMatchObject({ class: "pl-line dash", points: "98.0,208.0" });
  expect(now.attrs.class).toBe("pl-line");
  expect(curves(swapped.root)).toHaveLength(2);
  expect(curves((await mount(ONE, { history: [] })).root)).toHaveLength(1);
});

it("the swap mark sits on the week of since and the points before it are dashed", async () => {
  const trend = ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07"].map((week, i) => ({ week, count: 5, brier: 0.1 + i / 100 }));
  const { root } = await mount(ONE, { since: "2026-09-02T10:00:00Z", trend });
  const mark = all(root).find((n) => n.nodeName === "LINE" && n.attrs.class === "pl-mark");
  const paths = all(root).filter((n) => n.nodeName === "PATH" && n.attrs.class?.startsWith("pl-line"));
  // Week 2 (Aug 31) holds since: x = 40 + 2/3 × 508.
  expect(mark.attrs.x1).toBe(String(40 + 2 / 3 * 508));
  expect(all(root).find((n) => n.attrs?.class === "pl-t mk").textContent).toBe("Swapped to clef-2");
  expect(paths.map((p) => [p.attrs.class, p.attrs.d.trim().split(" ").filter((t) => /^[ML]/.test(t)).length])).toEqual([["pl-line dash", 3], ["pl-line", 2]]);
});

it("an untrusted judge renders Not enough outcomes with 64 of 200, and no curve or Brier", async () => {
  const { root } = await mount(ONE, { count: 64, trusted: false, brier: 0.377, min_outcomes: 200,
    history: [{ backend: "clef", model_version: "clef-1", count: 30, trusted: false, brier: 0.266 }] });
  expect(root.textContent).toContain("Not enough outcomes");
  expect(root.textContent).toContain("64 of 200");
  expect(curves(root)).toHaveLength(0);
  expect(root.textContent).not.toMatch(/377|266|Brier \./);
  expect(all(root).find((n) => n.nodeName === "TBODY").textContent).toBe("clef@clef-2 now64learning—clef@clef-130learning—");
});

it("the head Airlock toggle and the Settings toggle reflect one state", async () => {
  const props = (n) => n[Object.keys(n).find((k) => k.startsWith("__reactProps"))];
  const { root } = await mount(ONE);
  const toggles = () => all(root).filter((n) => n.nodeName === "INPUT" && n.attrs.role === "switch");
  expect(toggles().map((t) => t.checked)).toEqual([false, false]);
  await act(async () => props(toggles()[0]).onChange({ target: { checked: true } }));
  expect(toggles().map((t) => t.checked)).toEqual([true, true]);
  expect(all(root).find((n) => n.nodeName === "DETAILS").textContent).toContain("Airlock");
});

it("on a judge detail, each Swap model opens its own menu", async () => {
  const { root } = await mount(ONE);
  const swaps = all(root).filter((n) => n.nodeName === "BUTTON" && n.textContent === "Swap model");
  const menu = (b) => all(root).find((n) => n.attrs.popover && n.attrs.id === b.attrs.popoverTarget);
  expect(new Set(swaps.map((b) => b.attrs.popoverTarget)).size).toBe(2);
  expect(swaps.map((b) => menu(b).childNodes[0].attrs.href)).toEqual(["/edge-router/changes/new", "/edge-router/changes/new"]);
});

const h2s = (root) => all(root).filter((n) => n.nodeName === "H2" && n.attrs.class === "mono").map((n) => n.textContent);

it("clicking a row on the risk tab opens a detail with exactly that row's judge and no other repo's", async () => {
  const { root, find, router } = await mount("/automation/judges?kind=risk", (url) => (url.includes("billing") ? { model_version: "clef-3" } : {}), ["edge-router", "billing"]);
  await act(async () => click(find((n) => n.nodeName === "A" && n.textContent === "clef@clef-2")));
  expect(router.state.location.pathname).toBe(ONE);
  expect(h2s(root)).toEqual(["clef · edge-router"]);
  expect(all(root).filter((n) => n.nodeName === "SVG" && n.attrs["aria-label"] === "Reliability diagram")).toHaveLength(1);
});

it("clicking a row pooled across two repos opens one detail for that model", async () => {
  const { root, find, router } = await mount("/automation/judges?kind=risk", {}, ["edge-router", "billing"]);
  await act(async () => click(find((n) => n.nodeName === "A" && n.textContent === "clef@clef-2")));
  expect(router.state.location.pathname).toBe("/automation/judges/risk%3Aclef%40clef-2");
  expect(h2s(root)).toEqual(["clef@clef-2"]);
  expect(all(root).filter((n) => n.nodeName === "BUTTON" && n.textContent === "Swap model")).toHaveLength(0);
});

it("/automation/judges/risk opens the list with the risk tab selected", async () => {
  const { root, router } = await mount("/automation/judges/risk");
  expect(router.state.location.pathname).toBe("/automation/judges");
  expect(router.state.location.search).toBe("?kind=risk");
  expect(h2s(root)).toEqual([]);
  expect(all(root).find((n) => n.attrs?.role === "tab" && n.attrs["aria-selected"] === "true").textContent).toBe("risk 1");
});

it("switching the detail window to 30d changes the Calibration card's n and the outcomes shown", async () => {
  const thirty = { count: 12, total: 412, brier: 0.05, bins: [{ lo: 0.5, hi: 1, count: 12, mean_p: 0.75, observed: 0.5 }] };
  const { root, find } = await mount(ONE, (url) => (url.includes("weeks=5") ? thirty : {}));
  const pill = () => find((n) => n.nodeName === "SPAN" && n.attrs.class === "end pill").textContent;
  expect(fetch.mock.calls.map(([u]) => u)).toContain("/api/repos/edge-router/judges?weeks=13");
  expect(pill()).toBe("Brier .082 · n=412");
  await act(async () => click(find((n) => n.attrs?.role === "tab" && n.textContent === "30d")));
  expect(pill()).toBe("Brier .050 · n=12");
  expect(root.textContent).toContain("12 outcomes");
  expect(root.textContent).toContain("trusted · n=412 all time");
});
