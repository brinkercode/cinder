import { afterEach, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, click, doc, El } from "./fake-dom.js";

doc.oninput = null; // react-dom checks "oninput" in document once, at import; without it a text input's onChange never fires
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Releases, releasesAction, releasesLoader } = await import("./releases.jsx");
// React looks up a radio group's other members on change; one radio group here, so none.
Object.assign(El.prototype, { showModal() { this.attrs.open = ""; }, close() {}, querySelectorAll: () => [] });

const repo = repos[0];
const base = `/api/repos/${encodeURIComponent(repo.name)}`;
const TAGGED = "3a8b2d7".padEnd(40, "0");
const FAILED = "9f2c1e4".padEnd(40, "1");
const api = {
  [`${base}/tags`]: [{ name: "v2.14.0", sha: TAGGED, message: "v2.14.0", tagger: "owner", created_at: "2026-10-04T09:00:00Z" }],
  [`${base}/releases`]: [],
  [`${base}/branches`]: [{ name: repo.default_branch, kind: "branch", default: true, head_sha: FAILED, ahead: 0, behind: 0, last_commit: null, role: "integration", open_changes: 0 }],
  [`${base}/log?ref=${encodeURIComponent(repo.default_branch)}&page=1`]: { ref: repo.default_branch, sha: FAILED, path: "", more: false, total: 1,
    commits: [{ sha: FAILED, message: "Retry declined payments", author: "owner", date: "2026-10-07T09:00:00Z" }] },
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const fire = (el, type) => { for (let n = el; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f({ type, target: el, bubbles: true, preventDefault() {}, stopPropagation() {} }); };
const type = async (el, value) => { await act(async () => { el.type = el.attrs.type ?? "text"; el.value = value; fire(el, "input"); }); await settle(); };
async function openDialog() {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("fetch", async (url) => (api[url] ? Response.json(api[url]) : new Promise(() => {})));
  const router = createMemoryRouter([{ path: "/:repo", id: "repo", loader: () => repo,
    children: [{ path: "releases", element: <Releases />, loader: releasesLoader, action: releasesAction }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/releases`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await settle();
  await act(async () => click(all(root).find((n) => n.nodeName === "BUTTON" && n.textContent === "New tag")));
  await settle();
  const dialog = all(root).find((n) => n.nodeName === "DIALOG");
  return { dialog, create: all(dialog).find((n) => n.nodeName === "BUTTON" && n.textContent === "Create tag"), tag: all(dialog).find((n) => n.attrs.placeholder === "v1.2.0") };
}

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

it("a collision is detected while you type", async () => {
  const { dialog, create, tag } = await openDialog();
  expect(dialog.textContent).toContain("Latest is v2.14.0");
  await act(async () => click(all(dialog).find((n) => n.nodeName === "INPUT" && n.value === FAILED)));
  await type(tag, "v2.14.0");
  expect(dialog.textContent).toContain("v2.14.0 already exists, at 3a8b2d7. Tags can't move");
  expect("disabled" in create.attrs).toBe(true);
  await type(tag, "v2.15.0");
  expect(dialog.textContent).not.toContain("already exists");
  expect("disabled" in create.attrs).toBe(false);
});

it("a picked recent commit can be tagged", async () => {
  const { dialog, create, tag } = await openDialog();
  const row = all(dialog).find((n) => n.attrs.class === "tag-commit");
  expect(row.textContent).toContain("9f2c1e4Retry declined payments");
  await type(tag, "v2.15.0");
  await act(async () => click(all(row).find((n) => n.nodeName === "INPUT")));
  await settle();
  expect("disabled" in create.attrs).toBe(false);
});
