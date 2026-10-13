import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const jsx = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".jsx") && !f.includes(".test."));

describe("icons", () => {
  it("no vendored icon files remain and every icon import comes from react-icons/pi", () => {
    expect(existsSync(new URL("icons", import.meta.url))).toBe(false);
    expect(existsSync(new URL("icon.jsx", import.meta.url))).toBe(false);
    const pi = jsx.flatMap((f) => {
      const code = src(f);
      expect(code, f).not.toMatch(/icon\.jsx|\.svg["?]|<Icon\b/);
      for (const [, names, from] of code.matchAll(/^import \{([^}]*)\} from "([^"]+)";$/gm)) {
        if (/\bPi[A-Z]/.test(names)) expect(from, f).toBe("react-icons/pi");
        if (from.startsWith("react-icons")) expect(from === "react-icons/pi" || names.trim() === "IconContext", f).toBe(true);
      }
      return [...code.matchAll(/<(Pi[A-Z]\w*) \/>/g)];
    });
    expect(pi.length).toBeGreaterThan(40);
  });
});
