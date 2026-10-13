import { afterEach, describe, expect, it, vi } from "vitest";
import { all, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { Access, accessLoader } = await import("./access.jsx");

const person = (i) => ({ email: `p${i}@nimbusedge.dev`, owner: false, role: "contributor", created_at: "2026-10-01T00:00:00Z", last_seen: null });
const store = (data = {}) => ({ getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } });

// answer: the groups and people lists, or null to keep both pending.
const mount = async (answer) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn(async (url) => (answer ? Response.json(url === "/api/groups" ? answer.groups : url === "/api/service-tokens" ? [] : answer.people) : new Promise(() => {}))));
  const router = createMemoryRouter([{ path: "/settings/access", element: <Access />, loader: accessLoader }], { initialEntries: ["/settings/access"] });
  const root = doc.body.appendChild(new El("div"));
  const r = createRoot(root);
  await act(async () => r.render(<RouterProvider router={router} />));
  const tables = () => all(root).filter((n) => n.nodeName === "TBODY").map((b) => b.childNodes.length);
  return { root, tables, unmount: () => act(async () => r.unmount()) };
};

afterEach(() => vi.unstubAllEnvs()); // not unstubAllGlobals: that drops fake-dom.js's window

describe("skeleton shape from last known data", () => {
  it("a section that last rendered 3 rows shows exactly 3 row bones on the next load", async () => {
    vi.stubGlobal("localStorage", store());
    const seen = await mount({ groups: [{ name: "eng", source: "Access group", role: "owner", repos: [] }], people: [0, 1, 2].map(person) });
    expect(seen.tables()).toEqual([1, 3]);
    await seen.unmount();
    expect((await mount(null)).tables()).toEqual([1, 3]);
  });

  it("a section last seen empty shows its empty state and no bones", async () => {
    vi.stubGlobal("localStorage", store());
    await (await mount({ groups: [], people: [person(0)] })).unmount();
    const { root, tables } = await mount(null);
    expect(tables()).toEqual([1]);
    expect(root.textContent).toContain("No mappings yet.");
  });

  it("with no record, it shows the spec count", async () => {
    const ls = store();
    vi.spyOn(ls, "getItem");
    vi.stubGlobal("localStorage", ls);
    expect((await mount(null)).tables()).toEqual([4, 6, 2]);
    expect(ls.getItem).toHaveBeenCalledWith("shape:access//people");
  });

  it("with localStorage throwing, it still renders the spec count", async () => {
    const boom = vi.fn(() => { throw new Error("SecurityError"); });
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
    const seen = await mount({ groups: [], people: [person(0)] });
    expect(seen.tables()).toEqual([1]);
    await seen.unmount();
    expect((await mount(null)).tables()).toEqual([4, 6, 2]);
    expect(boom).toHaveBeenCalledWith("shape:access//people", JSON.stringify({ n: 1 }));
  });
});
