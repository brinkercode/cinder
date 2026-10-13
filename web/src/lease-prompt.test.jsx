import { afterEach, describe, expect, it, vi } from "vitest";
import changes from "../../worker/src/api/fixtures/changes.json";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

// Monaco can't run on the fake DOM; a textarea stands in and reports typing as Monaco's onChange does.
vi.mock("./monaco.jsx", () => ({
  default: ({ value, onChange }) => <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />,
  colorize: () => Promise.reject(new Error("no monaco in tests")),
}));
doc.oninput = null;
El.prototype.querySelectorAll = () => []; // React restores a clicked radio's group through it
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Code, codeAction, codeLoader, codeRevalidate } = await import("./code.jsx");
const { LeasePrompt } = await import("./lease-prompt.jsx");
const { leaseHits } = await import("./lib/lease-hits.js");
const { forgetTrees } = await import("./client.js");

const repo = repos[0];
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const FILE = "l1\nl2\nl3\nl4";
// c_01 holds `run` (lines 2-3) of app.js.
const API = {
  "/api/repos": repos,
  [`${base}/tree?ref=main&path=&recursive=1`]: { ref: "main", sha: "m1", path: "", entries: [{ name: "app.js", path: "app.js", type: "blob" }] },
  [`${base}/file?ref=main&path=app.js`]: { ref: "main", sha: "m1", path: "app.js", size: 11, content: FILE },
  [`${base}/symbols?target=main`]: { sha: "m1", symbols: [{ path: "app.js", name: "run", kind: "function", start: 2, end: 3 }] },
  [`${base}/changes`]: [{ ...changes[0], id: "c_01", state: "draft", intent: "Run faster" }],
  [`${base}/lease-map`]: { conflicts: { merges: 0, conflicted: 0, days: 7 }, edges: [{ a: "c_01", b: "c_02", p: 0.42, judge: { name: "lease", count: 3, trusted: false } }],
    changes: [{ id: "c_01", state: "draft", intent: "Run faster", seam: false, stacked_on: null }, { id: "c_02", state: "draft", intent: "Other", seam: false, stacked_on: null }],
    leases: [{ symbol: "app.js#run", file: "app.js", holder: "c_01", expires_at: "2099-01-01T00:30:00.000Z", mode: "exclusive", waiting: [] }] },
  [`${base}/log?ref=main&page=1`]: { ref: "main", sha: "m1", path: "", commits: [], more: false, total: 0 },
};
const posts = [];
const live = (answer = {}) => {
  posts.length = 0;
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    if (init?.method !== "POST") return Response.json(answer[url] ?? API[url] ?? []);
    if (url !== "/api/live-ticket") posts.push([url, JSON.parse(init.body ?? "null")]);
    return Response.json(answer[url] ?? { id: "c-9", fork: "f", target_branch: "main" }, { status: 201 });
  });
};
// The Code page editing app.js with an edit to `line` (1-based) typed in, then submitted.
async function submitted(line) {
  live();
  const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo, children: [
    { path: "code/:ref/*", element: <Code />, loader: codeLoader, action: codeAction, shouldRevalidate: codeRevalidate }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/code/main/app.js?v=edit`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  for (let i = 0; i < 3; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  const find = (pred) => all(root).find(pred);
  const type = (value, label) => {
    const el = find((n) => n.attrs["aria-label"] === label);
    Object.assign(el, { value, type: el.nodeName === "INPUT" ? "text" : "textarea" });
    const e = { type: "input", target: el, bubbles: true, preventDefault() {}, stopPropagation() {} };
    for (let n = el; n; n = n.parentNode) for (const f of n.listeners.input ?? []) f(e);
  };
  await act(async () => type(FILE.replace(`l${line}`, "changed"), "editor"));
  await act(async () => type("Faster", "Change message"));
  const form = find((n) => n.nodeName === "FORM" && all(n).some((m) => m.attrs["aria-label"] === "Change message"));
  const e = { type: "submit", target: form, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  await act(async () => { for (let n = form; n; n = n.parentNode) for (const f of n.listeners.submit ?? []) f(e); });
  return { root, find, router };
}
const prompt = (root) => all(root).find((n) => n.attrs["aria-label"] === "Lease held");

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); forgetTrees(); });

describe("lease prompt", () => {
  it("only appears when the diff intersects a lease held by another change", async () => {
    // Lines 1 and 4 are outside `run` (2-3); an insertion at its end, or an edit inside it, touches it.
    const lease = (name) => (name === "run" ? { symbol: "run", holder: "c_01" } : null);
    const syms = [{ name: "run", from: 2, to: 3 }];
    expect(leaseHits(["l1", "l2", "l3", "l4"], ["changed", "l2", "l3", "l4"], syms, lease)).toEqual([]);
    expect(leaseHits(["l1", "l2", "l3", "l4"], ["l1", "l2", "l3", "changed"], syms, lease)).toEqual([]);
    expect(leaseHits(["l1", "l2", "l3", "l4"], ["l1", "l2", "changed", "l4"], syms, lease)).toMatchObject([{ holder: "c_01", from: 2, to: 3 }]);
    expect(leaseHits(["l1", "l2"], ["l1", "l2"], syms, () => null)).toEqual([]);

    const { root } = await submitted(2);
    const text = prompt(root).textContent;
    expect(text).toContain("run");
    expect(text).toContain("lines 2–3");
    expect(text).toContain("c_01");
    expect(text).toContain("Run faster");
    expect(text).toMatch(/lease expires/);
    expect(text).toContain("p(collision) 42% · untrusted: 3 outcomes");
    expect(posts).toEqual([]);
  });

  it("each choice opens the change in the matching mode", async () => {
    for (const [pick, expected] of [["Stack on", "stack"], ["Run in parallel", "parallel"]]) {
      const { root, find } = await submitted(2);
      const radio = all(root).filter((n) => n.nodeName === "LABEL" && n.textContent.startsWith(pick))[0].childNodes[0];
      await act(async () => click(radio));
      await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Continue")));
      await act(() => new Promise((r) => setTimeout(r, 0)));
      expect(posts.at(-1)).toEqual([`${base}/changes/edit`, { target: "main", path: "app.js", base_sha: "m1", content: FILE.replace("l2", "changed"), intent: "Faster", choice: expected }]);
    }
    // Send asks the holder to hand over; the change opens once it has.
    const { root, find } = await submitted(2);
    await act(async () => click(all(root).filter((n) => n.nodeName === "LABEL" && n.textContent.startsWith("Send to"))[0].childNodes[0]));
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Continue")));
    expect(posts.at(-1)).toEqual(["/api/leases/c_01/handover-request", { symbol: "app.js#run", intent: "Faster" }]);
  });

  it("sending times out to Stack at lease expiry", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const expires_at = new Date(Date.now() + 60_000).toISOString();
    const handover = { id: "h1", holder: "c_01", requester: "ana", symbol: "app.js#run", status: "requested", reason: null, expires_at, created_at: new Date().toISOString() };
    live({ "/api/leases/c_01/handover-request": handover, "/api/leases/c_01/handover-request/h1": handover });
    const onGo = vi.fn();
    const root = doc.body.appendChild(new El("div"));
    const lease = { symbol: "run", file: "app.js", from: 2, to: 3, holder: "c_01", expires_at, collision: null };
    await act(async () => createRoot(root).render(<LeasePrompt lease={lease} holder="c_01" intent="Faster" onGo={onGo} onKeep={() => {}} />));
    const press = (label) => click(all(root).find((n) => n.nodeName === "BUTTON" && n.textContent === label));
    await act(async () => click(all(root).filter((n) => n.nodeName === "LABEL" && n.textContent.startsWith("Send to"))[0].childNodes[0]));
    await act(async () => press("Continue"));
    expect(root.textContent).toContain("Waiting for");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(onGo).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(onGo).toHaveBeenCalledExactlyOnceWith("stack");
  });
});
