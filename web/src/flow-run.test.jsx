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
const TREE = { ...fixture, change: { id: "c_01", title: "Retry declined cards" } };
const RESULTS = {
  annotations: [{ job_key: "build/test/node 22", step: "unit", line: 41, level: "error", message: "expected 2 to be 3" },
    { job_key: "build/test/node 20", step: "unit", line: 3, level: "warning", message: "slow test" }],
  tests: [{ suite: "unit", job_key: "build/test/node 20", passed: 29, failed: 0, skipped: 1, failures: [] },
    { suite: "unit", job_key: "build/test/node 22", passed: 28, failed: 1, skipped: 1, failures: ["adds"] }],
  artifacts: [{ name: "coverage", job_key: "build/test/node 20", size: 2048, expires_at: "2026-11-07T09:02:35Z", url: `${runUrl}/artifacts/coverage` }],
};
// TREE with some jobs' statuses replaced: {key: status}.
const withJobs = (st) => ({ ...TREE, stages: TREE.stages.map((s) => ({ ...s, jobs: s.jobs.map((j) => ({ ...j, status: st[j.key] ?? j.status })) })) });

afterEach(() => vi.unstubAllEnvs());

// Renders /:repo/flows/runs/run-1; rerun answers POST rerun. Chips sit 100px apart so the bus has a layout to measure.
// The page's live socket is pushed to sockets; opened keeps every test's, since Summary shares the repo's socket.
let sockets;
const opened = [];
async function page({ rerun = () => Response.json({ id: fixture.id, attempt: 2 }, { status: 201 }), tree = TREE, search = "" } = {}) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  sockets = [];
  vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
  vi.stubGlobal("WebSocket", class { constructor() { sockets.push(this); opened.push(this); } close() {} });
  let x = 0;
  El.prototype.getBoundingClientRect = function () { x += 100; return { left: x, right: x + 80, top: 0, height: 30 }; };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (url === runUrl) return Response.json(tree);
    if (url.startsWith(`${runUrl}/`) && RESULTS[url.slice(runUrl.length + 1)]) return Response.json(RESULTS[url.slice(runUrl.length + 1)]);
    if (url === "/api/live-ticket") return Response.json({ ticket: "t1" });
    if (url === `${runUrl}/rerun` && init?.method === "POST") return rerun(JSON.parse(init.body));
    return Response.json({ error: { code: "not_found", message: "none" } }, { status: 404 });
  }));
  const router = createMemoryRouter([{ path: "/:repo/flows/runs/:id", element: <FlowRun />, loader: flowRunLoader }],
    { initialEntries: [`/${encodeURIComponent(repo.name)}/flows/runs/${fixture.id}${search}`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return { root, router };
}
const find = (root, test) => all(root).filter((n) => n.nodeType === 1 && test(n));
const button = (root, text) => find(root, (n) => n.nodeName === "BUTTON" && n.textContent === text)[0];
const pill = (root) => find(root, (n) => n.attrs.class === "pill rp-st")[0].textContent;
const selected = (root) => find(root, (n) => /^tr-[xj] on$/.test(n.attrs.class)).map((n) => n.textContent);
const keydown = (key) => act(async () => { for (const f of doc.listeners.keydown ?? []) f({ type: "keydown", key, target: doc.body }); });
const jobParam = (router) => new URLSearchParams(router.state.location.search).get("job");
const chips = (root) => find(root, (n) => n.attrs.class?.startsWith("rg-j")).map((c) => [find(c, (s) => s.nodeName === "SPAN" && !s.attrs.class)[0].textContent, c.attrs.class]);

describe("flow run page", () => {
  it("a change-triggered run's header shows the change title and the branch", async () => {
    const { root } = await page({ tree: { ...TREE, trigger: "change", ref: "retry-cards" } });
    expect(find(root, (n) => n.attrs.class === "rp-t")[0].textContent).toBe("c_01Retry declined cards");
    expect(find(root, (n) => n.attrs.class === "rp-meta")[0].childNodes[0].textContent).toBe("retry-cards");
  });

  it("the run page renders its header and stage graph from the tree route", async () => {
    const { root } = await page();
    expect(fetch).toHaveBeenCalledWith(runUrl);
    expect(find(root, (n) => n.nodeName === "H1")[0].textContent).toBe("ci #7");
    expect(pill(root)).toBe("Failed");
    expect(find(root, (n) => n.attrs.class === "rp-t")[0].textContent).toBe("c_01Retry declined cards");
    expect([button(root, "Re-run failed jobs"), button(root, "Re-run all"), button(root, "Cancel run")].map(Boolean)).toEqual([true, true, false]);
    expect(find(root, (n) => n.attrs["aria-label"] === "Hide graph")).toHaveLength(1);
    const meta = find(root, (n) => n.attrs.class === "rp-meta")[0].childNodes.map((s) => s.textContent);
    expect(meta).toEqual(["main", "8f1c2d3", "cinder", `Started ${new Date(TREE.started_at).toLocaleString()}`, "3m 0s", "standard-4, byo", repo.name]);
    expect(find(root, (n) => n.attrs.class === "rg-h").map((h) => h.textContent)).toEqual(["build1/2", "deploy0/1"]);
    expect(chips(root)).toEqual([["test (node 20)", "rg-j st-passed"], ["test (node 22)", "rg-j st-failed on"], ["ship", "rg-j st-skipped"]]);
    // The bus: one curve out of each build chip and one into the deploy chip, measured from the chips' boxes.
    expect(find(root, (n) => n.nodeName === "PATH")[0].attrs.d.match(/M/g)).toHaveLength(3);
  });

  it("clicking a stage-graph chip sets ?job= to that job", async () => {
    const { root, router } = await page();
    await act(async () => click(find(root, (n) => n.attrs.class?.startsWith("rg-j st-failed"))[0]));
    expect(new URLSearchParams(router.state.location.search).get("job")).toBe("build/test/node 22");
    expect(chips(root)[1]).toEqual(["test (node 22)", "rg-j st-failed on"]);
  });

  it("Re-run failed shows the new attempt queued before the POST answers and rolls back on error", async () => {
    let answer;
    const { root } = await page({ rerun: (body) => { expect(body).toEqual({ scope: "failed" }); return new Promise((r) => { answer = r; }); } });
    await act(async () => click(button(root, "Re-run failed jobs")));
    expect(pill(root)).toBe("Queued");
    expect(chips(root).map(([, c]) => c)).toEqual(["rg-j st-passed", "rg-j st-queued", "rg-j st-queued"]);
    expect(button(root, "Cancel run")).toBeTruthy();
    await act(async () => answer(Response.json({ error: { code: "running", message: "the run is still going" } }, { status: 409 })));
    expect(pill(root)).toBe("Failed");
    expect(chips(root).map(([, c]) => c)).toEqual(["rg-j st-passed", "rg-j st-failed on", "rg-j st-skipped"]);
    expect(find(root, (n) => n.attrs.role === "alert")[0].textContent).toContain("409 the run is still going");
  });

  it("the run page renders the job tree and Summary from the tree route", async () => {
    const { root } = await page();
    const tree = find(root, (n) => n.attrs["aria-label"] === "Stages and jobs")[0];
    expect(find(tree, (n) => n.nodeName === "BUTTON").map((b) => b.textContent))
      .toEqual(["Summary", "build2", "test (node 20)2m 30s", "test (node 22)2m 30s", "deploy1", "ship"]);
    // The selected job (the failed one) lists its steps with their durations.
    expect(find(tree, (n) => n.nodeName === "LI").map((li) => li.textContent)).toEqual(["install35.0s", "unit1m 55s"]);
    await act(async () => click(button(root, "Summary")));
    expect(find(root, (n) => n.attrs["aria-label"] === "Summary")).toHaveLength(1);
    // A stage collapses to its header.
    await act(async () => click(find(tree, (n) => n.attrs.class === "tr-sg")[0]));
    expect(find(tree, (n) => n.nodeName === "BUTTON").map((b) => b.textContent)).toEqual(["Summary", "build2", "deploy1", "ship"]);
  });

  it("the default selection is the first failed job, else the first running job, else Summary", async () => {
    expect(selected((await page()).root)).toEqual(["test (node 22)2m 30s"]);
    expect(selected((await page({ tree: withJobs({ "build/test/node 22": "passed", "deploy/ship": "running" }) })).root)).toEqual(["ship"]);
    expect(selected((await page({ tree: withJobs({ "build/test/node 22": "passed", "deploy/ship": "passed" }) })).root)).toEqual(["Summary"]);
  });

  it("[ and ] move to the previous and next job", async () => {
    const { root, router } = await page();
    await keydown("]");
    expect(jobParam(router)).toBe("deploy/ship");
    expect(selected(root)).toEqual(["ship"]);
    await keydown("]");
    expect(jobParam(router)).toBe("build/test/node 20");
    await keydown("[");
    expect(jobParam(router)).toBe("deploy/ship");
    await keydown("[");
    expect(jobParam(router)).toBe("build/test/node 22");
  });

  it("a run.updated event changes a job's status without a refetch", async () => {
    const { root } = await page();
    const calls = fetch.mock.calls.length;
    const send = (m) => act(async () => sockets[0].onmessage({ data: JSON.stringify({ id: fixture.id, ...m }) }));
    await send({ kind: "run.updated", stages: [{ id: "build", status: "running", jobs: [{ key: "build/test/node 20", status: "passed" }, { key: "build/test/node 22", status: "running" }] }] });
    expect(chips(root).map(([, c]) => c)).toEqual(["rg-j st-passed", "rg-j st-running on", "rg-j st-skipped"]);
    expect(find(root, (n) => n.attrs.class === "tr-j on")[0].childNodes[0].attrs.class).toBe("run-i running");
    expect(find(root, (n) => n.attrs.class === "rg-h")[0].childNodes[0].attrs.class).toBe("run-i running");
    await send({ kind: "run.updated", id: "run-2", stages: [{ id: "build", status: "failed", jobs: [{ key: "build/test/node 22", status: "failed" }] }] });
    expect(chips(root)[1][1]).toBe("rg-j st-running on");
    expect(fetch.mock.calls.length).toBe(calls);
    expect(sockets).toHaveLength(1);
    // Summary's socket (it reopens per selected job) adds an annotation.
    await act(async () => click(button(root, "Summary")));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await act(async () => sockets.at(-1).onmessage({ data: JSON.stringify({ id: fixture.id, kind: "run.annotation",
      annotations: [{ job_key: "deploy/ship", step: "ship", line: 1, level: "warning", message: "no target" }] }) }));
    expect(find(root, (n) => n.attrs.class?.startsWith("an ")).map((a) => a.textContent).at(-1)).toBe("deploy / ship · shipno target");
  });

  it("a run.annotation event adds the annotation to Summary without a reload", async () => {
    const { root } = await page({ search: "?job=" });
    const calls = fetch.mock.calls.length;
    const data = JSON.stringify({ id: fixture.id, kind: "run.annotation", annotations: [{ job_key: "deploy/ship", step: "ship", line: 1, level: "error", message: "no target" }] });
    await act(async () => { for (const ws of opened) ws.onmessage?.({ data }); });
    const card = find(root, (n) => n.attrs.class === "card")[0];
    expect(find(card, (n) => n.attrs.class === "card-h")[0].textContent).toBe("Annotations2 errors · 1 warnings");
    expect(find(card, (n) => n.nodeName === "BUTTON").map((b) => b.textContent).at(-1)).toBe("deploy / ship · shipno target");
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("Summary shows tiles, annotations, jobs, tests per suite and artifacts", async () => {
    const { root, router } = await page({ tree: { ...TREE, judge_tokens: "23.9k" }, search: "?job=" });
    const summary = find(root, (n) => n.attrs["aria-label"] === "Summary")[0];
    expect(find(summary, (n) => n.attrs.class === "tile flat").map((t) => t.textContent))
      .toEqual(["StatusFailed", "Wall time3m 0s", "Sandbox time5m 0s2 jobs", "Judge tokens23.9k"]);
    const cards = find(summary, (n) => n.attrs.class === "card");
    expect(cards.map((c) => find(c, (n) => n.nodeName === "H3")[0].textContent)).toEqual(["Annotations", "Jobs", "Steps", "Tests", "Artifacts"]);
    expect(find(cards[0], (n) => n.attrs.class === "card-h")[0].textContent).toBe("Annotations1 errors · 1 warnings");
    expect(find(cards[0], (n) => n.nodeName === "BUTTON").map((b) => b.textContent))
      .toEqual(["build / test (node 22) · unitexpected 2 to be 3", "build / test (node 20) · unitslow test"]);
    const rows = (card) => find(card, (n) => n.nodeName === "TBODY")[0].childNodes;
    expect(rows(cards[1]).map((r) => r.textContent)).toEqual(["test (node 20)buildPassedstandard-42m 30s", "test (node 22)buildFailedbyo2m 30s", "shipdeploySkipped——"]);
    expect(rows(cards[3]).map((r) => r.textContent)).toEqual(["unitbuild / test (node 20)2901", "unitbuild / test (node 22)2811"]);
    expect(rows(cards[4]).map((r) => r.textContent)).toEqual(["coveragebuild / test (node 20)2.0 KBDownload"]);
    expect(find(cards[4], (n) => n.nodeName === "A")[0].attrs).toMatchObject({ href: `${runUrl}/artifacts/coverage`, download: "" });
    // A jobs row opens its job.
    await act(async () => click(rows(cards[1])[0]));
    expect(jobParam(router)).toBe("build/test/node 20");
  });

  it("a run's summary lists the runner's pre and post steps with their durations", async () => {
    const at = (s) => `2026-10-08T09:00:${s}Z`;
    const sys = (idx, name, from, to) => ({ idx, name, status: "passed", started_at: at(from), finished_at: at(to), lines: 3 });
    const ship = { ...TREE.stages[1].jobs[0], steps: [sys(1, "Set up job", "01", "03"), sys(3, "Checkout", "03", "07"), TREE.stages[1].jobs[0].steps[0],
      sys(4, "Upload artifacts", "07", "08"), sys(2, "Complete job", "08", "09")] };
    const { root } = await page({ tree: { ...TREE, stages: [TREE.stages[0], { ...TREE.stages[1], jobs: [ship] }] }, search: "?job=" });
    const card = find(root, (n) => n.attrs.class === "card" && find(n, (h) => h.nodeName === "H3")[0].textContent === "Steps")[0];
    expect(find(card, (n) => n.nodeName === "TR").slice(1).map((r) => r.textContent).filter((t) => t.includes("deploy / ship")))
      .toEqual(["Set up jobdeploy / ship2.0s", "Checkoutdeploy / ship4.0s", "shipdeploy / ship—", "Upload artifactsdeploy / ship1.0s", "Complete jobdeploy / ship1.0s"]);
  });
});
