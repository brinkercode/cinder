import { afterEach, expect, it, vi } from "vitest";
import { all, click, doc, El } from "../src/fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Marketplace, marketplaceLoader } = await import("../src/marketplace.jsx");

Object.assign(El.prototype, { showModal() { this.attrs.open = ""; }, close() {} });
afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

const ENTRY = { name: "sec-review", source: "published", description: "Reviews changes for leaked secrets", publisher: "labs", harness: "claude-code", model: "claude-opus-5-5",
  tools: ["read"], egress: ["pkg.go.dev"], versions: [1, 2], wins: 2, races: 3, installs: 7, tokens_per_merge: 21000, visibility: "instance", mine: false };

it("Install shows installing, then installed, on the card", async () => {
  let finish;
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  // The fake DOM has no form state; the install dialog reads these values.
  vi.stubGlobal("FormData", function () { return [["name", "sec-review-acme"], ["account_id", "a1"], ["version", "2"], ["channel", "canary"]]; });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/agents/sec-review-acme/install") return new Promise((res) => { finish = () => res(Response.json({ id: "j1" }, { status: 202 })); });
    if (url === "/api/marketplace") return Response.json([ENTRY]);
    if (url === "/api/accounts") return Response.json([{ id: "a1", name: "Acme", slug: "acme", can_install: true }]);
    return Response.json([]);
  }));
  const router = createMemoryRouter([{ path: "/automation/marketplace", element: <Marketplace />, loader: marketplaceLoader }], { initialEntries: ["/automation/marketplace"] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  const card = () => all(root).find((n) => n.attrs.class === "lc-m").childNodes.at(-1);
  expect(card().textContent).toBe("Install");

  await act(async () => click(card()));
  const dialog = all(root).find((n) => n.nodeName === "DIALOG");
  await act(async () => { dialog.returnValue = "ok"; for (const f of dialog.listeners.close) f({ type: "close", currentTarget: dialog, target: dialog }); });
  expect(card().textContent).toBe("Installing…");
  expect(card().attrs["aria-busy"]).toBe("true");
  expect("disabled" in card().attrs || card().disabled).toBe(true);

  await act(async () => finish());
  await act(async () => {});
  expect(card().textContent).toBe("Installed");
  expect(card().attrs.class).toBe("btn btn-sm btn-secondary");
});
