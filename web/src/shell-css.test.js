import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("styles/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// Top-level rules only (every @media block removed), as [selector, body].
const base = [...css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [sel.trim(), body.split(";")]);

describe("shell layout CSS", () => {
  it("the crumb style has nowrap and min-width 0 outside the 900 px rule", () => {
    const crumb = base.filter(([sel]) => sel === ".crumb").flatMap(([, body]) => body);
    expect(crumb).toEqual(expect.arrayContaining(["white-space:nowrap", "min-width:0"]));
  });

  it("Repository card links don't remove the focus outline: the .lc card holding a focused .card-link shows the focus ring", () => {
    const ring = base.filter(([sel, body]) => body.includes("box-shadow:var(--focus)") && sel.includes(":has(.card-link:focus-visible)"));
    expect(ring.some(([sel]) => /(^|[,(\s])\.lc\b/.test(sel))).toBe(true);
  });
});
