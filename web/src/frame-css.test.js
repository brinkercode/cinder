import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("styles/", import.meta.url);

describe("frame width", () => {
  it("no stylesheet sets max-width on .fc, .ph-in, .f-body or .f-aside except the frame rule in app.css", () => {
    const found = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".css"))) {
      const css = readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      // Innermost rules, so a rule inside @media keeps its own selector; the last compound is the element styled.
      for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const width = /(?:^|;)\s*max-width:\s*([^;]+)/.exec(body)?.[1].trim();
        if (!width) continue;
        for (const s of sel.split(",")) {
          if (/\.(fc|ph-in|f-body|f-aside)(?![\w-])/.test(s.trim().split(/[\s>+~]+/).at(-1))) found.push(`${f} ${s.trim()} ${width}`);
        }
      }
    }
    expect(found).toEqual(["app.css .fc var(--w-content)"]);
  });
});
