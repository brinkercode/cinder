import { afterEach, expect, it, vi } from "vitest";
import { all, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Agents, agentsLoader } = await import("./automation-agents.jsx");

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

it("New agent is disabled until the agents list loads", async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  let answer;
  const pending = new Promise((r) => { answer = r; });
  const API = { "/api/agents": [], "/api/fleet": { canary_auto_promote: false, agents: [] }, "/api/races": [] };
  vi.stubGlobal("fetch", vi.fn(async (url) => { await pending; return Response.json(API[url]); }));
  const router = createMemoryRouter([{ path: "/automation/agents", element: <Agents />, loader: agentsLoader }], { initialEntries: ["/automation/agents"] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const head = () => all(root).find((n) => n.nodeName === "BUTTON" && n.textContent === "New agent");
  expect([head().attrs.disabled, head().attrs["aria-disabled"], head().attrs.title]).toEqual(["", "true", "Available once the agents list loads"]);
  await act(async () => answer());
  expect(["disabled" in head().attrs, "aria-disabled" in head().attrs]).toEqual([false, false]);
});
