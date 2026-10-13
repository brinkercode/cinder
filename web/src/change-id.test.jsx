import { describe, expect, it, onTestFinished, vi } from "vitest";
import { doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChangeId } = await import("./ui.jsx");

describe("ChangeId", () => {
  it("a change shown without its key looks the key up once and every place showing it reads PULSE-6", async () => {
    vi.stubEnv("VITE_FIXTURES", "0");
    const calls = [];
    vi.stubGlobal("fetch", async (url) => { calls.push(url); return Response.json({ id: "7680a887-89d4-4022-ac3e-c7c18cce3472", key: "PULSE-6" }); });
    const root = doc.body.appendChild(new El("div"));
    const r = createRoot(root);
    onTestFinished(() => { act(() => r.unmount()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
    const id = "7680a887-89d4-4022-ac3e-c7c18cce3472";
    await act(async () => r.render(<p><ChangeId id={id} /> and <ChangeId id={id} /> and <ChangeId id="c-9" label="EDGE-9" /></p>));
    await act(() => new Promise((res) => setTimeout(res, 0)));
    expect(root.textContent).toBe("PULSE-6 and PULSE-6 and EDGE-9");
    expect(calls).toEqual([`/api/changes/${id}`]);
  });
});
