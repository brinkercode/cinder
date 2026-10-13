import { afterEach, describe, expect, it, vi } from "vitest";
import repos from "../../worker/src/api/fixtures/repos.json";
import { all, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { routes } = await import("./routes.jsx");
// Pages load lazily: importing them here first lets a render resolve its route without waiting on a fresh import.
await import("./needs.jsx");

// Every /api request stays pending unless answer(url) gives a Response.
const mount = async (path, answer = () => undefined) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(async (url) => answer(url) ?? new Promise(() => {})));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return { root, router };
};
const skeleton = (root) => {
  const busy = all(root).find((n) => n.attrs["aria-busy"] === "true");
  return { status: busy?.childNodes[0].textContent, cards: all(busy ?? root).filter((n) => n.attrs.class === "card skel-card").length };
};

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("needs you loading", () => {
  // First: react-router warns about a missing HydrateFallback once per module.
  it("a direct load of /needs with pending loaders logs no console warning", async () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    await mount("/needs");
    expect([...warn.mock.calls, ...error.mock.calls]).toEqual([]);
    warn.mockRestore();
    error.mockRestore();
  });

  it("a direct load of /needs with pending loaders shows the sidebar and the Needs you skeleton", async () => {
    const { root } = await mount("/needs");
    expect(all(root).some((n) => n.nodeName === "ASIDE")).toBe(true);
    expect(all(root).find((n) => n.nodeName === "MAIN").textContent).toContain("Needs you");
    expect(skeleton(root)).toEqual({ status: "Loading Needs you", cards: 3 });
  });

  it("navigating to /needs from another route with a pending loader shows the Needs you skeleton", async () => {
    const { root, router } = await mount("/wiki", (url) => (url === "/api/repos" ? Response.json(repos) : undefined));
    expect(skeleton(root).status).toBeUndefined();
    await act(async () => { router.navigate("/needs"); }); // not awaited: a held navigation never settles
    expect(router.state.location.pathname).toBe("/needs");
    expect(skeleton(root)).toEqual({ status: "Loading Needs you", cards: 3 });
  });
});
