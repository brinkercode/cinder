import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";


it("Docs test: no docs/usage page links Explore or topics", () => {
  const dir = new URL("../../docs/usage/", import.meta.url);
  const links = readdirSync(dir).filter((f) => f.endsWith(".md"))
    .flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/\[[^\]]*\]\(([^)]*)\)|`(\/[^`]*)`/g)].map((m) => `${f}: ${m[1] ?? m[2]}`));
  expect(links.length).toBeGreaterThan(0);
  expect(links.filter((l) => /explore|topics?\b|community/i.test(l.split(": ")[1]))).toEqual([]);
  expect(existsSync(new URL("explore.md", dir))).toBe(false);
});

it("docs/usage/repositories.md › exists and is linked from README", () => {
  const dir = new URL("../../docs/usage/", import.meta.url);
  const page = readFileSync(new URL("repositories.md", dir), "utf8");
  expect(page.match(/^## .+$/gm)).toEqual(["## Purpose", "## Where", "## What you can do", "## Backed by", "## Planned"]);
  for (const control of ["Archive", "New repository", "Usage"]) expect(page).toContain(`**${control}**`);
  expect(readFileSync(new URL("README.md", dir), "utf8")).toContain("](repositories.md)");
});

it("docs/usage/README.md links every page and every usage doc has the five sections", () => {
  const dir = new URL("../../docs/usage/", import.meta.url);
  const index = readFileSync(new URL("README.md", dir), "utf8");
  const docs = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
  expect(docs.filter((f) => !index.includes(`](${f})`))).toEqual([]);
  for (const page of ["[Flow run](flows.md", "[Designer](flows.md"]) expect(index).toContain(page);
  const FIVE = ["## Purpose", "## Where", "## What you can do", "## Backed by", "## Planned"];
  const wrong = docs.filter((f) => String(readFileSync(new URL(f, dir), "utf8").match(/^## .+$/gm)?.filter((h) => FIVE.includes(h))) !== String(FIVE));
  expect(wrong).toEqual([]);
});

it("docs/ARCHITECTURE-CLOUDFLARE.md › the Realtime row names LIVE_TICKET_KEY", () => {
  const md = readFileSync(new URL("../../docs/ARCHITECTURE-CLOUDFLARE.md", import.meta.url), "utf8");
  const row = md.match(/^\| Realtime \|.*$/m)?.[0];
  expect(row).toContain("`LIVE_TICKET_KEY`");
  expect(row).not.toContain("OWNER_TOKEN");
});
