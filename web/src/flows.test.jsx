import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { flowYaml, parseFlow } from "../../worker/src/api/contract.js";
import CI from "../../seed/repos/web-store/.cinder/flows/ci.yml?raw";
import DEPLOY from "../../seed/repos/web-store/.cinder/flows/deploy.yml?raw";
import { all, click, doc, El } from "./fake-dom.js";

// React probes `"oninput" in document` at import; without it, typing goes through an old-IE polyfill the fake DOM can't drive.
doc.oninput = null;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Flows, flowsLoader } = await import("./flows.jsx");
const { Shell } = await import("./shell.jsx");

const repo = repos[0];
const HEAD = "a".repeat(40);
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const FLOWS = [["ci.yml", CI], ["deploy.yml", DEPLOY]];
const LOOP = "name: loop\non: [manual]\nsteps:\n  a: { stage: build, run: \"echo a\", needs: [b] }\n  b: { stage: build, run: \"echo b\", needs: [a] }\n  c: { stage: build, run: \"echo c\", needs: [a] }\n";
const RUN = { id: "run-12345678", flow: "deploy", sha: HEAD, status: "queued", created_at: new Date().toISOString(), steps: [{ name: "test", stage: "build", status: "queued", logs: "" }] };

// Not unstubAllGlobals: that drops fake-dom.js's window, which a second render needs; each test stubs its own fetch.
afterEach(() => vi.unstubAllEnvs());

