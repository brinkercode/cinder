import { expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Repos, reposLoader } = await import("./repos.jsx");

it("rendering a page with live updates in tests logs no location ReferenceError", async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  // The live ticket answers, so the page goes on to open its socket; every other request answers an empty object.
  vi.stubGlobal("fetch", async (path) => Response.json(path === "/api/live-ticket" ? { ticket: "t1" } : {}));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const router = createMemoryRouter([{ path: "/", id: "root", loader: () => ({ repos: Promise.resolve(repos.slice(0, 1)) }), children: [
    { index: true, element: <Repos />, loader: reposLoader }] }]);
  const root = doc.body.appendChild(new El("div"));
  await act(async () => { createRoot(root).render(<RouterProvider router={router} />); await new Promise((r) => setTimeout(r, 50)); });
  expect(error.mock.calls.flat().filter((e) => e instanceof ReferenceError)).toEqual([]);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  error.mockRestore();
});
