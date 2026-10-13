import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

describe("layout frames", () => {
  it("fails if any component outside Frame sets a page width (max-width, or margin:auto on a page root)", () => {
    const css = read("styles/app.css").replace(/\/\*[\s\S]*?\*\//g, "");
    // Innermost rules only, so a rule inside @media keeps its own selector.
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [sel.trim(), body]);
    const pageRoot = /(^|,)\s*(\.main|\.page|\.frame|\.f-\w+|\.ph|\.ph-in|\.split-main)\s*(,|$)/;
    const bad = rules.filter(([sel, body]) => sel !== ".fc"
      && (/max-width:\s*(var\(--w|9\d\dpx|\d{4,}px)/.test(body) || (pageRoot.test(sel) && /(^|;)\s*margin(-inline)?:[^;]*auto/.test(body))));
    expect(bad.map(([sel]) => sel)).toEqual([]);

    const jsx = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".jsx") && !f.includes(".test."));
    for (const f of jsx) {
      const src = read(f);
      expect(src, f).not.toMatch(/maxWidth|marginInline|className="page[" ]|split-main|aside-split/);
    }
  });
});
