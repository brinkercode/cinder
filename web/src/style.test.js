import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = new RegExp(String.fromCharCode(99, 105, 116, 97, 100, 101, 108), "i");

describe("source style", () => {
  it("no source file names a source project", () => {
    const dir = new URL("./", import.meta.url);
    const files = readdirSync(dir, { recursive: true }).filter((f) => /\.(css|jsx?)$/.test(f) && !/\.test\./.test(f));
    expect(files).toContain("wiki.jsx");
    for (const f of files) expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(SOURCE);
  });
});
