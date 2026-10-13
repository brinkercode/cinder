import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { flowYaml, parseFlow, validateFlow } from "../../worker/src/api/contract.js";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Designer } = await import("./flows.jsx");

// install [288,64] → test [544,64] → verify [800,64]; lint has no needs, so it sits under install at [288,176].
const CI = "name: ci\non: [change, manual]\nsteps:\n  install: { stage: build, run: \"npm ci\", needs: [] }\n  test: { stage: build, run: \"npm test\", needs: [install] }\n"
  + "  verify: { stage: verify, uses: \"cinder/verify\", needs: [test] }\n  lint: { stage: build, run: \"npm run lint\", needs: [] }\n";
const BOX = { left: 10, top: 20 };
// A drag follows pointermove/pointerup on window; the fake DOM drops window listeners, so they're kept here.
const win = {};
vi.stubGlobal("addEventListener", (t, f) => { win[t] = f; });
vi.stubGlobal("removeEventListener", (t) => { delete win[t]; });

const find = (root, test) => all(root).filter((n) => n.nodeType === 1 && test(n));
const label = (root, l) => find(root, (n) => n.attrs["aria-label"] === l)[0];
// Dispatches a bubbling event; React reads it off the root's listeners.
const fire = (el, type, props = {}) => act(async () => {
  const e = { type, target: el, bubbles: true, button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, ...props };
  for (let n = el; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f(e);
});
// A canvas point at zoom z with no pan, in client pixels.
const client = ([x, y], z) => ({ clientX: BOX.left + x * z, clientY: BOX.top + y * z });
const dragWindow = async (to) => { await act(async () => win.pointermove(to)); await act(async () => win.pointerup(to)); };

async function designer(props = {}) {
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<Designer repo={{ name: "r" }} target="main" head={"a".repeat(40)} name="ci" text={CI} {...props} />));
  Object.assign(label(root, "Flow graph"), { getBoundingClientRect: () => BOX, clientWidth: 800, clientHeight: 400 });
  return root;
}
const graph = (root) => ({
  nodes: find(root, (n) => n.attrs["data-node"]).map((n) => [n.attrs["data-node"], n.style.left, n.style.top]),
  edges: find(root, (n) => n.attrs["data-edge"]).map((n) => n.attrs["data-edge"]),
});
const node = (root, name) => find(root, (n) => n.attrs["data-node"] === name)[0];
async function zoomTo(root, pct) {
  const button = label(root, pct < 100 ? "Zoom out" : "Zoom in");
  for (let i = 0; i < 5; i++) await act(async () => click(button));
  expect(label(root, "Reset zoom").textContent).toBe(`${pct}%`);
}
const dataTransfer = () => ({ data: {}, types: [], setData(k, v) { this.data[k] = v; this.types.push(k); }, getData(k) { return this.data[k] ?? ""; } });
const paletteDrop = async (root, at) => {
  const dt = dataTransfer();
  await fire(find(label(root, "Step palette"), (n) => n.attrs.class === "act" && n.textContent.startsWith("Command"))[0], "dragstart", { dataTransfer: dt });
  await fire(label(root, "Flow graph"), "drop", { ...at, dataTransfer: dt });
};

