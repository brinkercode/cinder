import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BarChart } from "./charts.jsx";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const PRIMITIVES = ['class="tile"', 'class="spark"', 'class="bc"', 'class="ring"', 'class="prop"', 'role="tablist"', 'class="tg"', 'popover="auto"',
  'class="bone"', 'class="empty"', 'class="err"', 'class="untrusted"'];

describe("UI-00 foundations", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("a Storybook-free /__ui route (dev only) renders every primitive in dark and light", async () => {
    const { devRoutes } = await import("./gallery.jsx");
    expect(devRoutes.map((r) => r.path)).toEqual(["/__ui"]);
    const html = renderToStaticMarkup(devRoutes[0].element);
    const [, dark, light] = html.split(/<section class="(?:dark|light)"/);
    expect(html).toMatch(/<section class="dark"[\s\S]*<section class="light"/);
    for (const theme of [dark, light]) for (const p of PRIMITIVES) expect(theme).toContain(p);
    expect(read("main.jsx")).toContain("createBrowserRouter([...devRoutes, ...routes])");

    vi.stubEnv("MODE", "production");
    vi.resetModules();
    expect((await import("./gallery.jsx")).devRoutes).toEqual([]);
  }, 30_000); // imports and renders every primitive; slow on a cold transform

  it("charts are hand-drawn SVG/CSS with no chart library", () => {
    expect(read("charts.jsx")).not.toMatch(/^import /m);
    const html = renderToStaticMarkup(<BarChart values={Array.from({ length: 24 }, (_, i) => i)} fails={Array(24).fill(1)} labels={Array.from({ length: 24 }, (_, i) => `h${i}`)} />);
    // max 24 → nice 25: four ticks.
    expect([...html.matchAll(/<div class="bc-y"[^>]*>(.*?)<\/div>/g)][0][1]).toBe("<span>25</span><span>17</span><span>8</span><span>0</span>");
    expect(html.match(/<div class="bc-x">(.*?)<\/div>/)[1].match(/<span>/g)).toHaveLength(6);
    expect(html.match(/<b class="f"/g)).toHaveLength(24);
  });

  it("a bar chart with max value 1 renders tick labels with no duplicates", () => {
    const html = renderToStaticMarkup(<BarChart values={[0, 1, 1, 0]} />);
    expect(html.match(/<div class="bc-y"[^>]*>(.*?)<\/div>/)[1]).toBe("<span>1</span><span>0</span>");
  });

  // check-deps.sh runs as its own CI step (make check-deps); it walks Go modules and can take minutes on a cold cache.
  it("the literal-colour lint passes with the v3 tokens", () => {
    const root = new URL("../../", import.meta.url).pathname;
    execFileSync("node", ["scripts/check-frontend.mjs"], { cwd: root });
    const tokens = read("styles/tokens.css");
    const [light, dark] = tokens.split(/^\.dark\{/m);
    for (const t of ["--pg", "--chart", "--chart-2", "--chart-grid"]) {
      expect(light).toMatch(new RegExp(`${t}:oklch`));
      expect(dark).toMatch(new RegExp(`${t}:oklch`));
    }
    expect(dark).toContain("--base:oklch(15.5% 0 0)");
    expect(dark).toContain("--pg:oklch(0.1 0 0)");
    expect(read("styles/app.css")).toContain("[hidden]{display:none!important}");
  });
});
