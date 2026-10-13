import { expect, it, vi } from "vitest";
import { all, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { needsList, resolveNeed } = await import("./client.js");
const { Shell } = await import("./shell.jsx");

it("a needs change event updates the sidebar count", async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  const need = (id) => ({ id, kind: "Judges disagree", repo: "edge-router", change: null, text: id, actions: ["Dismiss"] });
  let open = [need("n1"), need("n2")];
  vi.stubGlobal("fetch", async (path, init) => {
    if (init?.method === "POST") { open = open.filter((n) => !path.includes(n.id)); return Response.json(null); }
    return Response.json(path === "/api/needs" ? open : []);
  });
  const router = createMemoryRouter([{ path: "/", element: <Shell />, loader: () => ({ repos: [], needs: needsList() }), children: [{ path: "*" }] }]);
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const count = () => all(root).find((n) => n.nodeName === "A" && n.attrs.href === "/needs" && n.textContent.startsWith("Needs you"))
    .childNodes.find((c) => c.attrs?.class === "count")?.textContent;
  expect(count()).toBe("2");
  // Another tab resolves n1: its client announces the change, and this shell refetches.
  await act(async () => { await resolveNeed("n1", "Dismiss"); await new Promise((r) => setTimeout(r, 50)); });
  expect(count()).toBe("1");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
