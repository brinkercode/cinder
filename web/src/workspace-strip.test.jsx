import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

doc.oninput = null;
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceStrip } = await import("./workspace-strip.jsx");

afterEach(() => vi.unstubAllEnvs());

const ws = { id: "c-1042", intent: "Preserve header case", agent: "patch", ver: "3.2.1" };

async function mount(fetch) {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", fetch);
  const root = doc.body.appendChild(new El("div"));
  const View = () => {
    const [d, set] = useState(false);
    return <WorkspaceStrip ws={ws} symbols={["a.js#f"]} driving={d} setDriving={set} />;
  };
  await act(async () => createRoot(root).render(<View />));
  const find = (pred) => all(root).find(pred);
  const button = (t) => find((n) => n.nodeName === "BUTTON" && n.textContent === t);
  const fire = (el, type) => {
    const e = { type, target: el, bubbles: true, preventDefault() {}, stopPropagation() {} };
    for (let n = el; n; n = n.parentNode) for (const f of n.listeners[type] ?? []) f(e);
  };
  const type = (value) => {
    const el = find((n) => n.attrs["aria-label"] === "Message agent" && n.nodeName === "INPUT");
    Object.assign(el, { value, type: "text" });
    fire(el, "input");
  };
  return { find, button, type, fire, root };
}
const status = (find) => find((n) => n.attrs.role === "status" || n.attrs.role === "alert")?.textContent;

describe("workspace controls", () => {
  it("release frees the lease immediately and pauses the agent", async () => {
    const fetch = vi.fn(async () => Response.json({ id: "c-1042", driver: "owner" }));
    const { find, button } = await mount(fetch);
    await act(async () => click(button("Release lease")));
    expect(fetch).toHaveBeenCalledWith("/api/leases/c-1042", expect.objectContaining({ method: "DELETE" }));
    expect(status(find)).toContain("Lease released. The agent is paused");
    expect(button("Release lease")).toBeUndefined();
  });

  it("a release refused mid-commit shows the reason and keeps the lease", async () => {
    const { find, button } = await mount(async () => Response.json({ error: { message: "c-1042 is mid-commit; try again when it lands" } }, { status: 409 }));
    await act(async () => click(button("Release lease")));
    expect(status(find)).toBe("Couldn't release the lease: c-1042 is mid-commit; try again when it lands");
    expect(button("Release lease")).toBeDefined();
  });

  it("give it back re-grants the lease", async () => {
    const fetch = vi.fn(async () => Response.json({ id: "c-1042", driver: null }));
    const { find, button } = await mount(fetch);
    await act(async () => click(button("Release lease")));
    await act(async () => click(button("Give it back")));
    expect(fetch).toHaveBeenLastCalledWith("/api/changes/c-1042/release", expect.objectContaining({ method: "POST" }));
    expect(status(find)).toContain("Given back");
    expect(button("Release lease")).toBeDefined();
  });

  it("a message reaches the agent before its next tool call", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const { find, type, fire } = await mount(fetch);
    await act(async () => type("use the helper"));
    await act(async () => fire(find((n) => n.nodeName === "FORM"), "submit"));
    expect(fetch).toHaveBeenCalledWith("/api/changes/c-1042/steer", expect.objectContaining({ body: JSON.stringify({ message: "use the helper" }) }));
    expect(status(find)).toBe("Sent “use the helper”. The agent reads it before its next step.");
  });
});
