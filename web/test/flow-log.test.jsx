import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import fixture from "../../worker/src/api/fixtures/flow-run-tree.json";
import { all, click, doc, El } from "../src/fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { FlowRun, flowRunLoader } = await import("../src/flow-run.jsx");


const repo = repos[0];
const runUrl = `/api/repos/${encodeURIComponent(repo.name)}/flow-runs/${fixture.id}`;
const KEY = "build/test/node 22";
const [START, END] = ["2026-10-08T09:00:00.000Z", "2026-10-08T09:00:09.000Z"];
// The runner's set-up and clean-up steps carry the idx after the job's own two, and come first and last in the tree.
const STEPS = [[2, "Set up job", ["Runner name: 'lab'"]], [0, "install", ["added 3 packages"]], [1, "test", ["ok 1"]], [3, "Complete job", ["Removed workspace /tmp/w"]]];
const tree = { ...fixture, stages: fixture.stages.map((s) => ({ ...s, jobs: s.jobs.map((j) => (j.key !== KEY ? j : { ...j, status: "passed",
  steps: STEPS.map(([idx, name, lines]) => ({ idx, name, status: "passed", started_at: START, finished_at: END, lines: lines.length })) })) })) };


const settle = async () => { for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 0))); };

afterEach(() => vi.unstubAllEnvs());

const find = (root, test) => all(root).filter((n) => n.nodeType === 1 && test(n));
describe("flow job log", () => {
  it("set-up and complete steps show before and after the job's steps", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("ResizeObserver", class { constructor(f) { this.f = f; } observe() { this.f(); } disconnect() {} });
    vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
    vi.stubGlobal("WebSocket", class { constructor() { this.send = vi.fn(); } close() {} });
    El.prototype.getBoundingClientRect = () => ({ left: 0, right: 80, top: 0, height: 30 });
    const logs = `${runUrl}/jobs/${encodeURIComponent(KEY)}/log?`;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === runUrl) return Response.json(tree);
      if (url.startsWith(logs)) {
        const step = Number(new URL(url, "http://cinder.test").searchParams.get("step"));
        return Response.json({ step, from: 0, lines: STEPS.find(([idx]) => idx === step)[2].map((text, n) => ({ n, at: START, text })) });
      }
      if (url === `${runUrl}/annotations`) return Response.json([{ job_key: KEY, step: "test", line: 0, level: "warning", message: "slow" }]);
      if (url === `${runUrl}/tests` || url === `${runUrl}/artifacts`) return Response.json([]);
      if (url === "/api/live-ticket") return Response.json({ ticket: "t1" });
      return Response.json({ error: { code: "not_found", message: "none" } }, { status: 404 });
    }));
    const router = createMemoryRouter([{ path: "/:repo/flows/runs/:id", element: <FlowRun />, loader: flowRunLoader }],
      { initialEntries: [`/${encodeURIComponent(repo.name)}/flows/runs/${fixture.id}?job=${encodeURIComponent(KEY)}`] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    await settle();

    const steps = find(root, (n) => n.nodeName === "DETAILS");
    expect(steps.map((d) => find(d, (n) => n.attrs.class === "stp-n")[0].textContent)).toEqual(["Set up job", "install", "test", "Complete job"]);
    expect(steps.map((d) => find(d, (n) => n.attrs.class === "stp-d mono")[0].textContent)).toEqual(["9.0s", "9.0s", "9.0s", "9.0s"]);
    // Each opens like any step: its own lines, fetched by its idx.
    await act(async () => click(find(steps[0], (n) => n.nodeName === "SUMMARY")[0]));
    await settle();
    expect(steps[0].textContent).toContain("Runner name: 'lab'");
    // An annotation on the job's step opens that step, not whichever sits at its idx's position.
    await act(async () => click(find(find(root, (n) => n.attrs.class === "rp-an")[0], (n) => n.nodeName === "BUTTON")[0]));
    await settle();
    expect(steps.map((d) => d.attrs.open)).toEqual(["", undefined, "", undefined]);
  });
});


const AT = "2026-10-08T09:00:05.000Z";

