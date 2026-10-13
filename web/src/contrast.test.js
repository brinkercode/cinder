import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (f) => readFileSync(new URL(`./styles/${f}`, import.meta.url), "utf8").replace(/\/\*[^]*?\*\//g, "");
const tokens = css("tokens.css");
const block = (sel) => tokens.slice(tokens.indexOf(`${sel}{`)).split("}")[0];
const themes = { light: block(":root,.light"), dark: block(".dark") };

// The token a rule sets for a property; the last matching rule in the file wins, as in the cascade.
function token(file, selector, prop) {
  const rules = [...css(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].trim() === selector);
  const vals = rules.map((m) => m[2].match(new RegExp(`(?:^|;)${prop}:var\\((--[\\w-]+)\\)`))?.[1]).filter(Boolean);
  return vals.at(-1);
}

// Theme value of a token, falling back to the light block as :root does.
function oklch(theme, name) {
  const re = new RegExp(`${name}:oklch\\(([\\d.]+)(%?) ([\\d.]+) ([\\d.]+)`);
  const m = themes[theme].match(re) ?? themes.light.match(re);
  return [m[2] ? m[1] / 100 : Number(m[1]), Number(m[3]), Number(m[4])];
}

function luminance([L, C, H]) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

const ratio = (theme, fg, bg) => {
  const [x, y] = [luminance(oklch(theme, fg)), luminance(oklch(theme, bg))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("contrast", () => {
  it("Install and empty-state text meet AA contrast in both themes", () => {
    const pairs = {
      install: [token("app.css", ".btn-primary", "color"), token("marketplace.css", ".mk .lc-m .btn-primary", "background")],
      installed: [token("app.css", ".btn-secondary", "color"), token("marketplace.css", ".mk .lc-m .btn-secondary", "background")],
      empty: [token("app.css", ".col-empty", "color"), token("app.css", ".col", "background")],
    };
    for (const theme of ["light", "dark"]) {
      for (const [what, [fg, bg]] of Object.entries(pairs)) {
        expect(ratio(theme, fg, bg), `${what} ${fg} on ${bg} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
