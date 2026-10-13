import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Bone, BoardColSkel, BoneAvatar, BonePill, BoneText, ChartSkel, ListCardSkel, LoadingRegion, Loads, SkelFallback, TableSkel, TileSkel } = await import("./skeleton.jsx");

const html = (el) => renderToStaticMarkup(el);
const bones = (el) => [...html(el).matchAll(/<span class="bone" aria-hidden="true" style="([^"]*)"/g)].map((m) => m[1]);

afterEach(() => vi.useRealTimers());

describe("skeletons", () => {
  it("render tests cover each primitive's size, radius and width cycle, plus the timing rules (150ms delay, 300ms minimum, 10s Still loading with Retry) using fake timers", async () => {
    expect(bones(<Bone w={40} h={8} />)).toEqual(["width:40px;height:8px;border-radius:4px;animation-delay:0ms"]);
    // Text: widths cycle 92/64/78/48%, 10px high for 13px text and 12px for larger, rows staggered 80ms.
    expect(bones(<>{[0, 1, 2, 3, 4].map((i) => <BoneText key={i} i={i} />)}</>)).toEqual(["92%", "64%", "78%", "48%", "92%"]
      .map((w, i) => `width:${w};height:10px;border-radius:4px;animation-delay:${i * 80}ms`));
    expect(bones(<BoneText large />)).toEqual(["width:92%;height:12px;border-radius:4px;animation-delay:0ms"]);
    expect(bones(<BonePill />)).toEqual(["width:64px;height:20px;border-radius:6px;animation-delay:0ms"]);
    expect(bones(<BoneAvatar />)).toEqual(["width:26px;height:26px;border-radius:50%;animation-delay:0ms"]);
    expect(html(<TileSkel label="Runs" />)).toMatch(/^<div class="tile flat"><div class="l">Runs<\/div><div class="v"><span class="bone"[^>]*height:12px/);
    expect(bones(<ListCardSkel lines={3} />)).toEqual(["width:26px;height:26px;border-radius:50%;animation-delay:0ms",
      ...["92%", "64%", "78%"].map((w, i) => `width:${w};height:10px;border-radius:4px;animation-delay:${i * 80}ms`)]);
    // Table: real headers, 44px rows, the mono column a fixed width on every row.
    const table = html(<TableSkel cols={[["Name"], ["SHA", 72]]} rows={4} />);
    expect(table).toContain("<thead><tr><th>Name</th><th>SHA</th></tr></thead>");
    expect(table.match(/<tr style="height:44px">/g)).toHaveLength(4);
    expect(bones(<TableSkel cols={[["Name"], ["SHA", 72]]} rows={4} />).filter((s) => s.startsWith("width:72px;height:10px"))).toHaveLength(4);
    // Chart: real axes on the container, bars are bones.
    expect(html(<ChartSkel height={220} />)).toMatch(/^<div class="chart-skel" style="height:220px">/);
    expect(bones(<ChartSkel />).length).toBeGreaterThan(0);
    // Board column: the real name, n card bones.
    const col = html(<BoardColSkel name="Verifying" cards={3} />);
    expect(col).toContain('<header class="col-h">Verifying</header>');
    expect(col.match(/<div class="chg">/g)).toHaveLength(3);

    vi.useFakeTimers();
    const root = doc.body.appendChild(new El("div"));
    const r = createRoot(root);
    const retry = vi.fn();
    const view = (loading) => act(async () => r.render(<Loads loading={loading} skel={<i>SKEL</i>} onRetry={retry}>DATA</Loads>));
    const tick = (ms) => act(async () => vi.advanceTimersByTime(ms));
    // Data within 150ms: the skeleton never shows.
    await view(true);
    expect(root.textContent).toBe("");
    await tick(140);
    await view(false);
    expect(root.textContent).toBe("DATA");
    // Shown at 150ms, then held for at least 300ms even when data lands at once.
    await view(true);
    await tick(149);
    expect(root.textContent).toBe("");
    await tick(1);
    expect(root.textContent).toBe("SKEL");
    await tick(50);
    await view(false);
    expect(root.textContent).toBe("SKEL");
    await tick(249);
    expect(root.textContent).toBe("SKEL");
    await tick(1);
    expect(root.textContent).toBe("DATA");
    // After 10s: Still loading… with Retry.
    await view(true);
    await tick(9999);
    expect(root.textContent).toBe("SKEL");
    await tick(1);
    expect(root.textContent).toBe("SKELStill loading… Retry");
    await act(async () => click(all(root).find((n) => n.nodeName === "BUTTON")));
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => r.unmount());
  });

  it("a Suspense fallback is hidden for 150ms and shows Still loading with Retry after 10s", async () => {
    vi.useFakeTimers();
    const { Suspense } = await import("react");
    const root = doc.body.appendChild(new El("div"));
    const r = createRoot(root);
    const retry = vi.fn();
    const never = new Promise(() => {});
    const Wait = () => { throw never; };
    const tick = (ms) => act(async () => vi.advanceTimersByTime(ms));
    await act(async () => r.render(<Suspense fallback={<SkelFallback skel={<i>SKEL</i>} onRetry={retry} />}><Wait /></Suspense>));
    await tick(149);
    expect(root.textContent).toBe("");
    await tick(1);
    expect(root.textContent).toBe("SKEL");
    await tick(9849);
    expect(root.textContent).toBe("SKEL");
    await tick(1);
    expect(root.textContent).toBe("SKELStill loading… Retry");
    await act(async () => click(all(root).find((n) => n.nodeName === "BUTTON")));
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => r.unmount());
  });

  it("reduced motion asserts static 0.7 opacity and no animation", () => {
    const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.bone\{[^}]*background:var\(--tint\);animation:bone 1\.6s[^}]*\}@keyframes bone\{50%\{opacity:\.55\}\}/);
    expect(css).not.toMatch(/\.bone[^{]*\{[^}]*gradient/);
    expect(css).toContain("@media (prefers-reduced-motion:reduce){.bone{animation:none;opacity:.7}}");
  });

  it("the loading region is aria-busy with one visually hidden Loading {page} status line", () => {
    expect(html(<LoadingRegion page="Insights" busy>x</LoadingRegion>)).toBe('<div aria-busy="true"><p role="status" class="sr-only">Loading Insights</p>x</div>');
    expect(html(<LoadingRegion page="Insights" busy={false}>x</LoadingRegion>)).toBe('<div aria-busy="false"><p role="status" class="sr-only"></p>x</div>');
  });
});