// Renders the run page with KEY's job as one failed step logging texts.
async function page(texts) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("ResizeObserver", class { constructor(f) { this.f = f; } observe() { this.f(); } disconnect() {} });
  vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
  vi.stubGlobal("WebSocket", class { send() {} close() {} });
  El.prototype.getBoundingClientRect = () => ({ left: 0, right: 80, top: 0, height: 30 });
  const run = { ...fixture, stages: fixture.stages.map((s) => ({ ...s, jobs: s.jobs.map((j) => (j.key !== KEY ? j : { ...j, status: "failed",
    steps: [{ idx: 0, name: "init", status: "failed", started_at: AT, finished_at: AT, lines: texts.length }] })) })) };
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === runUrl) return Response.json(run);
    if (url.startsWith(`${runUrl}/jobs/${encodeURIComponent(KEY)}/log?`)) return Response.json({ step: 0, from: 0, lines: texts.map((text, n) => ({ n, at: AT, text })) });
    if (url === "/api/live-ticket") return Response.json({ ticket: "t1" });
    if (url.startsWith(runUrl)) return Response.json([]);
    return Response.json({ error: { code: "not_found", message: "none" } }, { status: 404 });
  }));
  const router = createMemoryRouter([{ path: "/:repo/flows/runs/:id", element: <FlowRun />, loader: flowRunLoader }],
    { initialEntries: [`/${encodeURIComponent(repo.name)}/flows/runs/${fixture.id}?job=${encodeURIComponent(KEY)}`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  return root;
}
const rows = (root) => find(root, (n) => n.attrs.class?.startsWith("ln") && n.attrs.class !== "ln live");
const spans = (el) => find(el, (n) => n !== el && n.nodeName === "SPAN").map((s) => [s.attrs.class, s.textContent]);
const css = readFileSync(new URL("../src/styles/runs.css", import.meta.url), "utf8");

describe("flow log rendering", () => {
  it("colour and bold codes render as styles and no escape characters reach the page", async () => {
    const root = await page(["\x1b[0m\x1b[1mInitializing provider plugins...\x1b[0m", "\x1b[32m\x1b[1mSuccess!\x1b[0m done \x1b]8;;http://x\x07\x1b[2K\x1b(Bend"]);
    const [a, b] = rows(root).map((r) => r.childNodes[2]);
    expect(a.textContent).toBe("Initializing provider plugins...");
    expect(b.textContent).toBe("Success! done end");
    expect(spans(a)).toEqual([["bd", "Initializing provider plugins..."]]);
    expect(spans(b)).toEqual([["fg2 bd", "Success!"]]);
    expect(root.textContent).not.toMatch(/\x1b|\x07|\[0m|\[32m/); // eslint-disable-line no-control-regex
    expect(css).toMatch(/\.ln \.bd\{font-weight:/);
    expect(css).toMatch(/\.ln \.fg2\{color:var\(--success\)\}/);
  });

  it("a line number shares its row with its text", async () => {
    const root = await page(["first line", "second line"]);
    for (const [i, r] of rows(root).entries()) {
      expect(r.childNodes.map((c) => c.attrs.class)).toEqual(["n", "ts", "tx"]);
      expect([r.childNodes[0].textContent, r.childNodes[2].textContent]).toEqual([String(i + 1), ["first line", "second line"][i]]);
    }
    // Every cell sits on the row's one grid row, whether or not wrap is on.
    expect(css).toMatch(/\.ln\{display:grid;grid-template-columns:52px 0px minmax\(0,1fr\)/);
    expect(css).toMatch(/\.ln>\*\{grid-row:1\}/);
    expect(css).not.toMatch(/\.wrap \.ln\{[^}]*(display|grid-template)/);
  });

  it("timestamps and wrap are icon toggles with accessible names", async () => {
    const root = await page(["x"]);
    const btn = (name) => find(root, (n) => n.nodeName === "BUTTON" && n.attrs["aria-label"] === name)[0];
    for (const [name, cls] of [["Timestamps", "ts-on"], ["Wrap long lines", "wrap"]]) {
      const b = btn(name);
      expect(b.attrs).toMatchObject({ class: "ib sm", title: name, "aria-pressed": "false" });
      expect(b.textContent).toBe("");
      expect(b.childNodes.map((c) => c.nodeName.toLowerCase())).toEqual(["svg"]);
      await act(async () => click(b));
      expect(btn(name).attrs["aria-pressed"]).toBe("true");
      expect(find(root, (n) => n.attrs.class?.startsWith("rp-ls"))[0].attrs.class.split(" ")).toContain(cls);
    }
  });
});
