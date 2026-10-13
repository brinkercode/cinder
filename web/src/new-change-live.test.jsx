import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const createChange = vi.fn(async () => null);
vi.mock("./client.js", async (orig) => ({ ...(await orig()), createChange: (...args) => createChange(...args) }));

// React probes `"oninput" in document` at import; without it, typing goes through an old-IE polyfill the fake DOM can't drive.
doc.oninput = null;
// A named radio group makes React look up its siblings after a change; this page's radios are all controlled, so none need restoring.
doc.querySelectorAll = () => [];
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { routes } = await import("./routes.jsx");
// Pages load lazily: importing them here first lets a render resolve its route without waiting on a fresh import.
await import("./new-change.jsx");
await import("./changes.jsx");
await import("./change.jsx");

// React's change plugin reads the new value off the target of a bubbling input (text) or change (select) event.
const fire = (el, type, value) => {
  // The fake DOM has no default `type`; React treats only typed inputs as text inputs.
  Object.assign(el, { value, selectionStart: value.length, type: el.attrs.type ?? "text" });
  const e = { type, target: el, bubbles: true, preventDefault() {}, stopPropagation() {} };
  for (let n = el; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f(e);
};

async function open(url = "/acme%2Fweb/changes/new") {
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await act(async () => new Promise((r) => setTimeout(r)));
  const find = (pred) => all(root).find(pred);
  return { router, root, find, label: (l) => find((n) => n.attrs["aria-label"] === l), select: (meta) => find((n) => n.nodeName === "SELECT" && n.parentNode.textContent.startsWith(meta)),
    button: (text) => find((n) => n.nodeName === "BUTTON" && n.textContent === text) };
}
// React reads a radio or checkbox change off the click once `checked` has flipped.
const check = (el, checked = true) => { el.checked = checked; click(el); };
const mode = (find, name) => find((n) => n.type === "radio" && n.parentNode.textContent.includes(name));
// I wrote it on release/2.5 with a title and the first reviewer picked: Open change is enabled.
async function wrote() {
  const page = await open("/acme%2Fweb/changes/new?target=develop&head=release%2F2.5");
  await act(async () => fire(page.label("Title"), "input", "Ship the 2.5 release candidate"));
  await act(async () => click(page.button("patch@3.2.1")));
  return page;
}

// Not unstubbed after each test: that would also drop fake-dom's document and window.
vi.stubGlobal("fetch", () => { throw new Error("fixture mode must not fetch"); });
vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
beforeEach(() => vi.stubEnv("VITE_FIXTURES", "1"));
afterEach(() => { vi.unstubAllEnvs(); createChange.mockClear(); });

describe("new change (interactive)", () => {
  it("typing an intent shows predictions and similar changes", async () => {
    const { find, label } = await open();
    await act(async () => fire(label("Intent"), "input", "Normalize header iteration order"));
    const rail = find((n) => n.nodeName === "ASIDE" && n.attrs.class === "rail").textContent;
    expect(rail).toContain("Predicted leasesfn normalize_headerstype HeaderMap");
    expect(rail).toContain("Collisions with active changesc-1042fn normalize_headers");
    expect(rail).toMatch(/Risk\d+%Jevreverted or breaks develop within 7 daystrusted/);
    expect(rail).toContain("c-1039mergedNormalize header map iteration order");
    expect(rail).toContain("c-1042conflictPreserve case of X-Forwarded-* headers during normalization");
    expect(rail).toContain("Suggested filessrc/headers/normalize.rssrc/headers/map.rs");
    expect(rail).toMatch(/Suggested owners.*patch@3\.2\.1/);
  });

  it("launching creates a change with the chosen agent, target, labels and acceptance", async () => {
    const { find, label, select } = await open();
    await act(async () => fire(label("Intent"), "input", "Strip hop-by-hop headers #c-1042"));
    await act(async () => fire(select("target"), "change", "main"));
    await act(async () => fire(select("agent"), "change", "patch@3.3.0"));
    await act(async () => fire(select("priority"), "change", "P1"));
    await act(async () => fire(label("Labels"), "input", "headers, proxy"));
    await act(async () => fire(label("Acceptance criteria"), "input", "Drops Connection headers\n\nKeeps Host"));
    await act(async () => fire(label("Links"), "input", "wiki/caching"));
    await act(async () => click(find((n) => n.nodeName === "BUTTON" && n.textContent === "Hand to agent")));
    expect(createChange).toHaveBeenCalledWith("acme/web", {
      intent: "Strip hop-by-hop headers", target_branch: "main", agent_version: "patch@3.3.0", priority: "P1", labels: ["headers", "proxy"],
      acceptance: [{ path: "criteria-1.md", content: "Drops Connection headers" }, { path: "criteria-2.md", content: "Keeps Host" }],
      links: ["c-1042", "wiki/caching"], draft: false,
    });

    // Launch left the page; a fresh one saves the same intent as a draft instead.
    const again = await open();
    await act(async () => fire(again.label("Intent"), "input", "Strip hop-by-hop headers"));
    await act(async () => click(again.find((n) => n.nodeName === "BUTTON" && n.textContent === "Save draft")));
    expect(createChange).toHaveBeenLastCalledWith("acme/web", expect.objectContaining({ draft: true }));
  });

  it("a human-authored change sends agent_pushes = false unless the box is checked", async () => {
    const { button, find } = await wrote();
    expect(find((n) => n.attrs["aria-pressed"] === "true").textContent).toBe("patch@3.2.1");
    await act(async () => click(button("Open change")));
    expect(createChange).toHaveBeenCalledWith("acme/web", { intent: "Ship the 2.5 release candidate", target_branch: "develop", head_branch: "release/2.5", draft: false, agent_pushes: false });
    const again = await wrote();
    await act(async () => check(again.find((n) => n.type === "checkbox" && n.parentNode.textContent.includes("Let agents push to it"))));
    await act(async () => click(again.button("Open as draft")));
    expect(createChange).toHaveBeenLastCalledWith("acme/web", expect.objectContaining({ draft: true, agent_pushes: true }));
  });

  it("Open change stays disabled until there's a head branch, a title and a reviewer, and says what's missing", async () => {
    const { button, label } = await open("/acme%2Fweb/changes/new?target=develop&head=");
    expect(button("Open change").attrs).toMatchObject({ disabled: "", title: "Pick a head branch" });
    expect(label("Title").value).toBe("");
    const picked = await open("/acme%2Fweb/changes/new?target=develop&head=release%2F2.5");
    expect(picked.label("Title").value).toBe("2.5");
    expect(picked.button("Open change").attrs.title).toBe("Pick a reviewer");
  });

  it("changing mode keeps what was typed in each mode", async () => {
    const { find, label } = await open();
    await act(async () => fire(label("Intent"), "input", "Strip hop-by-hop headers"));
    await act(async () => check(mode(find, "I wrote it")));
    expect(label("Intent")).toBeUndefined();
    await act(async () => fire(label("Description"), "input", "Drops Connection"));
    await act(async () => check(mode(find, "Describe it")));
    // A remounted field gets its text as defaultValue; the fake DOM has no value to mirror it into.
    expect(label("Intent").defaultValue).toBe("Strip hop-by-hop headers");
    await act(async () => check(mode(find, "I wrote it")));
    expect(label("Description").defaultValue).toBe("Drops Connection");
  });

  it("a described change has no head branch and shows on the board as agent-authored", async () => {
    const { button, find, label } = await open("/acme%2Fweb/changes/new?target=develop&head=release%2F2.5");
    await act(async () => check(mode(find, "Describe it")));
    await act(async () => fire(label("Intent"), "input", "Strip hop-by-hop headers"));
    await act(async () => click(button("Hand to agent")));
    const [, body] = createChange.mock.calls[0];
    expect(body).not.toHaveProperty("head_branch");
    // The board lists a change with an agent_version under that agent, not as a person's (changes.js #save).
    expect(body.agent_version).toBe("patch@3.2.1");
  });

  it("after submitting, Describe goes to the board and I wrote it to the new change's page, with a toast", async () => {
    const described = await open();
    await act(async () => fire(described.label("Intent"), "input", "Strip hop-by-hop headers"));
    await act(async () => click(described.button("Hand to agent")));
    expect(described.router.state.location.pathname).toBe("/acme%2Fweb/changes");
    expect(described.find((n) => n.attrs.class === "toast").textContent).toBe("1 change handed to patch@3.2.1");

    createChange.mockResolvedValueOnce({ id: "c-1042" });
    const mine = await wrote();
    await act(async () => click(mine.button("Open change")));
    await act(async () => new Promise((r) => setTimeout(r)));
    expect(mine.router.state.location.pathname).toBe("/acme%2Fweb/changes/c-1042");
    expect(mine.find((n) => n.attrs.class === "toast").textContent).toBe("Opened c-1042 · you drive");
  });

  it("the target branch shows in both forms and follows the top bar's switcher", async () => {
    const { router, find, label, root } = await open("/acme%2Fweb/changes/new?target=main");
    await act(async () => fire(label("Intent"), "input", "Strip hop-by-hop headers"));
    expect(label("Target branch")).toBeDefined();
    expect(root.textContent).toContain("1 change on main");
    await act(async () => check(mode(find, "I wrote it")));
    expect(label("Target branch")).toBeDefined();
    expect(root.textContent).toContain("or push to refs/for/main");
    // The top bar's branch switcher sets ?target=.
    await act(async () => router.navigate("/acme%2Fweb/changes/new?target=develop"));
    await act(async () => new Promise((r) => setTimeout(r)));
    expect(root.textContent).toContain("Through the merge queue into develop");
    await act(async () => check(mode(find, "Describe it")));
    expect(root.textContent).toContain("1 change on develop");
  });

  it("clicking Save draft twice quickly posts once", async () => {
    const { find, label } = await open();
    await act(async () => fire(label("Intent"), "input", "Strip hop-by-hop headers"));
    const save = find((n) => n.nodeName === "BUTTON" && n.textContent === "Save draft");
    await act(async () => { click(save); click(save); });
    expect(createChange).toHaveBeenCalledTimes(1);
  });

  it("Open change shows a busy, disabled state while the request is pending", async () => {
    let settle;
    createChange.mockImplementationOnce(() => new Promise((r) => { settle = r; }));
    const { button } = await wrote();
    await act(async () => click(button("Open change")));
    expect(button("Open change").attrs).toMatchObject({ disabled: "", "aria-busy": "true" });
    await act(async () => settle(null));
  });

  it("every select on New change has an accessible name", async () => {
    const { root } = await open();
    const names = all(root).filter((n) => n.nodeName === "SELECT").map((n) => n.attrs["aria-label"]);
    expect(names).toEqual(["Target branch", "Agent", "Priority"]);
  });
});
