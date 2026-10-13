import { expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Repos, reposLoader } = await import("./repos.jsx");

it("an overview failure renders the Repositories title and a Retry card", async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (path) => (path === "/api/overview" ? Response.json({ error: { code: "unavailable", message: "index unavailable" } }, { status: 503 }) : Response.json(path === "/api/repos" ? repos : [])));
  const unhandled = [];
  const track = (e) => unhandled.push(e);
  process.on("unhandledRejection", track);
  const router = createMemoryRouter([{ id: "root", loader: () => ({ repos: new Promise((r) => setTimeout(() => r(repos), 50)) }), children: [{ path: "/", element: <Repos />, loader: reposLoader }] }]);
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await act(() => new Promise((r) => setTimeout(r, 100)));
  process.off("unhandledRejection", track);
  expect(root.textContent).toContain("Repositories");
  expect(root.textContent).toContain("Couldn't load repositories");
  expect(root.textContent).toContain("Retry");
  expect(unhandled).toEqual([]);
});