describe("designer", () => {
  it("undo restores the exact previous nodes, edges and positions, and redo re-applies them", async () => {
    const root = await designer();
    const g0 = graph(root);
    await fire(node(root, "test"), "pointerdown", client([600, 100], 1));
    await dragWindow(client([640, 116], 1));
    const g1 = graph(root);
    expect(g1.nodes.find(([n]) => n === "test")).toEqual(["test", "584px", "80px"]);
    await act(async () => click(label(root, "Add a step after verify")));
    const g2 = graph(root);
    expect(g2.edges).toContain("verify>command");
    const key = (shiftKey) => fire(label(root, "Flow graph"), "keydown", { key: shiftKey ? "Z" : "z", ctrlKey: true, shiftKey });
    await key(false);
    expect(graph(root)).toEqual(g1);
    await act(async () => click(label(root, "Undo (Ctrl Z)")));
    expect(graph(root)).toEqual(g0);
    await key(true);
    expect(graph(root)).toEqual(g1);
    await act(async () => click(label(root, "Redo (Ctrl Shift Z)")));
    expect(graph(root)).toEqual(g2);
  });

  it("the undo stack keeps 50 steps per flow", async () => {
    const root = await designer();
    const other = await designer({ name: "deploy" });
    const command = find(label(root, "Step palette"), (n) => n.attrs.class === "act" && n.textContent.startsWith("Command"))[0];
    for (let i = 0; i < 55; i++) await act(async () => click(command));
    expect(graph(root).nodes).toHaveLength(59);
    const undo = label(root, "Undo (Ctrl Z)");
    let n = 0;
    while (undo.attrs.disabled === undefined) { await act(async () => click(undo)); n++; }
    expect(n).toBe(50);
    expect(graph(root).nodes).toHaveLength(9); // the first 5 adds fell off the stack
    expect(label(other, "Undo (Ctrl Z)").attrs.disabled).toBe("");
  });

  it("a palette drop at 50% and at 150% zoom places the node at the pointer", async () => {
    const half = await designer();
    await zoomTo(half, 50);
    await paletteDrop(half, client([600, 400], 0.5));
    expect(node(half, "command").style).toMatchObject({ left: `${600 - 104}px`, top: `${400 - 42}px` });

    const big = await designer();
    await zoomTo(big, 150);
    // Pan by dragging the empty canvas 60, 30 screen pixels: 40, 20 canvas units at 150%.
    await fire(label(big, "Flow graph"), "pointerdown", { clientX: 110, clientY: 120 });
    await dragWindow({ clientX: 170, clientY: 150 });
    await paletteDrop(big, client([200, 100], 1.5));
    expect(node(big, "command").style).toMatchObject({ left: `${200 - 40 - 104}px`, top: `${100 - 20 - 42}px` });
  });

  it("node drag and drag-connect hit the right node at 50% and 150% zoom", async () => {
    for (const [z, pct] of [[0.5, 50], [1.5, 150]]) {
      const root = await designer();
      await zoomTo(root, pct);
      await fire(node(root, "test"), "pointerdown", client([600, 100], z));
      await dragWindow(client([640, 116], z));
      expect(node(root, "test").style, pct).toMatchObject({ left: "584px", top: "80px" });
      // From lint's out port to a point inside test's new box (584..792, 80..164), not where test was.
      await fire(find(root, (n) => n.attrs["data-out"] === "lint")[0], "pointerdown", client([496, 218], z));
      await dragWindow(client([780, 160], z));
      expect(graph(root).edges, pct).toContain("lint>test");
    }
  });

  it("quick-add + adds a step connected after the hovered one", async () => {
    const root = await designer();
    await act(async () => click(label(root, "Add a step after test")));
    expect(graph(root).edges).toEqual(["install>test", "test>verify", "test>command"]);
    expect(node(root, "command").style).toMatchObject({ left: "800px", top: "176px" });
    expect(find(root, (n) => n.attrs.class === "dag-n t-command sel").map((n) => n.attrs["data-node"])).toEqual(["command"]);
  });

  it("the edge into a running step is animated, and static under prefers-reduced-motion", async () => {
    const root = await designer({ last: { install: { status: "passed", ms: 1200 }, test: { status: "running", ms: 0 } } });
    const cls = (k) => find(root, (n) => n.attrs["data-edge"] === k)[0].childNodes[0].attrs.class;
    expect([cls("install>test"), cls("test>verify")]).toEqual(["dag-e live", "dag-e"]);
    expect(find(node(root, "install"), (n) => n.attrs.class === "dn-st")[0].textContent).toBe("passed1.2s");
    expect(find(node(root, "verify"), (n) => n.attrs.class === "dn-st")[0].textContent).toBe("not run yet");
    const css = readFileSync(new URL("styles/flows.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.dag-e\.live\{[^}]*animation:dag-flow [^}]*\}/);
    expect(readFileSync(new URL("styles/app.css", import.meta.url), "utf8")).toContain("@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}");
  });

  it("below 1000px the palette renders as a row", async () => {
    const root = await designer();
    expect(find(label(root, "Step palette"), (n) => n.attrs.class === "act").map((n) => n.attrs.draggable)).toEqual(["true", "true", "true", "true", "true"]);
    const css = readFileSync(new URL("styles/flows.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(max-width:1000px\)\{\.dag-body\{grid-template-columns:minmax\(0,1fr\)\}\.dag-pal\{flex-direction:row;flex-wrap:wrap/);
  });

  const LOOP = "name: loop\non: [manual]\nsteps:\n  a: { stage: build, run: \"echo a\", needs: [b] }\n  b: { stage: build, run: \"echo b\", needs: [a] }\n";
  const GATED = "name: ship\non: [manual]\nsteps:\n  install: { stage: build, run: \"npm ci\", needs: [] }\n  test: { stage: build, run: \"npm test\", needs: [install] }\n"
    + "  approve: { stage: gate, approval: \"maintainers\", needs: [test] }\n  ship: { stage: deploy, deploy: production, target: \"Cloudflare\", needs: [approve] }\n";
  const button = (root, text) => find(root, (n) => n.nodeName === "BUTTON" && n.textContent === text)[0];
  const banner = (root) => find(root, (n) => n.attrs.role === "status" && n.attrs.class?.startsWith("strip"))[0]?.textContent ?? null;
  const status = (root, name) => find(node(root, name), (n) => n.attrs.class === "dn-st")[0].textContent;
  const fld = (root, text) => find(root, (n) => n.attrs.class === "fld" && n.childNodes[0]?.textContent === text)[0];
  const pick = async (root, name) => { await fire(node(root, name), "pointerdown", client([300, 80], 1)); await dragWindow(client([300, 80], 1)); };
  const choose = async (select, value) => { select.value = value; await fire(select, "change"); };
  const noFetch = () => vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("no request expected"); });

  it("Validate shows exactly validateFlow's messages and sends no request", async () => {
    const spy = noFetch();
    for (const text of [LOOP, CI]) {
      const root = await designer({ name: parseFlow(text).name, text });
      await act(async () => click(button(root, "Validate")));
      const { errors } = validateFlow(parseFlow(text));
      expect(banner(root)).toBe(errors.length ? errors.join("; ") : "Valid. 4 steps, 2 dependencies, no cycles.");
    }
    expect(validateFlow(parseFlow(LOOP)).errors).toEqual(["steps: dependency cycle through a, b"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("Dry run walks levels queued → running → passed, skips gates, ends with the banner and sends no request", async () => {
    vi.useFakeTimers();
    const spy = noFetch();
    const root = await designer({ name: "ship", text: GATED });
    const now = () => ["install", "test", "approve", "ship"].map((n) => status(root, n));
    await act(async () => click(button(root, "Dry run")));
    expect(now()).toEqual(["running", "running", "queued", "queued"]);
    expect(button(root, "Dry run").attrs.disabled).toBe("");
    await act(async () => vi.advanceTimersByTime(700));
    expect(now()).toEqual(["passed", "passed", "skipped", "queued"]);
    await act(async () => vi.advanceTimersByTime(700));
    expect(now()).toEqual(["passed", "passed", "skipped", "running"]);
    expect(banner(root)).toBe(null);
    await act(async () => vi.advanceTimersByTime(700));
    expect(now()).toEqual(["passed", "passed", "skipped", "passed"]);
    expect(banner(root)).toBe("Dry run passed. 4 steps in 2.1s. Gates were skipped.");
    expect(button(root, "Dry run").attrs.disabled).toBe(undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    vi.useRealTimers();
  });

  it("Dry run is blocked while the graph has a cycle", async () => {
    const spy = noFetch();
    const root = await designer({ name: "loop", text: LOOP });
    await act(async () => click(button(root, "Dry run")));
    expect(banner(root)).toBe("Fix the cycle before a dry run.");
    expect([status(root, "a"), status(root, "b")]).toEqual(["not run yet", "not run yet"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("Split view highlights the selected step's YAML lines", async () => {
    const root = await designer();
    await act(async () => click(find(root, (n) => n.attrs.role === "tab" && n.textContent === "Split")[0]));
    expect(node(root, "test")).toBeTruthy(); // the graph stays beside the YAML
    await pick(root, "test");
    const lines = find(label(root, "Flow YAML lines"), (n) => n.attrs.class?.startsWith("yl"));
    expect(lines.map((l) => l.textContent.replace(/^\d+/, "")).join("")).toBe(flowYaml(parseFlow(CI)));
    expect(lines.map((l) => l.childNodes[0].textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(lines.filter((l) => l.attrs.class === "yl on").map((l) => l.textContent)).toEqual(['5  test: { stage: build, run: "npm test", needs: [install] }\n']);
  });

  it("the Step tab lists repo-scoped keystore names as secrets and the pools as worker pools", async () => {
    const pools = [{ name: "build", labels: ["linux"] }, { name: "eu-gpu", labels: ["gpu", "large-disk"] }];
    const secrets = [{ name: "NPM_TOKEN", scope: "repo", repo: "r" }, { name: "SENTRY_DSN", scope: "global", repo: null },
      { name: "OTHER_TOKEN", scope: "repo", repo: "other" }, { name: "PROD_DB", scope: "environment", repo: "r", environment: "production" }];
    const root = await designer({ pools, secrets });
    await pick(root, "install");
    const pool = find(fld(root, "Worker pool"), (n) => n.nodeName === "SELECT")[0];
    expect(find(pool, (n) => n.nodeName === "OPTION").map((o) => o.textContent)).toEqual(["Flow default", "build", "eu-gpu"]);
    const boxes = find(fld(root, "Secrets"), (n) => n.nodeName === "INPUT");
    expect(boxes.map((b) => b.parentNode.textContent)).toEqual(["NPM_TOKEN", "SENTRY_DSN", "PROD_DB"]);
    expect(fld(root, "Secrets").textContent).toContain("Injected from Keystore at run time.");
    await choose(pool, "gpu,large-disk");
    boxes[0].checked = true; // a browser toggles a checkbox before its click event
    await fire(boxes[0], "click");
    await act(async () => click(find(root, (n) => n.attrs.role === "tab" && n.textContent === "YAML")[0]));
    expect(label(root, "Flow YAML").defaultValue).toContain('install: { stage: build, run: "npm ci", runs-on: [gpu, large-disk], secrets: [NPM_TOKEN], needs: [] }');
  });

  const fields = (root) => find(root, (n) => n.attrs.class === "fld").map((f) => f.childNodes[0].textContent);
  const yamlOf = async (root) => { await act(async () => click(find(root, (n) => n.attrs.role === "tab" && n.textContent === "YAML")[0])); return label(root, "Flow YAML").defaultValue; };

  it("Fields switch with Target without losing the other step fields", async () => {
    const root = await designer({ text: GATED });
    await pick(root, "ship");
    await choose(find(fld(root, "Environment"), (n) => n.nodeName === "SELECT")[0], "staging");
    await choose(find(fld(root, "Retries"), (n) => n.nodeName === "SELECT")[0], "2");
    await choose(find(fld(root, "Target"), (n) => n.nodeName === "SELECT")[0], "AWS");
    expect(fields(root)).toEqual(expect.arrayContaining(["Authentication", "Role ARN", "Region", "Service", "Resource"]));
    const region = find(fld(root, "Region"), (n) => n.nodeName === "INPUT")[0];
    region.value = "eu-west-1";
    await fire(region, "input");
    await choose(find(fld(root, "Service"), (n) => n.nodeName === "SELECT")[0], "lambda");
    await choose(find(fld(root, "Target"), (n) => n.nodeName === "SELECT")[0], "Bring your own (SSH)");
    expect(fields(root)).toEqual(expect.arrayContaining(["Host", "User", "Command", "Known host fingerprint", "Key secret"]));
    expect(fields(root)).not.toContain("Region");
    expect(find(fld(root, "Environment"), (n) => n.nodeName === "SELECT")[0].value).toBe("staging");
    expect(find(fld(root, "Retries"), (n) => n.nodeName === "SELECT")[0].value).toBe("2");
    await choose(find(fld(root, "Target"), (n) => n.nodeName === "SELECT")[0], "AWS");
    const yaml = await yamlOf(root);
    expect(yaml).toContain('ship: { stage: deploy, deploy: staging, target: "AWS", retries: "2", needs: [approve] }');
  });

  it("Secrets are picked by name only", async () => {
    const secrets = [{ name: "AWS_DEPLOY_KEY", scope: "repo", repo: "r" }, { name: "SSH_DEPLOY_KEY", scope: "global", repo: null }];
    const root = await designer({ text: GATED, secrets });
    await pick(root, "ship");
    await choose(find(fld(root, "Target"), (n) => n.nodeName === "SELECT")[0], "AWS");
    await choose(find(fld(root, "Authentication"), (n) => n.nodeName === "SELECT")[0], "secret");
    expect(fld(root, "Role ARN")).toBe(undefined);
    const secret = fld(root, "Secret");
    expect(find(secret, (n) => n.nodeName === "INPUT" || n.nodeName === "TEXTAREA")).toEqual([]);
    expect(find(secret, (n) => n.nodeName === "OPTION").map((o) => o.textContent)).toEqual(["Pick a Keystore secret", "AWS_DEPLOY_KEY", "SSH_DEPLOY_KEY"]);
    await choose(find(secret, (n) => n.nodeName === "SELECT")[0], "AWS_DEPLOY_KEY");
    await choose(find(fld(root, "Target"), (n) => n.nodeName === "SELECT")[0], "Bring your own (SSH)");
    const key = fld(root, "Key secret");
    expect(find(key, (n) => n.nodeName === "INPUT" || n.nodeName === "TEXTAREA")).toEqual([]);
    await choose(find(key, (n) => n.nodeName === "SELECT")[0], "SSH_DEPLOY_KEY");
    expect(await yamlOf(root)).toContain('ssh: { key_secret: "SSH_DEPLOY_KEY" }');
    expect(validateFlow({ ...parseFlow(GATED), steps: [{ name: "ship", stage: "deploy", deploy: "production", needs: [], ssh: { key_secret: "-----BEGIN KEY" } }] }).errors)
      .toContain("steps.ship.ssh.key_secret: expected a Keystore secret's name");
  });

  it("Save as change commits only .cinder/flows/<flow>.yml to the target branch", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    const posts = [];
    let commit = () => Response.json({ sha: "b".repeat(40) }, { status: 201 });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      posts.push([url, init.body && JSON.parse(init.body)]);
      return url.endsWith("/commits") ? commit() : Response.json({ id: "chg-1", fork: "fork-1", target_branch: "release" });
    });
    const reload = vi.fn();
    const root = await designer({ target: "release", reload });
    await pick(root, "install");
    await choose(find(fld(root, "Retries"), (n) => n.nodeName === "SELECT")[0], "2");
    await act(async () => click(button(root, "Save as change")));
    expect(posts.find(([url]) => url === "/api/repos/r/changes")[1]).toMatchObject({ target_branch: "release" });
    const commits = posts.filter(([url]) => url.endsWith("/commits"));
    expect(commits).toHaveLength(1);
    const [url, body] = commits[0], flow = parseFlow(CI);
    flow.steps[0].retries = "2";
    expect([url, body.branch, body.base_sha]).toEqual(["/api/repos/fork-1/commits", "release", "a".repeat(40)]);
    expect(body.changes).toEqual([{ path: ".cinder/flows/ci.yml", content: flowYaml(flow) }]);
    expect(body.changes[0].content).toContain('install: { stage: build, run: "npm ci", retries: "2", needs: [] }');
    expect(reload).not.toHaveBeenCalled();

    commit = () => Response.json({ error: { code: "conflict", message: "release moved" } }, { status: 409 });
    await act(async () => click(button(root, "Save as change")));
    expect(banner(root)).toBe("release moved since this page loaded. Reloading it…");
    expect(reload).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    vi.unstubAllEnvs();
  });
});
