import { afterEach, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, Outlet, RouterProvider } = await import("react-router");
const { routes } = await import("./routes.jsx");
// Pages load lazily: importing them here first lets a render resolve its route without waiting on a fresh import.
await import("./releases.jsx");

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

it("a search with no matches renders the empty-state text", async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  const repo = encodeURIComponent(repos[0].name);
  const tags = [{ name: "v1.0.0", sha: "a".repeat(40), message: "First", tagger: "owner", created_at: "2026-10-04T09:00:00Z" }];
  const answers = { "/api/repos": repos, [`/api/repos/${repo}`]: repos[0], [`/api/repos/${repo}/tags`]: tags, [`/api/repos/${repo}/releases`]: [], [`/api/repos/${repo}/environments`]: [] };
  vi.stubGlobal("fetch", async (url) => (answers[url] ? Response.json(answers[url]) : new Promise(() => {})));
  // The real repo and releases routes; the shell is left out.
  const repoRoute = routes[0].children.find((r) => r.id === "repo");
  const router = createMemoryRouter([{ ...routes[0], element: <Outlet />, children: [{ ...repoRoute, element: <Outlet /> }] }], { initialEntries: [`/${repo}/releases`] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const search = all(root).find((n) => n.attrs["aria-label"] === "Search tags and releases" && !("disabled" in n.attrs));
  expect(root.textContent).not.toContain("No tags or releases match");

  // The fake document has no oninput, so call the input's onChange prop, as React would.
  await act(async () => { search.value = "zzzz"; search[Object.keys(search).find((k) => k.startsWith("__reactProps$"))].onChange({ target: search }); });
  expect(root.textContent).toContain("No tags or releases match");
});
