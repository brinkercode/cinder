import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Models, modelsLoader } = await import("./models.jsx");

const ACCESS = { source: "credits", account: null, org_keys: [], usage: { tokens: 0, cost_usd: 0, runs: 0 }, providers: [
  { id: "cf", name: "Cloudflare credits", source: "credits", method: null, status: "connected", reason: null, last_used_at: null },
  { id: "google", name: "Google", source: null, method: null, status: "missing", reason: null, last_used_at: null }] };

const mount = async (answer) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  const router = createMemoryRouter([{ path: "/me/models", element: <Models />, loader: modelsLoader }], { initialEntries: ["/me/models"] });
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  return { root, find: (pred) => all(root).find(pred) };
};

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("my model access", () => {
  it("Dummy data (client-only state): model access loading shows skeletons", async () => {
    const { find } = await mount(() => new Promise(() => {}));
    expect(find((n) => n.attrs["aria-busy"] === "true").childNodes).toHaveLength(5);
  });

  it("Dummy data (client-only state): model access error shows the card error with Retry", async () => {
    const { find } = await mount(() => new Response("", { status: 503 }));
    expect(find((n) => n.attrs.role === "alert").textContent).toBe("Couldn't load model access: /api/me/models: HTTP 503Retry");
  });

  it("Model access shows the unchecked state for a new key", async () => {
    const providers = ACCESS.providers.map((p) => (p.id === "google" ? { ...p, source: "mine", method: "key", status: "unchecked" } : p));
    const { find } = await mount(() => Response.json({ ...ACCESS, providers }));
    expect(find((n) => n.nodeName === "TR" && n.textContent.startsWith("Google")).textContent).toContain("unchecked");
  });

  it("the credits line names the current account and no invented limit", async () => {
    const { find } = await mount(() => Response.json({ ...ACCESS, account: "Acme Labs", org_keys: ["google"] }));
    const text = (h) => find((n) => n.nodeName === "DIV" && n.textContent.startsWith(h)).textContent;
    expect(text("Use Cloudflare credits")).toBe("Use Cloudflare credits defaultBilled to Acme Labs. No key needed. Hosted models only.");
    expect(text("Use org key")).toContain("The org has keys for Google.");
  });

  it("the method seg changes the key field's label", async () => {
    const { find } = await mount(() => Response.json(ACCESS));
    const label = () => find((n) => n.nodeName === "SPAN" && /^(API key|Login token)$/.test(n.textContent)).textContent;
    expect(label()).toBe("API key");
    await act(async () => click(find((n) => n.attrs.role === "tab" && n.textContent === "Subscription login")));
    expect(label()).toBe("Login token");
  });
});
