// Writes seed/bundle.json, the seed's sources as data for the Worker's SeedWorkflow (worker/src/admin.js): every file git
// would commit under seed/repos, by repo, and under demo/pulse. wrangler runs it before each build (build.command in
// worker/ and e2e/ wrangler.jsonc), worker/vitest.config.js before the tests.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const files = (dir) => {
  const root = new URL(dir, import.meta.url).pathname;
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  return Object.fromEntries(paths.map((p) => [p, readFileSync(root + p, "utf8")]));
};
const seed = {};
for (const [path, text] of Object.entries(files("./repos/"))) {
  const [name, ...rest] = path.split("/");
  (seed[name] ??= {})[rest.join("/")] = text;
}
writeFileSync(new URL("./bundle.json", import.meta.url), JSON.stringify({ seed, pulse: files("../demo/pulse/") }));
