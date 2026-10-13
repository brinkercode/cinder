import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { expect, it, vi } from "vitest";

const web = fileURLToPath(new URL("../", import.meta.url));

it("the entry chunk is under 200 KB gzipped and holds no page component", async () => {
  const out = mkdtempSync(join(tmpdir(), "cinder-bundle-"));
  // Vitest runs with NODE_ENV=test, which would bundle React's development build.
  vi.stubEnv("NODE_ENV", "production");
  try {
    const { output } = await build({ root: web, mode: "production", logLevel: "silent", build: { outDir: out, emptyOutDir: true, manifest: true } });
    const manifest = JSON.parse(readFileSync(join(out, ".vite/manifest.json"), "utf8"));
    // The entry and every chunk it imports statically: what the first page parses before any page code.
    const entry = new Set();
    const walk = (key) => { if (!entry.has(key)) { entry.add(key); manifest[key].imports?.forEach(walk); } };
    walk("index.html");
    const files = [...entry].map((key) => manifest[key].file);
    const gzipped = files.reduce((n, file) => n + gzipSync(readFileSync(join(out, file))).length, 0);
    expect(gzipped).toBeLessThan(200 * 1024);

    // Every module a route loads lazily is a page; none of them may sit in those chunks.
    const tables = ["src/pages.jsx", "src/routes.jsx"].map((f) => readFileSync(join(web, f), "utf8")).join("");
    const pages = [...tables.matchAll(/import\("\.\/([\w-]+\.jsx)"\)/g)].map((m) => join(web, "src", m[1]));
    expect(pages).toEqual(expect.arrayContaining(["repos.jsx", "code.jsx", "change.jsx", "needs.jsx"].map((f) => join(web, "src", f))));
    const loaded = output.filter((c) => files.includes(c.fileName)).flatMap((c) => c.moduleIds ?? []);
    expect(loaded.length).toBeGreaterThan(0);
    expect(pages.filter((p) => loaded.includes(p))).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(out, { recursive: true, force: true });
  }
}, 120000);

it("no command palette module is in the build", async () => {
  const out = mkdtempSync(join(tmpdir(), "cinder-bundle-"));
  try {
    const { output } = await build({ root: web, mode: "production", logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    const ids = output.flatMap((c) => c.moduleIds ?? []);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => /palette/i.test(id))).toEqual([]);
    expect(output.filter((c) => c.type === "chunk" && /Command palette/.test(c.code)).map((c) => c.fileName)).toEqual([]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 120000);

it("the repositories route's chunk graph excludes the settings chunk", async () => {
  const out = mkdtempSync(join(tmpdir(), "cinder-bundle-"));
  try {
    await build({ root: web, mode: "production", logLevel: "silent", build: { outDir: out, emptyOutDir: true, manifest: true } });
    const manifest = JSON.parse(readFileSync(join(out, ".vite/manifest.json"), "utf8"));
    // Everything a cold load of / fetches: the entry and Repositories' chunk, plus what each imports statically.
    const seen = new Set();
    const walk = (key) => { if (!seen.has(key)) { seen.add(key); manifest[key].imports?.forEach(walk); } };
    walk("index.html");
    const chunk = (name) => Object.keys(manifest).find((key) => manifest[key].name === name && manifest[key].file.endsWith(".js"));
    walk(chunk("repos"));
    expect(chunk("settings")).toBeDefined();
    expect([...seen].map((key) => manifest[key].name).filter((name) => ["settings", "access"].includes(name))).toEqual([]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 120000);
