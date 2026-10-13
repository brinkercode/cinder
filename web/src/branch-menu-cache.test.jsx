import { expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, doc, El } from "./fake-dom.js";

const BRANCHES = [{ name: "main", kind: "branch", role: "integration", ahead: 0, behind: 0 }, { name: "feature/login", kind: "branch", role: "other", ahead: 2, behind: 1 },
  { name: "v1.0.0", kind: "tag", role: "other", ahead: 0, behind: 0, head_sha: "aaaaaaa1" }];
const answer = vi.hoisted(() => ({ next: null }));
vi.mock("./client.js", async (real) => ({ ...(await real()), branchesFor: () => answer.next }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Shell } = await import("./shell.jsx");

it("opening the branch menu a second time renders the cached list with no blocking request", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  answer.next = Promise.resolve(BRANCHES);
  const repo = repos[0];
  const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
    children: [{ path: ":repo", id: "repo", loader: () => repo, children: [{ path: "changes" }] }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/changes`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const menu = all(root).find((n) => n.attrs.id === "branch-menu");
  const toggle = (newState) => act(async () => { for (const f of menu.listeners.toggle ?? []) f({ type: "toggle", target: menu, newState, bubbles: false, preventDefault() {}, stopPropagation() {} }); });
  await toggle("open");
  await toggle("closed");
  // The second open's request never answers: the last list still draws.
  answer.next = new Promise(() => {});
  await toggle("open");
  const rows = all(menu).filter((n) => n.nodeName === "A").map((n) => n.textContent);
  for (const b of BRANCHES) expect(rows.some((r) => r.startsWith(b.name)), b.name).toBe(true);
  expect(all(menu).find((n) => n.attrs.role === "status")).toBeUndefined();
});