// Renders the Flows page at ?search with .cinder/flows holding files on ref; runs answers GET flow-runs, flakes GET flakes?sha=,
// cards each flow's FlowList entry fields over the defaults (no runs); hold leaves each flow's file request unanswered; shell draws the Shell around it.
async function page(search, files, runs = () => Response.json([RUN]), ref = repo.default_branch, flakes = [], cards = {}, hold = false, shell = false) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  const entry = (flow) => {
    const { on } = parseFlow(files[flow]);
    return { flow, head: HEAD, trigger: ["change", "push", "cron"].find((t) => on.includes(t)) ?? "manual", on, health: { passed: 0, failed: 0, n: 0, trusted: false }, ...cards[flow] };
  };
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    // The shell's own requests never answer: the page loads beside them, not after them.
    if (["/api/repos", "/api/me", "/api/me/accounts"].includes(url)) return new Promise(() => {});
    if (url === base) return Response.json(repo);
    if (url === `${base}/flows?ref=${ref}`) return Response.json(Object.keys(files).map(entry));
    const file = Object.keys(files).find((f) => url === `${base}/flows/${f}?ref=${ref}`);
    if (file) return hold ? new Promise(() => {}) : Response.json({ yaml: files[file], def: parseFlow(files[file]), head: HEAD, last_run_steps: {} });
    if (url === `${base}/flow-runs`) return runs();
    if (url === `${base}/flakes?sha=${HEAD}`) return Response.json(flakes);
    if (url === "/api/workers/pools" || url === "/api/workers/byo-pools") return Response.json([]);
    if (url === "/api/keystore") return Response.json({ secrets: [], wanted: [] });
    return Response.json({ error: { code: "not_found", message: "none" } }, { status: 404 });
  }));
  const route = { path: "/:repo/flows", element: <Flows />, loader: flowsLoader };
  const router = createMemoryRouter([shell ? { element: <Shell />, children: [route] } : route], { initialEntries: [`/${encodeURIComponent(repo.name)}/flows${search}`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return root;
}
const find = (root, test) => all(root).filter((n) => n.nodeType === 1 && test(n));
const tab = (root, name) => find(root, (n) => n.attrs.role === "tab" && n.textContent === name)[0];
const button = (root, text) => find(root, (n) => n.nodeName === "BUTTON" && n.textContent === text)[0];
const banner = (root) => find(root, (n) => n.attrs.role === "status" && n.attrs.class?.startsWith("strip"))[0]?.textContent ?? null;
// Types text into the YAML view: React reads the new value off the target of a bubbling input event.
async function typeYaml(root, value) {
  await act(async () => click(tab(root, "YAML")));
  await typeInto(find(root, (n) => n.attrs["aria-label"] === "Flow YAML")[0], value);
}
async function typeInto(el, value) {
  Object.assign(el, { value, selectionStart: value.length });
  await act(async () => { for (let n = el; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f({ type: "input", target: el, bubbles: true, preventDefault() {}, stopPropagation() {} }); });
}
const CI_LOOP = CI.replace(/(install: \{[^}]*needs: )\[\]/, "$1[test]");
const hidden = (root, cls) => find(root, (n) => n.attrs.hidden !== undefined).some((n) => find(n, (c) => c.attrs.class?.split(" ").includes(cls)).length);

describe("flows", () => {
  it("the flows page loads for a contributor when /api/keystore answers 403", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === base) return Response.json(repo);
      if (url === `${base}/flows?ref=${repo.default_branch}`) return Response.json([{ flow: "ci", head: HEAD, trigger: "change", on: ["change"], health: { passed: 0, failed: 0, n: 0, trusted: false } }]);
      if (url === "/api/keystore") return Response.json({ error: { code: "forbidden", message: "needs keystore.read" } }, { status: 403 });
      return Response.json([]);
    }));
    const data = await flowsLoader({ params: { repo: repo.name }, request: new Request(`http://x/${repo.name}/flows`) });
    expect(data.list.map((f) => f.flow)).toEqual(["ci"]);
    expect(data.secrets).toEqual([]);
  });

  it("with ?target=develop, flowsFor requests the flows at ref=develop and the bar reads target develop", async () => {
    const root = await page("?target=develop&view=designer", { ci: CI }, undefined, "develop");
    expect(fetch).toHaveBeenCalledWith(`${base}/flows?ref=develop`);
    expect(find(root, (n) => n.nodeName === "B" && n.textContent === "ci")).toHaveLength(1);
    expect(find(root, (n) => n.attrs.class === "meta" && n.textContent.startsWith(repo.name))[0].textContent).toBe(`${repo.name} · target develop`);
  });

  it("the flow list groups cards by On a change, On push and Scheduled with a health bar each", async () => {
    const NIGHTLY = "name: nightly\non: [cron, manual]\ncron: \"0 3 * * *\"\nsteps:\n  e2e: { stage: build, run: \"npm run e2e\", needs: [] }\n";
    const cards = { ci: { health: { passed: 7, failed: 3, n: 10, trusted: false }, last_run: { id: "r9", status: "failed", number: 12 } },
      deploy: { health: { passed: 30, failed: 0, n: 30, trusted: true }, last_run: { id: "r8", status: "passed", number: 30 } } };
    const root = await page("?view=designer&flow=ci", { ci: CI, deploy: DEPLOY, nightly: NIGHTLY }, undefined, undefined, [], cards);
    const groups = find(root, (n) => n.attrs.role === "group");
    expect(groups.map((g) => [g.attrs["aria-label"], find(g, (n) => n.nodeName === "B").map((b) => b.textContent)]))
      .toEqual([["On a change", ["ci"]], ["On push", ["deploy"]], ["Scheduled", ["nightly"]]]);
    const card = (flow) => find(root, (n) => n.attrs.class === "dfl fcard" && find(n, (b) => b.nodeName === "B")[0].textContent === flow)[0];
    const bar = (flow) => find(card(flow), (n) => n.attrs.class === "hbar")[0];
    expect(bar("ci").attrs.title).toBe("7 passed, 3 failed");
    expect(bar("ci").childNodes.map((i) => [i.attrs.class ?? "", i.style.flex])).toEqual([["", "7"], ["f", "3"]]);
    expect(bar("deploy").childNodes.map((i) => [i.attrs.class ?? "", i.style.flex])).toEqual([["", "30"]]);
    expect(card("ci").textContent).toBe("ci10 runschange, manualuntrusted: 10 outcomes");
    expect(card("deploy").textContent).toBe("deploy30 runspush, manual");
    expect(find(card("ci"), (n) => n.attrs.class?.startsWith("run-i"))[0].attrs.class).toBe("run-i fail");
    expect(find(card("nightly"), (n) => n.attrs.class?.startsWith("run-i"))).toEqual([]);
    expect(find(root, (n) => n.attrs.class === "mid mono")[0].attrs.title).toBe(repo.default_branch);
  });

  it("the designer loads flows with one request to /flows, not /tree", async () => {
    await page("?view=designer", { ci: CI, deploy: DEPLOY });
    const urls = fetch.mock.calls.map(([u]) => u);
    expect(urls.filter((u) => u === `${base}/flows?ref=${repo.default_branch}`)).toHaveLength(1);
    expect(urls.filter((u) => u.includes("/tree") || u.includes("/file?"))).toEqual([]);
    expect(urls.filter((u) => u.startsWith(`${base}/flows/`))).toEqual([`${base}/flows/ci?ref=${repo.default_branch}`]);
  });

  it("Flows renders its rail without waiting for me/accounts", async () => {
    const root = await page("?view=designer", { ci: CI, deploy: DEPLOY }, undefined, undefined, [], {}, false, true);
    expect(find(root, (n) => n.attrs.class === "dfl fcard").map((c) => c.textContent.split(/\d/)[0])).toEqual(["ci", "deploy"]);
    expect(fetch).toHaveBeenCalledWith("/api/me/accounts");
  });

  it("the Designer rail renders from the flows list alone, with no per-flow request", async () => {
    const cards = { ci: { health: { passed: 7, failed: 3, n: 10, trusted: false }, last_run: { id: "r9", status: "failed", number: 12 } } };
    const root = await page("?view=designer", { ci: CI, deploy: DEPLOY }, undefined, undefined, [], cards, true);
    const urls = fetch.mock.calls.map(([u]) => u);
    // The opened flow's file never answers, yet every card is drawn from the list; the canvas waits for its file.
    expect(find(root, (n) => n.attrs.class === "dfl fcard").map((c) => c.textContent)).toEqual(["ci10 runschange, manualuntrusted: 10 outcomes", "deploy0 runspush, manualuntrusted: 0 outcomes"]);
    expect(find(root, (n) => n.attrs["aria-busy"] === "true" && n.attrs.class === "panel dag-main")).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith(`${base}/flows`))).toEqual([`${base}/flows?ref=${repo.default_branch}`, `${base}/flows/ci?ref=${repo.default_branch}`]);
    // The branch list is asked for beside the flows list, right after it.
    expect(urls.slice(urls.indexOf(`${base}/flows?ref=${repo.default_branch}`))).toContain(`${base}/branches`);
  });

  it("Designer shows the first flow from the list response without a second request", async () => {
    const cards = { ci: { file: { yaml: CI, def: parseFlow(CI), last_run_steps: {} } } };
    // hold: a request for the flow's file would never answer, so the canvas draws only from the list.
    const root = await page("?view=designer", { ci: CI, deploy: DEPLOY }, undefined, undefined, [], cards, true);
    expect(find(root, (n) => n.attrs["aria-busy"] === "true" && n.attrs.class === "panel dag-main")).toEqual([]);
    expect(find(root, (n) => n.textContent === "install").length).toBeGreaterThan(0);
    expect(fetch.mock.calls.map(([u]) => u).filter((u) => u.startsWith(`${base}/flows`))).toEqual([`${base}/flows?ref=${repo.default_branch}`]);
  });

  it("a cycle never hangs layout: it shows a red edge and a banner", async () => {
    const root = await page("?view=designer&flow=loop", { loop: LOOP });
    const cyc = find(root, (n) => n.nodeName === "PATH" && n.attrs.class?.includes("cyc"));
    expect(cyc.map((p) => p.parentNode.attrs["data-edge"])).toEqual(["b>a", "a>b"]);
    expect(find(root, (n) => n.attrs.role === "status")[0].textContent).toBe("Cycle detected on b → a, a → b. The red edge won't run.");
    // Every step still gets a place: c sits a column after a.
    const left = Object.fromEntries(find(root, (n) => n.attrs["data-node"]).map((n) => [n.attrs["data-node"], n.style.left]));
    expect(left).toEqual({ a: "288px", b: "288px", c: "544px" });
  });

  it("the YAML round-trips (parse → edit → serialise) without loss", () => {
    for (const [path, text] of FLOWS) expect(flowYaml(parseFlow(text)), path).toBe(text);
    const flow = parseFlow(DEPLOY);
    const edited = { ...flow, steps: flow.steps.map((s) => (s.name === "build" ? { ...s, target: "Google Cloud", if: "failure()", needs: ["install", "test"] } : s)) };
    expect(parseFlow(flowYaml(edited))).toEqual(edited);
  });

  it("Graph / YAML and Runs / Designer show one view at a time", async () => {
    const root = await page("", { deploy: DEPLOY });
    expect([hidden(root, "tiles"), hidden(root, "dag-wrap")]).toEqual([false, true]);
    await act(async () => click(tab(root, "Designer")));
    expect([hidden(root, "tiles"), hidden(root, "dag-wrap")]).toEqual([true, false]);
    const views = () => [find(root, (n) => n.attrs["aria-label"] === "Flow graph").length, find(root, (n) => n.attrs["aria-label"] === "Flow YAML").length];
    expect(views()).toEqual([1, 0]);
    await act(async () => click(tab(root, "YAML")));
    expect(views()).toEqual([0, 1]);
    expect(find(root, (n) => n.attrs["aria-label"] === "Flow YAML")[0].defaultValue).toBe(DEPLOY); // the file as written
  });

  it("two push runs with ids sharing a prefix show different ids", async () => {
    const runs = ["push-c78aaaa1", "push-c78bbbb2"].map((id) => ({ ...RUN, id }));
    const root = await page("?view=runs", { deploy: DEPLOY }, () => Response.json(runs));
    const ids = find(root, (n) => n.attrs.class === "lc-s mono").map((n) => n.textContent.split(" · ")[0]);
    expect(ids).toEqual(["push-c78aaaa1", "push-c78bbbb2"]);
  });

  it("each runs-list row shows stage pips and links to /:repo/flows/runs/:id", async () => {
    const run = { ...RUN, stages: [{ id: "build", status: "passed" }, { id: "deploy", status: "failed" }] };
    const root = await page("?view=runs", { deploy: DEPLOY }, () => Response.json([run]));
    const row = find(root, (n) => n.attrs.class === "lc")[0];
    expect(row.nodeName).toBe("A");
    expect(row.attrs.href).toBe(`/${encodeURIComponent(repo.name)}/flows/runs/${RUN.id}`);
    expect(find(row, (n) => n.attrs.class?.startsWith("step ")).map((p) => [p.attrs.class, p.textContent])).toEqual([["step passed", "build"], ["step failed", "deploy"]]);
  });

  it("the tiles show the counts from the runs list", async () => {
    const tiles = (root) => Object.fromEntries(find(root, (n) => n.attrs.class === "tile flat").map((t) => [t.childNodes[0].textContent, t.childNodes[1].textContent]));
    const runs = [["r1", true, 90000], ["r2", false, 30000], ["r3", true, 150000], ["r4", false, null]]
      .map(([id, waiting_approval, step_ms]) => ({ ...RUN, id, waiting_approval, step_ms }));
    const root = await page("?view=runs", { deploy: DEPLOY }, () => Response.json(runs));
    expect(tiles(root)).toMatchObject({ "Median duration": "1m 30sn=3", "Waiting for approval": "2runs" });
    const empty = await page("?view=runs", { deploy: DEPLOY }, () => Response.json([]));
    expect(tiles(empty)).toMatchObject({ "Median duration": "—", "Waiting for approval": "—" });
  });

  it("the run summary's Quarantined card lists each quarantined test with this run's result, flake rate and since", async () => {
    const t1 = { test: "t1", runs: 50, flakes: 9, rate: 0.18, quarantined: true, quarantined_since: "2026-10-02T09:00:00Z", quarantined_by: "verifier", result: "fail" };
    const root = await page("?view=runs", { deploy: DEPLOY }, undefined, undefined, [t1, { ...t1, test: "t2", result: null }, { ...t1, test: "t3", quarantined_since: null, quarantined_by: null }]);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const card = find(root, (n) => n.nodeName === "SECTION" && n.childNodes[0]?.childNodes[0]?.textContent === "Quarantined")[0];
    expect(find(card, (n) => n.nodeName === "TR").map((r) => r.textContent)).toEqual(["TestThis runFlake rateSince", "t1failed · ignored18% · 9/50Oct 2", "t2not run18% · 9/50Oct 2"]);
    expect(find(card, (n) => n.nodeName === "A")[0].attrs.href).toBe(`/${encodeURIComponent(repo.name)}/settings#flaky-checks`);
    const none = await page("?view=runs", { deploy: DEPLOY });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(none.textContent).not.toContain("Quarantined");
  });

  it("a failed step's missing secret links to Keystore", async () => {
    const run = { ...RUN, status: "failed", steps: [{ name: "test", stage: "build", status: "failed", logs: "missing secret AWS_KEY: save it in Keystore\n", missing_secrets: ["AWS_KEY"] }] };
    const root = await page("?view=runs", { deploy: DEPLOY }, () => Response.json([run]));
    const line = find(root, (n) => n.attrs.class === "lc-s" && n.textContent.startsWith("Missing secret"))[0];
    expect(line?.textContent).toBe("Missing secret AWS_KEY · Save it in Keystore");
    expect(find(line, (n) => n.nodeName === "A")[0].attrs.href).toBe("/settings/keystore");
  });

  it("flows runs skeleton: 4 tiles, 7 step rows, a chart and 5 run cards, then a failed runs fetch shows the error with Retry", async () => {
    let fail;
    const root = await page("", { deploy: DEPLOY }, () => new Promise((_, reject) => { fail = reject; }));
    const count = (cls) => find(root, (n) => n.attrs.class === cls).length;
    expect([count("tile flat"), count("fstep"), count("chart-skel"), count("card skel-card")]).toEqual([4, 7, 1, 5]);
    expect(find(root, (n) => n.attrs.role === "status")[0].textContent).toBe("Loading runs");
    await act(async () => fail(new TypeError("Failed to fetch")));
    const err = find(root, (n) => n.attrs.role === "alert")[0];
    expect(err.textContent).toContain("Couldn't load runs");
    expect(err.textContent).toContain("Retry");
  });

  it("Validate, then add a cycle edge: the banner shows the cycle message, not Valid", async () => {
    const root = await page("?view=designer&flow=ci", { ci: CI });
    await act(async () => click(button(root, "Validate")));
    expect(banner(root)).toMatch(/^Valid\./);
    await typeYaml(root, CI_LOOP);
    expect(banner(root)).toMatch(/^Cycle detected on /);
  });

  it("remove the cycle: no cycle banner remains", async () => {
    const root = await page("?view=designer&flow=ci", { ci: CI_LOOP });
    await act(async () => click(button(root, "Validate")));
    expect(banner(root)).toMatch(/cycle/i);
    await typeYaml(root, CI);
    expect(banner(root)).toBe(null);
  });

  it("while the save request is pending, Save as change is disabled and shows a busy label", async () => {
    const root = await page("?view=designer&flow=ci", { ci: CI });
    const get = fetch;
    vi.stubGlobal("fetch", vi.fn((url, init) => (init?.method === "POST" ? new Promise(() => {}) : get(url, init))));
    await act(async () => click(button(root, "Save as change")));
    const save = button(root, "Saving…");
    expect(save.attrs.disabled).toBe("");
  });

  it("YAML with needs: [b] and no step b shows the validateFlow error banner and disables Save as change", async () => {
    const root = await page("?view=designer&flow=ci", { ci: CI });
    await typeYaml(root, "name: ci\non: [manual]\nsteps:\n  a: { stage: build, run: \"x\", needs: [b] }\n");
    expect(banner(root)).toBe("steps.a.needs: required, a list of other steps of this flow ([] for none)");
    expect(button(root, "Save as change").attrs.disabled).toBe("");
  });

  // Adds a Command step (selected on add) and types text into its Matrix field.
  async function matrix(text) {
    const root = await page("?view=designer&flow=ci", { ci: CI });
    await act(async () => click(find(root, (n) => n.attrs.class === "act" && n.textContent.startsWith("Command"))[0]));
    // React only reads change events off an input whose type is a text type; the fake DOM leaves it unset.
    const el = Object.assign(find(root, (n) => n.nodeName === "INPUT" && n.attrs.placeholder === "node: [20, 22]")[0], { type: "text" });
    await typeInto(el, text);
    return root;
  }

  it("a matrix of node: [18, 20] saves as an object", async () => {
    const root = await matrix("node: [18, 20]");
    const get = fetch, posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method !== "POST") return get(url, init);
      posts.push([url, init.body && JSON.parse(init.body)]);
      return Response.json({ id: "chg-1", fork: "fork-1", target_branch: repo.default_branch });
    }));
    await act(async () => click(button(root, "Save as change")));
    const [, body] = posts.find(([url]) => url.endsWith("/commits"));
    expect(parseFlow(body.changes[0].content).steps.find((s) => s.name === "command").matrix).toEqual({ node: ["18", "20"] });
  });

  it("an unparseable matrix blocks save with a field error", async () => {
    const root = await matrix("node: [18, 20]");
    expect(button(root, "Save as change").attrs.disabled).toBe(undefined); // a parsed matrix saves, so the block below is the parse
    await typeInto(find(root, (n) => n.nodeName === "INPUT" && n.attrs.placeholder === "node: [20, 22]")[0], "node: [18");
    expect(banner(root)).toMatch(/^steps\.command\.matrix: \{key: \[values\]\}/);
    expect(button(root, "Save as change").attrs.disabled).toBe("");
    // The text stays as typed, so it can be fixed in place.
    expect(find(root, (n) => n.nodeName === "INPUT" && n.attrs.placeholder === "node: [20, 22]")[0].value).toBe("node: [18");
  });

  it("flows designer skeleton: a real dotted grid, 5 empty ghost nodes with faint edges and the real 'Add a step' palette", async () => {
    const { routes } = await import("./routes.jsx");
    const { hydrateFallbackElement } = await routes[0].children.find((r) => r.id === "repo").children.find((r) => r.path === "flows").lazy();
    const router = createMemoryRouter([{ path: "/:repo/flows", element: <Flows />, hydrateFallbackElement, loader: () => new Promise(() => {}) }],
      { initialEntries: [`/${encodeURIComponent(repo.name)}/flows?view=designer`] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    expect(find(root, (n) => n.nodeName === "RECT" && n.attrs.fill === "url(#dots)")).toHaveLength(1);
    expect(find(root, (n) => n.attrs.class === "dag-n ghost")).toHaveLength(5);
    expect(find(root, (n) => n.attrs.class === "dag-e ghost")).toHaveLength(5);
    expect(find(root, (n) => n.nodeName === "H2").map((h) => h.textContent)).toContain("Add a step");
    expect(find(root, (n) => n.attrs.class === "act")).toHaveLength(5);
  });

  it("designer skeleton shows the palette beside the canvas", async () => {
    const { routes } = await import("./routes.jsx");
    const { hydrateFallbackElement } = await routes[0].children.find((r) => r.id === "repo").children.find((r) => r.path === "flows").lazy();
    const router = createMemoryRouter([{ path: "/:repo/flows", element: <Flows />, hydrateFallbackElement, loader: () => new Promise(() => {}) }],
      { initialEntries: [`/${encodeURIComponent(repo.name)}/flows?view=designer`] });
    const root = doc.body.appendChild(new El("div"));
    await act(async () => createRoot(root).render(<RouterProvider router={router} />));
    const [body] = find(root, (n) => n.attrs.class === "dag-body");
    expect(body.childNodes.map((n) => n.attrs.class)).toEqual(["dag-pal", "dag"]);
    expect(find(root, (n) => n.attrs.class?.includes("dag-insp"))[0].childNodes).toHaveLength(0);
    expect(find(body, (n) => n.attrs.class === "act").every((b) => b.attrs.disabled === "")).toBe(true);
  });
});
