import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./styles/", import.meta.url);

describe("scrollbars", () => {
  it("every scrollbar-width is none and the global hide rule is present", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
    for (const f of files) {
      for (const [, v] of readFileSync(new URL(f, dir), "utf8").matchAll(/scrollbar-width:\s*([^;}]+)/g)) expect(`${f}: ${v.trim()}`).toBe(`${f}: none`);
    }
    const app = readFileSync(new URL("app.css", dir), "utf8");
    expect(app).toContain("*{scrollbar-width:none}");
    expect(app).toContain("::-webkit-scrollbar{display:none}");
  });
});
