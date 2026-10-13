import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";
import judges from "../../worker/src/api/fixtures/judges.json";

// As new-change-live.test.jsx: React probes `"oninput" in document` at import, so typing needs it set first.
doc.oninput = null;
// React looks up a clicked radio's group to restore it; the fake DOM has none to find.
El.prototype.querySelectorAll = () => [];

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { routes } = await import("./routes.jsx");
// Pages load lazily: importing them here first lets a render resolve its route without waiting on a fresh import.
await import("./change.jsx");

const at = "2026-10-06T10:00:00.000Z";
const event = (kind, from, to, reason) => ({ id: `e-${kind}`, change_id: "c1", kind, from_state: from, to_state: to, at, actor: { type: "human", id: "owner" },
  action: "stage.decide", target: "c1", result: "ok", ...(reason && { reason }) });
const verified = () => ({ id: "c1", repo_id: "r", kind: "change", title: "Declined cards retry forever", intent: "Declined cards retry forever", target_branch: "main",
  state: "verifying", fork: "f", stacked_on: null, risk: null, created_at: at, updated_at: at, events: [event("created", "draft", "planned")], blockers: [],
  review: { route: "human", reason: "risk high" }, reviewers: [{ agent_version: "reviewer@v3" }], approvals: [], auto_queue: true, head_branch: "fix-retry" });
const FILES = [{ path: "src/payments/retry.ts", status: "modified", lines: [...Array.from({ length: 7 }, (_, i) => ` line ${i + 1}`), "-const jitter = 0.2;", "+const jitter = 0;", " keep();"] },
  { path: "README.md", status: "modified", lines: [" # Retry policy", "+Declined cards stop."] }];
const check = (name, status) => ({ kind: "verify", name, status, sha: "abc1234", duration_ms: 4000, log_url: null });
const commit = (sha, message) => ({ sha, message, author: { name: "maya" }, trailers: [] });

// A stand-in Worker for one change: each write changes what the next GET returns, as the real routes do.
// Its per-change lists: /commits, /checks, /files and the target's merge queue.
// /repairs answers `repairs`, or what the function `repairs` returns.
function server(change, { commits = [], checks = [], files = FILES, queue = [], repairs = [], seed = [], collisions } = {}) {
  const threads = [...seed];
  return vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const act = url.split("/").pop();
    if (url === "/api/live-ticket") return Response.json({ ticket: "t" });
    if (init.method === "PATCH") Object.assign(change, body);
    if (init.method === "POST") {
      if (act === "takeover" || act === "release") change.driver = act === "takeover" ? "owner" : null;
      if (act === "review" && body.verdict === "approve") change.approvals = [{ actor: { type: "human", id: "owner" }, head_sha: null, at }];
      if (act === "review" && body.verdict === "request_changes") Object.assign(change, { state: "needs_fix", events: [...change.events, event("changes_requested", "verifying", "needs_fix", body.body)] });
      if (act === "threads") threads.push({ id: `t${threads.length}`, path: body.path ?? null, side: body.side ?? null, line: body.line ?? null, head_sha: null, outdated: false,
        resolved: false, state_by: null, applied_sha: null, suggestion: null, comments: [{ actor: "owner", body: body.body, at }] });
      const thread = threads.find((t) => url.includes(`/threads/${t.id}/`));
      if (act === "resolve" || act === "reopen") Object.assign(thread, { resolved: act === "resolve", state_by: "owner" });
      if (act === "apply") Object.assign(thread, { resolved: true, state_by: "owner", applied_sha: "abc1234def" });
      if (act === "queue" || act === "close") change.state = act === "queue" ? "in_queue" : "closed";
      if (act === "retry") change.state = "verifying";
      return Response.json({});
    }
    if (url.includes("/queue?")) return Response.json(queue);
    if (url.endsWith("/repairs")) return typeof repairs === "function" ? repairs() : Response.json(repairs);
    const lists = { threads, changes: [change], commits, checks, files, ...(collisions && { "collisions?target=main": collisions }) };
    return Response.json(lists[url.split("/").pop()] ?? change);
  });
}

