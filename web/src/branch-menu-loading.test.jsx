import { expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, doc, El } from "./fake-dom.js";

vi.mock("./client.js", async (real) => ({ ...(await real()), branchesFor: () => new Promise(() => {}) }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Shell } = await import("./shell.jsx");

it("the branch menu shows a loading state for Branches and Tags while refs are pending", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  const repo = repos[0];
  const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos, needs: Promise.resolve([]) }),
    children: [{ path: ":repo", id: "repo", loader: () => repo, children: [{ path: "changes" }] }] }], { initialEntries: [`/${encodeURIComponent(repo.name)}/changes`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const menu = all(root).find((n) => n.attrs.id === "branch-menu");
  await act(async () => { for (const f of menu.listeners.toggle ?? []) f({ type: "toggle", target: menu, newState: "open", bubbles: false, preventDefault() {}, stopPropagation() {} }); });
  const status = all(menu).find((n) => n.attrs.role === "status");
  expect(status?.textContent).toBe("Loading branches and tags…");
});
