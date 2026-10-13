import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Page stylesheets stay loaded once their page has been opened, so a bare shared class in one restyles every page.
const dir = new URL("./styles/", import.meta.url);
const sheets = readdirSync(dir).filter((f) => f.endsWith(".css") && f !== "app.css" && f !== "tokens.css");
const selectors = (f) => [...readFileSync(new URL(f, dir), "utf8").replace(/\/\*[^]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
  .flatMap((m) => m[1].split(",").map((s) => s.trim()));

describe("page stylesheets", () => {
  it("never style the code view's line numbers (.ln) unscoped, so a file's numbers stay in their gutter", () => {
    const bare = sheets.flatMap((f) => selectors(f).filter((s) => /^\.ln(?![\w-])/.test(s)).map((s) => `${f}: ${s}`));
    expect(bare).toEqual([]);
  });
});