// The real change route from routes.jsx, under /:repo. Each mount's live sockets are kept, so a test can send an event.
const sockets = [];
const flat = (rs) => rs.flatMap((r) => [r, ...flat(r.children ?? [])]);
const route = flat(routes).find((r) => r.path === "changes/:id/:tab?");
async function mount(fetch, at = "/web/changes/c1") {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("location", { protocol: "http:", host: "cinder.test" });
  vi.stubGlobal("WebSocket", class { constructor() { sockets.push(this); } close() {} });
  vi.stubGlobal("fetch", fetch);
  const router = createMemoryRouter([{ path: "/:repo/changes", element: <p>board</p> }, { ...route, path: "/:repo/changes/:id/:tab?" }], { initialEntries: [at] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const find = (pred) => all(root).find(pred);
  const named = (name) => find((n) => ["BUTTON", "TEXTAREA", "INPUT"].includes(n.nodeName) && (n.textContent === name || n.attrs["aria-label"] === name));
  const box = (name) => find((n) => n.nodeName === "TEXTAREA" && n.attrs["aria-label"] === name);
  const press = (name) => act(async () => click(find((n) => n.nodeName === "BUTTON" && (n.textContent === name || n.attrs["aria-label"] === name))));
  const pick = (label) => act(async () => click(find((n) => n.nodeName === "INPUT" && n.parentNode.textContent.startsWith(label))));
  // As flows.test.jsx: React reads the new value from the input event's target, a text input by type.
  const type = (name, value) => act(async () => {
    const el = Object.assign(box(name), { type: "text", value });
    for (let n = el; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f({ type: "input", target: el, bubbles: true, preventDefault() {}, stopPropagation() {} });
  });
  return { root, router, find, named, box, press, pick, type, text: () => root.textContent };
}

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("change detail", () => {
  it("Change detail renders its header before the files response arrives", async () => {
    const base = server(verified());
    let land;
    const held = new Promise((r) => { land = r; });
    const fetch = vi.fn((url, init) => (url.endsWith("/files") ? held.then(() => base(url, init)) : base(url, init)));
    const { text } = await mount(fetch);
    expect(text()).toContain("Declined cards retry forever");
    expect(text()).toContain("created");
    expect(text()).not.toContain("src/payments/retry.ts");
    await act(async () => land());
    expect(text()).toContain("src/payments/retry.ts");
  });

  const UUID = "0b4f8c2e-5d6a-4e1b-9c3f-7a8b9c0d1e2f";
  const pulse6 = () => ({ ...verified(), id: UUID, number: 6, key: "PULSE-6" });

  it("/pulse/changes/PULSE-6 opens change PULSE-6", async () => {
    const base = server(pulse6());
    // Only the repo-scoped key and the id find the change, as the Worker does.
    const fetch = vi.fn((url, init) => (url.startsWith("/api/changes/") && !url.startsWith(`/api/changes/${UUID}`) && url !== "/api/changes/PULSE-6?repo=pulse"
      ? Response.json({ error: "not_found" }, { status: 404 }) : base(url, init)));
    const { text } = await mount(fetch, "/pulse/changes/PULSE-6");
    expect(text()).toContain("Declined cards retry forever");
    expect(fetch.mock.calls.map(([url]) => url)).toContain(`/api/changes/${UUID}/threads`);
  });

  it("the change detail shows PULSE-6 and no c-xxxxxxxx identifier", async () => {
    const { text } = await mount(server(pulse6()), `/web/changes/${UUID}`);
    expect(text()).toContain("PULSE-6");
    expect(text()).not.toContain("0b4f8c2e");
  });

  it("the change's branch is shown as its key", async () => {
    const { find } = await mount(server(pulse6()), `/web/changes/${UUID}`);
    // The pill after "wants to merge" is the change's branch ("wants to merge <branch> → main").
    const wants = find((n) => n.textContent === "wants to merge" && n.nodeType === 1);
    const siblings = wants.parentNode.childNodes;
    expect(siblings[siblings.indexOf(wants) + 1].textContent).toBe("PULSE-6");
  });

  it("label edits save immediately from the change rail", async () => {
    const fetch = server(verified());
    const { named, press, text } = await mount(fetch);
    const input = Object.assign(named("Find or create a label"), { type: "text", value: "cart" });
    const fire = (type, extra) => { for (let n = input; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f({ type, target: input, bubbles: true, preventDefault() {}, stopPropagation() {}, ...extra }); };
    await act(async () => fire("input"));
    await act(async () => fire("keydown", { key: "Enter" }));
    expect(fetch).toHaveBeenCalledWith("/api/changes/c1", expect.objectContaining({ method: "PATCH", body: '{"labels":["cart"]}' }));
    expect(named("Remove cart")).toBeDefined();
    await press("Remove cart");
    expect(fetch.mock.calls.filter(([, i]) => i?.method === "PATCH").map(([, i]) => i.body)).toEqual(['{"labels":["cart"]}', '{"labels":[]}']);
    expect(text()).toContain("No labels");
  });

  it("Every action in Layout mutates state and re-renders without a reload", async () => {
    const fetch = server(verified());
    const { named, box, press, pick, type, text, find } = await mount(fetch);
    expect(text()).toContain("1 of 1 open");

    await press("Take over");
    expect(text()).toContain("owner holds the lease on this change.");
    expect(find((n) => n.nodeName === "A" && n.textContent === "Edit in Code").attrs.href).toBe("/web/code/c1/src/payments/retry.ts");
    await press("Hand to an agent");
    expect(text()).not.toContain("holds the lease");

    await type("Comment", "Ship it after the jitter fix");
    await press("Comment");
    expect(text()).toContain("ownercommented · ");
    expect(text()).toContain("Ship it after the jitter fix");

    await press("Files changed 2");
    await press("Comment on line 8");
    expect(box("Comment on line 8")).toBeDefined();
    await press("Cancel");
    expect(box("Comment on line 8")).toBeUndefined();
    await press("Comment on line 8");
    await type("Comment on line 8", "Why not 0 in tests?");
    await press("Comment");
    expect(fetch).toHaveBeenCalledWith("/api/changes/c1/threads", expect.objectContaining({ body: JSON.stringify({ path: "src/payments/retry.ts", side: "old", line: 8, body: "Why not 0 in tests?" }) }));
    expect(text()).toContain("ownerWhy not 0 in tests?");
    await press("Fold README.md");
    expect([text().includes("Retry policy"), !!named("Unfold README.md")]).toEqual([false, true]);
    const viewed = find((n) => n.nodeName === "INPUT" && n.parentNode.textContent === "Viewed");
    viewed.checked = true;
    await act(async () => click(viewed));
    expect(find((n) => n.attrs.class === "tr-f").childNodes).toHaveLength(3); // file icon, path and the viewed check

    await press("Conversation 4");
    named("Auto-queue").checked = false;
    await act(async () => click(named("Auto-queue")));
    expect(fetch).toHaveBeenCalledWith("/api/changes/c1/auto_queue", expect.objectContaining({ method: "PATCH", body: '{"auto_queue":false}' }));
    expect(named("Auto-queue").checked).toBe(false);
    expect(named("Add to merge queue").attrs).toHaveProperty("disabled");
    await pick("Approve");
    await press("Submit review");
    expect(text()).toContain("Human approval given");
    expect(named("Add to merge queue").attrs).not.toHaveProperty("disabled");
    await press("Add to merge queue");
    expect(text()).toContain("In merge queue");
    await press("Close change");
    expect([text().includes("closed"), box("Comment"), named("Take over")]).toEqual([true, undefined, undefined]);

    const asked = await mount(server(verified()));
    await asked.pick("Request changes");
    await asked.type("Review comment", "Jitter must be 0 in tests");
    await asked.press("Submit review");
    expect(asked.text()).toContain("Changes requested");
    expect(asked.text()).toContain("Jitter must be 0 in tests");
  });

  it("Request changes sets the pill to Changes requested", async () => {
    const { pick, type, press, find } = await mount(server(verified()));
    await pick("Request changes");
    await type("Review comment", "Jitter must be 0 in tests");
    await press("Submit review");
    expect(find((n) => n.attrs.class === "pill").textContent).toBe("Changes requested");
  });

  it("the collision card's controls show on the change that holds the open collision", async () => {
    const f = { id: "col-1", conflict_id: "cf-1", ours: "c2", theirs: "c1", symbol: "src/payments/retry.ts#retry", kind: "body", severity: "low", p: 1,
      message: "c1 leases retry and your change edits its body.", action: "Stopped; the change moved to conflict", detected_at: at, resolution: null, resolved_at: null };
    const { named, text } = await mount(server(verified(), { collisions: { feed: [f], editing: [] } }));
    expect(text()).toContain("Collides with c2");
    expect([named("Stack"), named("Seam"), named("Hand over"), named("Go first"), named("Stack c2 on c1")].every(Boolean)).toBe(true);
  });

  it("There's no merge button for humans. Merging always goes through the verifier queue", async () => {
    const fetch = server({ ...verified(), approvals: [{ actor: { type: "human", id: "owner" }, head_sha: null, at }] });
    const { root, press } = await mount(fetch);
    const buttons = all(root).filter((n) => n.nodeName === "BUTTON").map((n) => n.textContent);
    expect(buttons.filter((b) => /merge/i.test(b))).toEqual(["Add to merge queue"]);
    await press("Add to merge queue");
    const writes = fetch.mock.calls.filter(([url, init]) => init?.method === "POST" && url !== "/api/live-ticket").map(([url]) => url);
    expect(writes).toEqual(["/api/changes/c1/queue"]);
  });

  it("after clicking Close change, the button is disabled until the action resolves", async () => {
    const worker = server(verified());
    let release;
    const fetch = vi.fn((url, init) => (url.endsWith("/close") ? new Promise((r) => { release = () => r(worker(url, init)); }) : worker(url, init)));
    const { named, press, find, text } = await mount(fetch);
    await press("Close change");
    expect(named("Close change").attrs).toHaveProperty("disabled");
    expect(find((n) => n.attrs.class === "cd-grid").attrs["aria-busy"]).toBe("true");
    await press("Close change");
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/close"))).toHaveLength(1);
    await act(async () => release());
    expect([text().includes("closed"), named("Close change")]).toEqual([true, undefined]);
  });

  const draft = () => ({ ...verified(), state: "draft", review: undefined });
  const readied = (change, fail) => {
    const worker = server(change);
    return vi.fn(async (url, init) => {
      if (!url.endsWith("/ready")) return worker(url, init);
      if (fail) return Response.json({ error: { code: "unavailable", message: "no runner" } }, { status: 503 });
      Object.assign(change, { state: "verifying", head_sha: "abc1234def" });
      return Response.json(change);
    });
  };

  it("Mark ready moves a draft to verifying and the strip says the verifier is starting", async () => {
    const { press, text } = await mount(readied(draft()));
    expect(text()).toContain("The verifier doesn't run on a draft");
    await press("Mark ready");
    expect(text()).toContain("Verifying");
    expect(text()).toContain("Verifier starting on abc1234");
  });

  it("the verifier starts within one tick: Mark ready posts once and the readiness row reads queued", async () => {
    const fetch = readied(draft());
    const { press, text } = await mount(fetch);
    await press("Mark ready");
    expect(fetch.mock.calls.filter(([url]) => url === "/api/changes/c1/ready")).toHaveLength(1);
    expect(text()).toContain("Verifier queued");
    expect(text()).not.toContain("Verifier not started");
  });

  it("a failed Mark ready leaves the change a draft and shows the error in place with Try again", async () => {
    const { press, text, named } = await mount(readied(draft(), true));
    await press("Mark ready");
    expect(text()).toContain("Couldn't start the verifier");
    expect(text()).toContain("The change stays a draft");
    expect(named("Try again")).toBeDefined();
  });

  const planned = () => ({ ...verified(), review: { route: "human", reason: "deploy plan prunes kv old-sessions; migrations/0003_drop_legacy.sql drops" }, deploy_plan: {
    destructive: "prunes kv old-sessions; migrations/0003_drop_legacy.sql drops",
    environments: [{ name: "staging", steps: ["create d1 flow-db", "prune kv old-sessions", "apply migrations/0002_add_index.sql", "apply migrations/0003_drop_legacy.sql", "bind FLOW_DB"] }] } });

  it("renders create, prune and migrate rows from a fixture", async () => {
    const { text } = await mount(server(planned()));
    for (const s of ["Deploy planhuman review", "Routed to human: deploy plan prunes kv old-sessions", "staging",
      "created1 flow-db", "prunekv old-sessions", "migratemigrations/0002_add_index.sql", "configbind FLOW_DB"]) expect(text()).toContain(s);
  });

  it("a destructive item shows its warning", async () => {
    const page = (await mount(server(planned()))).text();
    expect(page).toContain("prunekv old-sessionsdestructive");
    expect(page).toContain("migratemigrations/0003_drop_legacy.sqldestructive");
    expect(page).not.toContain("migratemigrations/0002_add_index.sqldestructive");
  });

  it("the rail renders the change's labels", async () => {
    expect((await mount(server({ ...verified(), labels: ["qa", "billing"] }))).text()).toContain("Labelsqabilling");
  });

  it("a change with no deploy plan says merging touches no environment", async () => {
    expect((await mount(server(verified()))).text()).toContain("No deploy changes. Merging this touches no environment.");
  });

  it("Commits tab count and table show the 2 commits from /commits with no view, and the header reads 2 commits", async () => {
    const { root, press, text } = await mount(server(verified(), { commits: [commit("aaaaaaa1", "Stop retrying declined cards\n\nbody"), commit("bbbbbbb2", "Add jitter")] }));
    expect(text()).toContain("· 2 commits · ");
    await press("Commits 2");
    expect(all(root).filter((n) => n.nodeName === "TR").map((r) => r.textContent)).toEqual(["aaaaaaaStop retrying declined cardsMmaya", "bbbbbbbAdd jitterMmaya"]);
  });

  it("a change with one commit shows 1 commit", async () => {
    expect((await mount(server(verified(), { commits: [commit("aaaaaaa1", "Add jitter")] }))).text()).toContain("· 1 commit · ");
  });

  it("Change detail for a change with no head branch and one commit touching 3 files renders across 3 files, not 0", async () => {
    const files = [{ path: "a.md", status: "added", lines: ["+one", "+two"] }, { path: "b.md", status: "modified", lines: [" keep", "-old", "+new"] },
      { path: "c.md", status: "deleted", lines: ["-gone"] }];
    const { text } = await mount(server({ ...verified(), head_branch: undefined }, { commits: [commit("aaaaaaa1", "Submit")], files }));
    expect(text()).toContain("+3 −2 across 3 files");
    expect(text()).toContain("Files changed 3");
  });

  it("a change with a pending commit job renders waiting for a worker in Files changed", async () => {
    const { press, text } = await mount(server({ ...verified(), head_branch: undefined, state: "leased", head_sha: null, commit_job: { status: "queued", path: "test/manual-qa-a.md" } }, { files: [] }));
    expect(text()).toContain("Committing your edit… · waiting for a worker");
    await press("Files changed 0");
    expect(text()).toContain("Committing your edit…The commit of test/manual-qa-a.md is waiting for a worker.");
    expect(text()).not.toContain("No files changed");
  });

  it("a change whose commit job failed renders the failure with a retry action", async () => {
    const { press, text } = await mount(server({ ...verified(), head_branch: undefined, state: "failed", head_sha: null, commit_job: { status: "failed", path: "test/manual-qa-a.md" } }, { files: [] }));
    expect(text()).toContain("Edit commit failed");
    await press("Files changed 0");
    expect(text()).toContain("The commit job for test/manual-qa-a.md failed");
  });

  it("Retry in Code links to the change's workspace", async () => {
    const { find, press } = await mount(server({ ...verified(), head_branch: undefined, state: "failed", head_sha: null, commit_job: { status: "failed", path: "test/manual-qa-a.md" } }, { files: [] }));
    await press("Files changed 0");
    expect(find((n) => n.nodeName === "A" && n.textContent === "Retry in Code").attrs.href).toBe("/web/code/c1/test/manual-qa-a.md");
  });

  it("an empty commits list renders the Commits empty state", async () => {
    const { press, text } = await mount(server(verified()));
    await press("Commits 0");
    expect(text()).toContain("No commits yet");
  });

  it("Checks rows and the n of m checks readiness line come from the /checks stub", async () => {
    const { root, press, text } = await mount(server(verified(), { checks: [check("verify@v1", "pass"), check("verify@v2", "pass"), check("judge@v1", "pending")] }));
    expect(text()).toContain("Verifier passed2 of 3 checks passed");
    await press("Checks 3");
    expect(all(root).filter((n) => n.nodeName === "SUMMARY").slice(1).map((r) => r.textContent)).toEqual(["verify@v1verify4s", "verify@v2verify4s", "judge@v1verify4s"]);
  });

  it("quarantined tests never affect the verdict: the quarantined check row shows flake rate, since and Manage, and the verifier passes", async () => {
    const held = { kind: "test", name: "t1", status: "quarantined", flake_rate: 0.18, since: "2026-10-02T09:00:00Z", sha: "abc1234", duration_ms: null, log_url: null };
    const { root, press, text } = await mount(server(verified(), { checks: [check("verify@v1", "pass"), held] }));
    expect(text()).toContain("Verifier passed1 of 2 checks passed");
    await press("Checks 2");
    expect(all(root).filter((n) => n.nodeName === "SUMMARY").at(-1).textContent).toBe("t1testquarantinedflake 18% · since Oct 2 · excluded from the verdictManage");
    expect(all(root).find((n) => n.nodeName === "A" && n.textContent === "Manage").attrs.href).toBe("/web/settings#flaky-checks");
  });

  it("a guard blocker is a readiness row with its why and a link to Needs you", async () => {
    const { find, text } = await mount(server({ ...verified(), blocked: "Blocked: new dependency p-retry 6.2.1 needs approval" }));
    expect(text()).toContain("Blocked: new dependency p-retry 6.2.1 needs approvalDecide in Needs you");
    expect(find((n) => n.nodeName === "A" && n.textContent === "Decide in Needs you").attrs.href).toBe("/needs");
    expect(text()).toContain("Not ready");
  });

  it("readiness agrees with the state: in_queue has no Not ready pill, needs_fix with a failed check fails the verifier, one Approved review is approval given", async () => {
    const queued = await mount(server({ ...verified(), state: "in_queue" }, { queue: ["c0", "c1"].map((id, position) => ({ repo_id: "r", target_branch: "main", change_id: id, position, speculative_base: null, enqueued_at: at, blocker: null })) }));
    expect(queued.text()).not.toContain("Not ready");
    expect(queued.text()).toContain("In merge queue · position 2 of 2");
    const fix = await mount(server({ ...verified(), state: "needs_fix", review: null }, { checks: [check("verify@v1", "fail")] }));
    expect(fix.text()).toContain("Verifier failed1 of 1 checks failed");
    const approved = await mount(server({ ...verified(), state: "needs_fix", approvals: [{ actor: { type: "human", id: "owner" }, head_sha: null, at }] }));
    const rows = all(approved.root).filter((n) => n.attrs.class === "rd").map((n) => n.textContent);
    expect(rows).toContain("Human approval givenApproved at the head");
    expect(rows.filter((r) => r.startsWith("Changes requested"))).toEqual([]);
  });

  it("Add to merge queue is disabled while the head is unverified and names the blocking row", async () => {
    const { named, text } = await mount(server({ ...verified(), approvals: [{ actor: { type: "human", id: "owner" }, head_sha: null, at }], queue_blocker: "Verifier hasn't passed the head" }));
    expect(text()).toContain("Human approval given");
    expect(text()).toContain("Not ready");
    expect(named("Add to merge queue").attrs).toHaveProperty("disabled");
    expect(text()).toContain("Blocked: Verifier hasn't passed the head.");
  });

  it("a change with review.route agent and one human approval renders Human approval as Human approval given", async () => {
    const { root } = await mount(server({ ...verified(), review: { route: "agent", reason: "risk low" }, approvals: [{ actor: { type: "human", id: "maya" }, head_sha: null, at }] }));
    expect(all(root).filter((n) => n.attrs.class === "rd").map((n) => n.textContent)).toContain("Human approval givenApproved at the head");
  });

  it("a blocked change's reason is not the raw state name", async () => {
    const { text } = await mount(server({ ...verified(), state: "failed" }));
    expect(text()).toContain("Verifier blockedThe agent stopped before the change passed verification");
    expect(text()).not.toMatch(/Verifier blockedfailed/);
  });

  it("Close asks for confirmation and moves to closed. The leases are released", async () => {
    El.prototype.showModal = vi.fn();
    const fetch = vi.fn(server({ ...verified(), state: "failed", failure: { stage: "verify", reason: "1 test failed", check: "retry backs off" } }));
    const { find, press, text } = await mount(fetch);
    expect(text()).toContain("Failed at verify. 1 test failed");
    await press("Close change…");
    expect([El.prototype.showModal.mock.calls.length, fetch.mock.calls.filter(([url]) => url.endsWith("/close"))]).toEqual([1, []]);
    const dialog = find((n) => n.nodeName === "DIALOG");
    expect(dialog.textContent).toContain("Its leases release, its agent stops working on it and nothing merges. This can't be undone");
    const reason = all(dialog).find((n) => n.attrs["aria-label"] === "Reason");
    await act(async () => {
      Object.assign(reason, { type: "text", value: "Superseded by c-1044" });
      for (let n = reason; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f({ type: "input", target: reason, bubbles: true, preventDefault() {}, stopPropagation() {} });
    });
    dialog.returnValue = "ok";
    await act(async () => { for (const f of dialog.listeners.close) f({ type: "close", target: dialog, bubbles: false, preventDefault() {}, stopPropagation() {} }); });
    const closes = fetch.mock.calls.filter(([url]) => url.endsWith("/close"));
    expect(closes.map(([, init]) => JSON.parse(init.body))).toEqual([{ reason: "Superseded by c-1044" }]);
    expect(text()).toContain("Closed changes can't reopen");
  });

  it("A closed change shows no Review, Take over, Queue or comment controls", async () => {
    const closed = { ...verified(), state: "closed", closed_by: "maya", closed_at: at, close_reason: "Superseded by c-1044",
      events: [...verified().events, event("closed", "failed", "closed", "Superseded by c-1044")] };
    const { find, named, box, text } = await mount(server(closed));
    const summary = find((n) => n.nodeName === "SUMMARY" && n.textContent === "Review");
    expect([summary, named("Take over"), named("Add to merge queue"), box("Comment"), named("Comment"), named("Close change"), named("Close change…")])
      .toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(text()).toMatch(/Closed by maya \d+\w ago · Superseded by c-1044\. Closed changes can't reopen\./);
    expect(text()).toContain("New change from intent");
    expect(text()).toContain("This change is closed. Comments and reviews are read-only.");
    expect(text()).toContain("closed → closed · Superseded by c-1044");
  });

  it("the header counts a failed change as open", async () => {
    const { text } = await mount(server({ ...verified(), state: "failed" }));
    expect(text()).toContain("1 of 1 open");
  });

  it("a failed change shows its failed step and reason", async () => {
    const { text } = await mount(server({ ...verified(), state: "failed", failure: { stage: "develop", reason: "claude: executable file not found" } }));
    expect(text()).toContain("Failed at developclaude: executable file not found");
  });

  it("navigating to a change with a pending loader renders the header and 3 timeline skeletons with aria-busy", async () => {
    const { router, find } = await mount(vi.fn(() => new Promise(() => {})), "/web/changes");
    await act(async () => router.navigate("/web/changes/c1"));
    await act(() => new Promise((r) => setTimeout(r, 150))); // the skeleton's show delay
    const busy = find((n) => n.attrs["aria-busy"] === "true");
    expect(busy).toBeTruthy();
    expect(all(busy).filter((n) => n.attrs.class === "cd-head")).toHaveLength(1);
    expect(all(busy).filter((n) => n.attrs.class === "tl-e")).toHaveLength(3);
  });

  it("Dummy data: client-only states render: loading skeletons, a load error and a dropped connection with Retry", async () => {
    const loading = await mount(vi.fn(() => new Promise(() => {})));
    await act(() => new Promise((r) => setTimeout(r, 150))); // the skeleton's show delay
    expect(loading.find((n) => n.attrs["aria-busy"] === "true")).toBeTruthy();
    const error = await mount(vi.fn(async () => new Response("", { status: 503 })));
    expect(error.text()).toBe("ChangesCouldn't load this change: /api/changes/c1: HTTP 503Retry");
    const dropped = await mount(vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(dropped.text()).toBe("ChangesCouldn't load this change: /api/changes/c1: Failed to fetchRetry");
  });

  it("skeleton counts match the spec: a title bone, 5 meta pills, an intent card plus 3 timeline rows, a rail of 4 readiness rows and a full-width button bone", async () => {
    const { find, text } = await mount(vi.fn(() => new Promise(() => {})));
    await act(() => new Promise((r) => setTimeout(r, 150))); // the skeleton's show delay
    const busy = find((n) => n.attrs["aria-busy"] === "true");
    const cls = (c) => all(busy).filter((n) => n.attrs.class === c);
    const bones = (n) => all(n).filter((x) => x.attrs.class === "bone");
    expect(bones(find((n) => n.nodeName === "H1"))).toHaveLength(1);
    expect(bones(cls("cd-head")[0].childNodes[2]).map((b) => b.style.borderRadius)).toEqual(Array(5).fill("6px"));
    expect(cls("cmt-card")).toHaveLength(1);
    expect(cls("tl-e")).toHaveLength(3);
    expect(all(cls("cd-rail")[0]).filter((n) => n.attrs.class === "rd")).toHaveLength(4);
    expect(bones(cls("card-b")[0]).map((b) => b.style.width)).toEqual(["100%"]);
    // Real: the status line, the back link, the tabs and the rail card's title.
    expect(text()).toBe("Loading changeChangesConversationFiles changedCommitsChecksMerge readiness");
  });

  it("after a successful Submit review, the review <details> is not open", async () => {
    const { find, pick, type, press, box } = await mount(server(verified()));
    const details = find((n) => n.nodeName === "DETAILS" && n.attrs.class === "rv");
    details.open = true; // the fake DOM doesn't toggle <details> on a summary click
    await type("Review comment", "Looks fine");
    await pick("Approve");
    await press("Submit review");
    expect(details.open).toBe(false);
    expect(box("Review comment").value).toBe("");
    expect(find((n) => n.nodeName === "INPUT" && n.value === "comment").checked).toBe(true);
  });

  it("Change detail renders no button without an accessible name", async () => {
    const { root } = await mount(server(verified()));
    const unnamed = all(root).filter((n) => n.nodeName === "BUTTON" && !n.textContent.trim() && !n.attrs["aria-label"]);
    expect(unnamed.map((n) => n.attrs.class)).toEqual([]);
  });

  it("the change header renders the short id and no 36-character UUID text", async () => {
    const { text } = await mount(server({ ...verified(), id: "5f20a6c9-1234-4abc-8def-0123456789ab" }), "/web/changes/5f20a6c9-1234-4abc-8def-0123456789ab");
    expect(text()).toContain("Declined cards retry forever 5f20a6c9");
    expect(text()).toContain("wants to merge5f20a6c9");
    expect(text()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("a change by developer@v8 shows developer@v8 on its change detail", async () => {
    const { find } = await mount(server({ ...verified(), agent_version: "developer@v8", head_branch: undefined }));
    expect(find((n) => n.attrs.class === "who" && n.parentNode.textContent.includes("wants to merge")).textContent).toBe("developer@v8");
  });

  it("The new change opens in change detail with its intent, author kind and driver correct", async () => {
    // Who in the header row ("… wants to merge"): an agent has the robot icon, a person an initial.
    const head = (find) => find((n) => n.attrs.class === "who" && n.parentNode.textContent.includes("wants to merge"));
    const described = { ...verified(), intent: "Strip hop-by-hop headers", agent_version: "patch@3.3.0", head_branch: undefined, review: undefined };
    const agent = await mount(server(described));
    expect(agent.text()).toContain("Intent — Strip hop-by-hop headers");
    expect(head(agent.find).textContent).toBe("patch@3.3.0");
    expect(head(agent.find).childNodes[0].nodeName.toLowerCase()).toBe("svg");
    expect(agent.text()).not.toContain("holds the lease");
    const human = await mount(server({ ...verified(), intent: "Fix retry\n\nwhy", driver: "maya", agent_pushes: false }));
    expect(human.text()).toContain("Intent — Fix retry");
    expect(head(human.find).childNodes[0].attrs.class).toBe("av");
    expect(human.text()).toContain("maya holds the lease on this change");
    expect(human.text()).toContain("held by maya");
  });

  it("the toggle reflects change.agent_pushes and saves immediately", async () => {
    const fetch = server({ ...verified(), driver: "maya", agent_pushes: false });
    const { named, text } = await mount(fetch);
    expect(text()).toContain("Only people push. Agent pushes are refused and logged.");
    expect(named("Agents may push").checked).toBe(false);
    named("Agents may push").checked = true;
    await act(async () => click(named("Agents may push")));
    expect(fetch).toHaveBeenCalledWith("/api/changes/c1", expect.objectContaining({ method: "PATCH", body: '{"agent_pushes":true}' }));
    expect(named("Agents may push").checked).toBe(true);
  });

  it("a refused push appears in the timeline within one tick, with the agent@version", async () => {
    const change = { ...verified(), driver: "maya", agent_pushes: false };
    const fetch = server(change);
    const { find, press, text } = await mount(fetch);
    expect(text()).not.toContain("push refused");
    change.events = [...change.events, { ...event("agent_push_refused", null, null), agent: "developer@v7", commits: 2, actor: { type: "system", id: "cinder" }, action: "change.push", result: "refused" }];
    await act(async () => sockets.forEach((s) => s.onmessage({ data: "{}" })));
    const row = find((n) => n.attrs?.class === "tl-e" && n.textContent.includes("push refused"));
    expect(row.textContent).toContain("developer@v7");
    expect(row.textContent).toContain("push refused: Agents may push is off · 2 commits not applied");
    await press("Allow agent pushes");
    expect(fetch).toHaveBeenCalledWith("/api/changes/c1", expect.objectContaining({ method: "PATCH", body: '{"agent_pushes":true}' }));
    expect(text()).not.toContain("Allow agent pushes");
  });

  it("the timeline names and links the agent, the judge and the runner instead of system or verifier", async () => {
    const ev = (kind, actor, action = "job.report") => ({ ...event(kind, null, null), id: `e-${kind}`, actor, action });
    const runner = "3ef49356-8474-4edf-bd7c-3b4e82c48f1c";
    const change = { ...verified(), events: [event("created", "draft", "planned"),
      ev("leased", { type: "system", id: "cinder" }, "change.lease"),
      ev("claimed", { type: "system", id: runner, runner, name: "build-1a2b3c4d", agent_version: "developer@v2" }, "job.claim"),
      ev("develop_done", { type: "system", id: runner, runner, name: "build-1a2b3c4d" }),
      ev("verify_done", { type: "verifier", id: "r2", runner: "r2", name: "toolchains-9f8e7d6c" }),
      ev("routed", { type: "system", id: "cinder" }, "stage.decide")] };
    const { find } = await mount(server(change));
    const row = (kind) => find((n) => n.attrs?.class === "tl-e" && n.textContent.includes(kind.replaceAll("_", " ")));
    const link = (kind) => all(row(kind)).find((n) => n.nodeName === "A");
    expect([link("develop_done").attrs.href, link("develop_done").textContent]).toEqual(["/automation/agents/developer/versions", "developer@v2"]);
    expect([link("verify_done").attrs.href, link("verify_done").textContent]).toEqual(["/automation/workers", "Vverifier · toolchains-9f8e7d6c"]);
    expect([link("leased").attrs.href, link("routed").attrs.href]).toEqual(["/automation/judges/lease", "/automation/judges/risk"]);
    for (const k of ["leased", "develop_done", "verify_done", "routed"]) expect(row(k).textContent).not.toMatch(/\b(system|verifier)\b(?! ·)/);
  });

  it("the copy action on the change header writes the full id to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { press } = await mount(server({ ...verified(), id: "5f20a6c9-1234-4abc-8def-0123456789ab" }), "/web/changes/5f20a6c9-1234-4abc-8def-0123456789ab");
    await press("Copy change id");
    expect(writeText).toHaveBeenCalledWith("5f20a6c9-1234-4abc-8def-0123456789ab");
  });

  // No layout engine runs here, so a block's box is what places it: its own markup and, for it and each ancestor, the
  // attributes the frame's CSS matches on (aria-busy re-lays .f-body>[aria-busy]) and how many siblings come before it.
  const box = (el) => {
    const path = [];
    for (let n = el; n; n = n.parentNode) path.push([n.nodeName, { ...n.attrs }, n.parentNode?.childNodes.indexOf(n)]);
    return JSON.stringify([path, el.textContent]);
  };
  const blocks = (find) => [find((n) => n.attrs.class === "cd-head"), find((n) => n.attrs.role === "tablist").parentNode,
    find((n) => n.attrs.class === "cd-main").childNodes[0].childNodes[0]].map(box);

  it("toggling Auto-queue leaves the bounding boxes of the change header, tabs and first content block identical", async () => {
    const fetch = server(verified());
    let save;
    const { find, named } = await mount(vi.fn((url, init) => init?.method === "PATCH" ? new Promise((r) => { save = () => r(new Response(null, { status: 204 })); }) : fetch(url, init)));
    const before = blocks(find);
    named("Auto-queue").checked = false;
    await act(async () => click(named("Auto-queue")));
    expect(blocks(find)).toEqual(before); // while the save is in flight
    expect(named("Auto-queue").checked).toBe(false);
    await act(async () => save());
    expect(blocks(find)).toEqual(before);
  });

  it("toggling Auto-queue doesn't re-run the page loader, only the toggle's action", async () => {
    const fetch = server(verified());
    const { named } = await mount(fetch);
    const loads = () => fetch.mock.calls.filter(([url, init]) => url === "/api/changes/c1" && !init?.method).length;
    const before = loads();
    named("Auto-queue").checked = false;
    await act(async () => click(named("Auto-queue")));
    expect(fetch).toHaveBeenCalledWith("/api/changes/c1/auto_queue", expect.objectContaining({ method: "PATCH" }));
    expect(loads()).toBe(before);
  });

  it("an approval of an older head doesn't count toward requested reviewers", async () => {
    const jon = { actor: { type: "human", id: "jon" }, head_sha: "0ld0000", at };
    const { root, text } = await mount(server({ ...verified(), review: { route: "auto", reason: "risk low", requested: [{ who: "jon", state: "pending" }, { who: "sam", state: "pending" }] },
      reviewers: [{ person: "jon" }, { person: "sam" }], approvals: [jon], head_sha: "9f2c1ab0000" }));
    const rows = all(root).filter((n) => n.attrs.class === "rd").map((n) => n.textContent);
    expect(rows).toContain("Waiting on jon, sam (requested)Auto-queue holds until requested reviewers approve the head");
    expect(text()).toContain("Not ready");
    expect(text()).toContain("Queues when requested reviewers approve");
    const some = await mount(server({ ...verified(), review: { route: "auto", reason: "risk low", requested: [{ who: "jon", state: "approved" }, { who: "sam", state: "pending" }] },
      reviewers: [{ person: "jon" }, { person: "sam" }], approvals: [{ ...jon, head_sha: "9f2c1ab0000" }], head_sha: "9f2c1ab0000" }));
    expect(some.text()).toContain("Waiting on sam (requested)jon approved 9f2c1ab · auto-queue waits for the rest");
    const all2 = await mount(server({ ...verified(), review: { route: "auto", reason: "risk low", requested: [{ who: "jon", state: "approved" }] },
      reviewers: [{ person: "jon" }], approvals: [{ ...jon, head_sha: "9f2c1ab0000" }], head_sha: "9f2c1ab0000" }));
    expect(all2.text()).toContain("Requested reviewers approvedjon approved 9f2c1ab");
    expect(all2.text()).toContain("Requested reviewers approved · queues when the rest is green");
    expect(all2.text()).not.toContain("Not ready");
  });

  it("the timeline names who removed a requested reviewer and who auto-queue now waits on", async () => {
    const removed = { ...event("reviewer_removed", null, null, "jon"), actor: { type: "human", id: "maya" }, action: "reviewer.remove", target: "sam" };
    const { text } = await mount(server({ ...verified(), review: { route: "auto", reason: "risk low", requested: [{ who: "jon", state: "pending" }] },
      reviewers: [{ person: "jon" }], events: [...verified().events, removed] }));
    expect(text()).toContain("removed sam from requested reviewers · auto-queue now waits on jon");
  });

  describe("repair rounds", () => {
    const started = (round) => ({ ...event("repair_started", null, null), id: `e-r${round}`, round, max: 3, check: "verify", actor: { type: "system", id: "cinder" } });
    const round = (n, result) => ({ round: n, check: "verify", did: result ? "pushed a fix" : null, result, reason: result === "fail" ? "1 test failed" : null, tokens: 1200 * n,
      at: `2026-10-06T10:0${n}:00.000Z` });
    const repairingChange = () => ({ ...verified(), review: undefined, state: "verifying", repair: { round: 2, max: 3, check: "verify" },
      events: [event("created", "draft", "planned"), started(1), started(2)] });

    it("There is one timeline event per round, in order. The current round shows a spinner.", async () => {
      const { root, text } = await mount(server(repairingChange(), { repairs: [round(1, "fail"), round(2, null)] }));
      await act(async () => {});
      const events = all(root).filter((n) => n.attrs.class === "tl-e" && n.textContent.includes("Repair round"));
      expect(events.map((n) => n.textContent.match(/Repair round \d of 3/)[0])).toEqual(["Repair round 1 of 3", "Repair round 2 of 3"]);
      expect(events[0].textContent).toContain("pushed a fix · verifier fail: 1 test failed · 1k tokens");
      const icon = (n) => n.childNodes[0];
      expect([icon(events[0]).attrs.class, icon(events[1]).attrs.class]).toEqual(["tl-i run-i fail", "tl-i run-i running"]);
      expect(icon(events[1]).childNodes[0].innerHTML).toContain("M8 2.5a5.5");
      expect(text()).toContain("Repairing");
      expect(text()).toContain("Verifier repairing · round 2 of 3");
      // The rounds replace their repair_started events.
      expect(text()).not.toContain("repair started");
    });

    it("When round == max and the verifier fails, the exhausted strip shows. Retry verify and Close behave as in UI-41.", async () => {
      const failed = () => ({ ...repairingChange(), state: "failed", repair: { round: 3, max: 3, check: "verify" }, failure: { stage: "verify", reason: "repairs exhausted (3 of 3)" } });
      let fetch = server(failed());
      let page = await mount(fetch);
      expect(page.text()).toContain("All 3 rounds used and verify still fails. It needs a person.");
      expect([page.named("Retry verify"), page.named("Take over"), page.named("Close…")].every(Boolean)).toBe(true);
      await page.press("Retry verify");
      expect(fetch).toHaveBeenCalledWith("/api/changes/c1/retry", expect.objectContaining({ method: "POST" }));
      expect([page.text().includes("It needs a person"), page.named("Retry verify")]).toEqual([false, undefined]);

      fetch = server(failed());
      page = await mount(fetch);
      vi.stubGlobal("confirm", () => false);
      await page.press("Close…");
      expect(fetch.mock.calls.filter(([url]) => url.endsWith("/close"))).toHaveLength(0);
      vi.stubGlobal("confirm", () => true);
      await page.press("Close…");
      expect(fetch.mock.calls.filter(([url]) => url.endsWith("/close"))).toHaveLength(1);
      expect(page.named("Close…")).toBeUndefined();
    });

    it("Rounds that are still loading or failed to load never hide the rest of the timeline.", async () => {
      const loading = await mount(server(repairingChange(), { repairs: () => new Promise(() => {}) }));
      expect(loading.text()).toContain("Repair roundsLoading repair rounds");
      expect(loading.text()).toContain("created → planned");
      const failed = await mount(server(repairingChange(), { repairs: () => new Response("", { status: 503 }) }));
      await act(async () => {});
      expect(failed.text()).toContain("Couldn't load repair rounds: /api/changes/c1/repairs: HTTP 503");
      expect(failed.text()).toContain("created → planned");
      expect(failed.text()).toContain("Verifier repairing · round 2 of 3");
    });
  });
});

describe("change detail reviewers", () => {
  // The picker's search field takes focus when it opens, and Esc hands it back to Request.
  beforeEach(() => { El.prototype.focus = function () { doc.activeElement = this; }; });
  afterEach(() => { delete El.prototype.focus; });
  // The change's Worker plus the picker's sources; POST /reviewers adds the reviewer as the real route does.
  const withPicker = (change, suggested) => {
    const worker = server(change);
    return vi.fn(async (url, init = {}) => {
      if (url === "/api/people") return Response.json([{ email: "maya@acme.dev", owner: false, role: null, created_at: at, last_seen: null }]);
      if (url.endsWith("/reviewers/suggested")) return Response.json(suggested);
      if (url === "/api/repos/web/judges") return Response.json({ airlock: false, trust: { min_outcomes: 200, min_races: 30 }, judges: [] });
      if (url === "/api/changes/c1/reviewers" && init.method === "POST") {
        change.reviewers = [...change.reviewers, JSON.parse(init.body)];
        return Response.json(change);
      }
      return worker(url, init);
    });
  };
  const group = (find, label) => find((n) => n.attrs.role === "group" && n.attrs["aria-label"] === label)?.textContent ?? "";

  it("Picking someone adds them as requested (pending) and the readiness row updates immediately", async () => {
    const fetch = withPicker(verified(), [{ owner: "maya@acme.dev", weight: 2, owns: 2, touched: 3 }]);
    const { find, press, text } = await mount(fetch);
    expect(text()).toContain("Awaiting human approvalrisk high");
    await press("Request");
    expect(group(find, "Suggested · owners of touched paths")).toBe("Suggested · owners of touched pathsMmaya@acme.devowns 2 · touched 3");
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Mmaya@acme.devowns 2 · touched 3")));
    expect(fetch).toHaveBeenCalledWith("/api/changes/c1/reviewers", expect.objectContaining({ method: "POST", body: '{"person":"maya@acme.dev"}' }));
    expect(text()).toContain("Mmaya@acme.devrequestedPending");
    expect(text()).toContain("Awaiting human approvalrisk highWaiting on maya@acme.dev (requested)");
    expect(find((n) => n.attrs.role === "dialog")).toBeUndefined();
  });

  it("Request reviewer lists judges and suggested reviewers when /api/people answers 403", async () => {
    const picker = withPicker(verified(), [{ owner: "maya@acme.dev", weight: 2, owns: 2, touched: 3 }]);
    const fetch = vi.fn(async (url, init) => {
      if (url === "/api/people") return Response.json({ error: { code: "forbidden", message: "no" } }, { status: 403 });
      if (url === "/api/repos/web/judges") return Response.json(judges);
      return picker(url, init);
    });
    const { find, press, text } = await mount(fetch);
    await press("Request");
    expect(text()).not.toContain("Couldn't load people and judges");
    expect(group(find, "Suggested · owners of touched paths")).toContain("maya@acme.dev");
    expect(group(find, "Judges")).toContain("risk@jev-1.6.2");
  });

  it("People already requested don't appear under Suggested", async () => {
    const fetch = withPicker(verified(), [{ owner: "reviewer@v3", weight: 5, owns: 3, touched: 3 }, { owner: "maya@acme.dev", weight: 2, owns: 2, touched: 3 }]);
    const { find, press } = await mount(fetch);
    await press("Request");
    const suggested = group(find, "Suggested · owners of touched paths");
    expect(suggested).toContain("maya@acme.dev");
    expect(suggested).not.toContain("reviewer@v3");
  });

  it("The picker is fully keyboard-operable. Esc closes it", async () => {
    const { find, named, text } = await mount(withPicker(verified(), []));
    const request = named("Request");
    await act(async () => click(request)); // Enter or Space on a focused button is the browser's click.
    const search = named("Person or judge");
    expect(doc.activeElement).toBe(search);
    await act(async () => {
      Object.assign(search, { type: "text", value: "zed" });
      for (let n = search; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f({ type: "input", target: search, bubbles: true, preventDefault() {}, stopPropagation() {} });
    });
    expect(text()).toContain("No person or judge matches “zed”. Invite people in Access & people.");
    await act(async () => { for (let n = search; n; n = n.parentNode) for (const f of n.listeners.keydown ?? []) f({ type: "keydown", key: "Escape", target: search, bubbles: true, preventDefault() {}, stopPropagation() {} }); });
    expect(find((n) => n.attrs.role === "dialog")).toBeUndefined();
    expect(doc.activeElement).toBe(request);
  });
});

describe("review popover approvers", () => {
  const locked = () => ({ ...verified(), can_approve: false, approvers: ["maya", "jon"] });
  const radio = (find, label) => find((n) => n.nodeName === "INPUT" && n.parentNode.textContent.startsWith(label));

  it("disabled state comes from can_resolve and the gate role: can_approve false disables Approve and Request changes, Comment stays", async () => {
    const { find } = await mount(server(locked()));
    expect(["Approve", "Request changes", "Comment"].map((l) => "disabled" in radio(find, l).attrs)).toEqual([true, true, false]);
    const open = await mount(server({ ...verified(), can_approve: true, approvers: ["maya"] }));
    expect(["Approve", "Request changes"].map((l) => "disabled" in radio(open.find, l).attrs)).toEqual([false, false]);
  });

  it("who can approve is listed by name in the Review popover", async () => {
    expect((await mount(server(locked()))).text()).toContain("Only approvers can approve or request changes: maya, jon. You can still comment.");
  });

  const open = (id, extra) => ({ id, path: null, side: null, line: null, head_sha: null, outdated: false, resolved: false, state_by: null, applied_sha: null, suggestion: null,
    comments: [{ actor: "bea", body: `Question ${id}`, at }], ...extra });

  it("threads in readiness: the unresolved count matches the open threads and is the threads_unresolved blocker", async () => {
    const change = { ...verified(), blockers: [{ code: "threads_unresolved", reason: "2 unresolved review thread(s)", since: null }] };
    const { text, press } = await mount(server(change, { seed: [open("t1"), open("t2", { path: "src/a.js", side: "new", line: 3 }), open("t3", { resolved: true, state_by: "bea" })] }));
    expect(text()).toContain("2 unresolved threads2 unresolved review thread(s)");
    expect(text()).toContain("On the change");
    expect(text()).toContain("src/a.js:3");
    await press("Resolve");
    expect(text()).toContain("1 unresolved thread");
  });

  it("apply suggestion posts to the thread's apply route and the block then reads Applied in the commit", async () => {
    const fetch = server(verified(), { seed: [open("t1", { path: "src/a.js", side: "new", line: 3, suggestion: { from: "a()", to: "b()" } })] });
    const { text, press } = await mount(fetch);
    expect(text()).toContain("− a()+ b()");
    await press("Apply suggestion");
    expect(fetch).toHaveBeenCalledWith("/api/changes/c1/threads/t1/apply", expect.objectContaining({ method: "POST" }));
    expect(text()).toContain("Resolved by owner · 1 comment");
    expect(text()).toContain("Applied in abc1234");
  });

  it("resolve and reopen toggle a thread without a reload, and a resolved thread starts collapsed", async () => {
    const { find, text, press } = await mount(server(verified(), { seed: [open("t1", { resolved: true, state_by: "bea" })] }));
    const row = () => find((n) => n.nodeName === "DETAILS" && n.textContent.startsWith("Resolved by bea · 1 comment"));
    expect([!!row(), row()?.attrs.open]).toEqual([true, undefined]);
    await press("Reopen");
    expect([!!row(), text().includes("1 unresolved thread")]).toEqual([false, true]);
    await press("Resolve");
    expect(find((n) => n.nodeName === "DETAILS" && n.textContent.startsWith("Resolved by owner · 1 comment"))).toBeDefined();
    expect(text()).toContain("All threads resolved");
  });
});
