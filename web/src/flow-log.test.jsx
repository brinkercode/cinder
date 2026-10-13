import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import fixture from "../../worker/src/api/fixtures/flow-run-tree.json";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { FlowRun, flowRunLoader } = await import("./flow-run.jsx");

const repo = repos[0];
const runUrl = `/api/repos/${encodeURIComponent(repo.name)}/flow-runs/${fixture.id}`;
const KEY = "build/test/node 22";
const AT = "2026-10-08T09:00:05.000Z";
const at = (texts, from = 0) => texts.map((text, i) => ({ n: from + i, at: AT, text }));
// The fixture run with KEY's steps replaced: [name, status, lines].
const withSteps = (steps, status = "failed") => ({ ...fixture, stages: fixture.stages.map((s) => ({ ...s, jobs: s.jobs.map((j) => (j.key !== KEY ? j : { ...j, status,
  steps: steps.map(([name, st, lines], idx) => ({ idx, name, status: st, started_at: AT, finished_at: st === "running" ? null : AT, lines: lines.length })) })) })) });

afterEach(() => vi.unstubAllEnvs());

// Renders the run page at search with KEY's steps; each step's log is served from its lines in 2,000-line pages.
let sockets;
async function page(steps, { search = "", annotations = [], status } = {}) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("ResizeObserver", class { constructor(f) { this.f = f; } observe() { this.f(); } disconnect() {} });
  sockets = [];
  vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
  vi.stubGlobal("WebSocket", class { constructor() { sockets.push(this); this.send = vi.fn(); } close() {} });
  El.prototype.getBoundingClientRect = () => ({ left: 0, right: 80, top: 0, height: 30 });
  const logs = `${runUrl}/jobs/${encodeURIComponent(KEY)}/log`;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === runUrl) return Response.json(withSteps(steps, status));
    if (url.startsWith(`${logs}?`)) {
      const q = new URL(url, "http://cinder.test").searchParams, [step, from] = [Number(q.get("step")), Number(q.get("from"))];
      const lines = at(steps[step][2]).slice(from, from + 2000);
      return Response.json({ step, from, lines, ...(from + lines.length < steps[step][2].length && { next: from + lines.length }) });
    }
    if (url === `${runUrl}/annotations`) return Response.json(annotations);
    if (url === `${runUrl}/tests` || url === `${runUrl}/artifacts`) return Response.json([]);
    if (url === "/api/live-ticket") return Response.json({ ticket: "t1" });
    return Response.json({ error: { code: "not_found", message: "none" } }, { status: 404 });
  }));
  const router = createMemoryRouter([{ path: "/:repo/flows/runs/:id", element: <FlowRun />, loader: flowRunLoader }],
    { initialEntries: [`/${encodeURIComponent(repo.name)}/flows/runs/${fixture.id}${search}`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  return { root, router, box: find(root, (n) => n.attrs.class?.startsWith("rp-ls"))[0] };
}
const find = (root, test) => all(root).filter((n) => n.nodeType === 1 && test(n));
const props = (el) => el[Object.keys(el).find((k) => k.startsWith("__reactProps$"))];
const lines = (root) => find(root, (n) => n.attrs.class?.startsWith("ln") && n.attrs.class !== "ln live");
const line = (root, text) => lines(root).find((l) => l.childNodes[2].textContent.endsWith(text));
const steps = (root) => find(root, (n) => n.nodeName === "DETAILS");
const scroll = (box, top) => act(async () => { box.scrollTop = top; props(box).onScroll(); });
const fill = (n, text) => Array.from({ length: n }, (_, i) => `${text} ${i}`);

describe("flow job log", () => {
  it("a 20,000-line job renders only the visible window and keeps sticky step headers", async () => {
    const { root, box } = await page(["one", "two", "three", "four"].map((s) => [s, "failed", fill(5000, s)]));
    expect(fetch.mock.calls.filter(([u]) => u.includes("/log?")).length).toBe(12); // 3 pages a step
    box.clientHeight = 400;
    await scroll(box, 3 * 34 + 2 * 5000 * 20 + 1000 * 20); // step three's line 1000 at the top
    const shown = lines(root).map((l) => l.childNodes[2].textContent);
    expect(shown.length).toBeLessThanOrEqual(400 / 20 + 2 * 40 + 1);
    expect(shown).toContain("three 1000");
    expect(shown).toContain("three 1019");
    expect(shown.every((t) => t.startsWith("three "))).toBe(true);
    // Every step keeps its summary, and the summary is sticky.
    expect(steps(root).map((d) => d.childNodes[0].nodeName)).toEqual(["SUMMARY", "SUMMARY", "SUMMARY", "SUMMARY"]);
    expect(steps(root).map((d) => d.attrs.open)).toEqual(["", "", "", ""]);
    expect(readFileSync(new URL("styles/runs.css", import.meta.url), "utf8")).toMatch(/\.stp>summary\{[^}]*position:sticky;top:0/);
  });

  it("search results update within 150 ms and the n/m count equals the number of mark elements", async () => {
    const { root } = await page([["install", "passed", ["fetch needle", "done"]],
      ["unit", "failed", ["##[group]Suite", "a needle and a NEEDLE", "##[endgroup]", "##[group]Quiet", "nothing", "##[endgroup]"]]]);
    const input = find(root, (n) => n.attrs["aria-label"] === "Search the log")[0];
    await act(async () => { input.value = "needle"; props(input).onChange({ target: input }); });
    expect(find(root, (n) => n.nodeName === "MARK")).toHaveLength(0);
    await act(() => new Promise((r) => setTimeout(r, 150)));
    const marks = find(root, (n) => n.nodeName === "MARK");
    const count = () => find(root, (n) => n.attrs.class === "mono meta")[0].textContent;
    expect(count()).toBe(`0/${marks.length}`);
    expect(marks.map((m) => m.textContent)).toEqual(["needle", "needle", "NEEDLE"]);
    // The passed step and the group with a hit opened; the group without one stayed shut.
    expect(steps(root).map((d) => d.attrs.open)).toEqual(["", ""]);
    expect(line(root, "nothing")).toBeUndefined();
    await act(async () => props(input).onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} }));
    expect(count()).toBe("1/3");
    await act(async () => props(input).onKeyDown({ key: "Enter", shiftKey: true, preventDefault() {} }));
    expect(count()).toBe("3/3");
    expect(find(root, (n) => n.nodeName === "MARK" && n.attrs.class === "cur").map((m) => m.textContent)).toEqual(["NEEDLE"]);
  });

  const nested = [["install", "passed", ["ok"]], ["unit", "passed", ["start", "##[group]Outer", "o1", "##[group]Inner", "i1", "i2", "##[endgroup]", "##[endgroup]", "end"]]];
  it("?L= opens the step and its groups, scrolls to the line and highlights it", async () => {
    const { root, box } = await page(nested, { search: `?job=${encodeURIComponent(KEY)}&L=${encodeURIComponent(`${KEY}-1-6`)}` });
    expect(steps(root).map((d) => d.attrs.open)).toEqual([undefined, ""]);
    expect(find(root, (n) => n.attrs.class === "lgp").map((b) => b.attrs["aria-expanded"])).toEqual(["true", "true"]);
    expect(lines(root).filter((l) => l.attrs.class.includes("sel")).map((l) => l.textContent)).toEqual(["609:00:05i2"]);
    // Below the closed install step (34) and unit's header (34), i2 is the sixth row, kept 60px under the top.
    expect(box.scrollTop).toBe(34 + 34 + 5 * 20 - 60);
    expect(line(root, "i2").childNodes[0].attrs.href).toBe(`?job=${encodeURIComponent(KEY)}&L=${encodeURIComponent(`${KEY}-1-`)}6`);
  });

  it("clicking an annotation opens its step and group and highlights its line", async () => {
    const { root } = await page(nested, { annotations: [{ job_key: KEY, step: "unit", line: 4, level: "warning", message: "slow i1" }] });
    expect(steps(root).map((d) => d.attrs.open)).toEqual([undefined, undefined]);
    const strip = find(root, (n) => n.attrs.class === "rp-an")[0];
    await act(async () => click(find(strip, (n) => n.nodeName === "BUTTON")[0]));
    for (let i = 0; i < 3; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(steps(root).map((d) => d.attrs.open)).toEqual([undefined, ""]);
    expect(line(root, "i1").attrs.class).toContain("sel");
    expect(find(root, (n) => n.attrs.class === "lgp").map((b) => b.attrs["aria-expanded"])).toEqual(["true", "true"]);
  });

  it("a group holding an error opens automatically and nests 18px per level", async () => {
    const { root } = await page([["unit", "failed", ["##[group]Run tests", "ok", "##[group]Suite", "##[error]boom", "##[endgroup]", "##[endgroup]",
      "##[group]Quiet", "q", "##[endgroup]", "[command]npm test"]]]);
    expect(find(root, (n) => n.attrs.class === "lgp").map((b) => b.attrs["aria-expanded"])).toEqual(["true", "true", "false"]);
    expect(line(root, "q")).toBeUndefined();
    const pad = (text) => line(root, text).childNodes[2].style.paddingLeft;
    expect([pad("ok"), pad("Suite"), pad("boom")]).toEqual(["18px", "18px", "36px"]);
    expect(line(root, "boom").attrs.class).toBe("ln k-err ann");
    expect(line(root, "boom").childNodes[2].textContent).toBe("Error: boom");
    expect(line(root, "npm test").childNodes[2].textContent).toBe("$npm test");
    // Folding a group by its caret hides its lines.
    await act(async () => click(find(root, (n) => n.attrs.class === "lgp")[0]));
    expect(line(root, "ok")).toBeUndefined();
  });

  it("appended run.log lines don't re-render existing lines and the scroll position is kept", async () => {
    const { root, box } = await page([["unit", "running", ["l0", "l1", "l2"]]], { status: "running" });
    const socket = sockets.at(-1);
    socket.onopen();
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: "subscribe", run: fixture.id, key: KEY });
    expect(find(root, (n) => n.attrs.class === "ln live")[0].textContent).toBe("waiting for output…");
    const follow = () => find(root, (n) => n.nodeName === "BUTTON" && n.textContent === "Follow")[0].attrs["aria-pressed"];
    expect(follow()).toBe("true");
    box.scrollHeight = 1000;
    await scroll(box, 1000);
    await scroll(box, 100); // scrolling up turns Follow off
    expect(follow()).toBe("false");
    const before = lines(root);
    const texts = before.map((l) => l.childNodes[2].childNodes[0]);
    await act(async () => socket.onmessage({ data: JSON.stringify({ kind: "run.log", id: fixture.id, key: KEY, step: 0, from: 3, lines: at(["l3", "l4"], 3) }) }));
    const after = lines(root);
    expect(after.map((l) => l.childNodes[2].textContent)).toEqual(["l0", "l1", "l2", "l3", "l4"]);
    expect(after.slice(0, 3)).toEqual(before);
    after.slice(0, 3).forEach((l, i) => expect(l === before[i] && l.childNodes[2].childNodes[0] === texts[i]).toBe(true));
    expect(box.scrollTop).toBe(100);
    expect(find(root, (n) => n.attrs.class === "ln live")).toHaveLength(1);
  });

  it("after Re-run job the step log shows only the new attempt's lines", async () => {
    const { root } = await page([["unit", "failed", ["a0", "a1", "a2"]]]);
    expect(lines(root).map((l) => l.childNodes[2].textContent)).toEqual(["a0", "a1", "a2"]);
    const old = fetch, logs = `${runUrl}/jobs/${encodeURIComponent(KEY)}/log`;
    const next = withSteps([["unit", "running", ["b0"]]], "running");
    next.stages = next.stages.map((s) => ({ ...s, jobs: s.jobs.map((j) => (j.key === KEY ? { ...j, attempt: 2 } : j)) }));
    vi.stubGlobal("fetch", vi.fn(async (url, init) => (init?.method === "POST" ? Response.json({ id: fixture.id, attempt: 2 }, { status: 201 })
      : url === runUrl ? Response.json(next) : url.startsWith(`${logs}?`) ? Response.json({ step: 0, from: 0, lines: at(["b0"]) }) : old(url, init))));
    await act(async () => click(find(root, (n) => n.nodeName === "BUTTON" && n.textContent === "Re-run job")[0]));
    for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(lines(root).map((l) => l.childNodes[2].textContent)).toEqual(["b0"]);
  });

  it("Raw links the job's log.txt", async () => {
    const { root } = await page([["unit", "failed", ["x"]]]);
    const raw = find(root, (n) => n.nodeName === "A" && n.textContent === "Raw")[0];
    expect(raw.attrs).toMatchObject({ href: `${runUrl}/jobs/${encodeURIComponent(KEY)}/log.txt`, download: "" });
  });
});
