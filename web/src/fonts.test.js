import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const web = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(join(web, p), "utf8");

describe("fonts", () => {
  it("tokens.css declares Inter Variable and Paper Mono from /fonts/ and no Hanken Grotesk or IBM Plex Mono remains in web/src or web/public", () => {
    const tokens = read("src/styles/tokens.css");
    expect(tokens).toContain('@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;font-display:swap;src:url("/fonts/inter-variable.woff2") format("woff2")}');
    expect(tokens).toContain('@font-face{font-family:"Inter Variable";font-style:italic;font-weight:100 900;font-display:swap;src:url("/fonts/inter-variable-italic.woff2") format("woff2")}');
    expect(tokens).toContain('@font-face{font-family:"Paper Mono";font-style:normal;font-weight:100 800;font-display:swap;src:url("/fonts/paper-mono-variable.woff2") format("woff2")}');
    expect(tokens).toContain('--font-sans:"Inter Variable",ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji";');
    expect(tokens).toContain('--font-mono:"Paper Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;');
    for (const dir of ["src", "public"]) {
      for (const f of readdirSync(join(web, dir), { recursive: true, withFileTypes: true })) {
        if (!f.isFile() || f.name === "fonts.test.js") continue;
        const path = join(f.parentPath, f.name);
        expect(path).not.toMatch(/hanken|plex/i);
        expect(readFileSync(path, "latin1"), path).not.toMatch(/Hanken Grotesk|IBM Plex Mono/);
      }
    }
  }, 30_000); // walks every file in web/src and web/public; slow on a loaded CI runner

  it("body styles include the cv02-cv04 feature settings and antialiasing", () => {
    const body = read("src/styles/app.css").match(/^body\{[^}]*\}/m)[0];
    expect(body).toContain('font-feature-settings:"calt","cv02","cv03","cv04"');
    expect(body).toContain("-webkit-font-smoothing:antialiased");
    expect(read("src/styles/app.css")).toContain("body,:where(body *){letter-spacing:-0.0123em}");
  });

  it("the built SPA serves /fonts/inter-variable.woff2 and /fonts/paper-mono-variable.woff2", async () => {
    const out = mkdtempSync(join(tmpdir(), "cinder-web-"));
    try {
      await build({ root: web, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
      const css = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(out, "assets", f), "utf8")).join("");
      for (const font of ["inter-variable.woff2", "inter-variable-italic.woff2", "paper-mono-variable.woff2"]) {
        expect(css).toContain(`url(/fonts/${font})`);
        expect(existsSync(join(out, "fonts", font)), font).toBe(true);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60000);
});
