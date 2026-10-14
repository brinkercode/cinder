// Enforces the CONTRIBUTING.md frontend rules eslint can't see: dependencies, kit config files, CSS.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const banned = JSON.parse(readFileSync(join(root, "scripts/banned-packages.json"), "utf8"));
const errors = [];

for (const dir of [".", "worker", "web"]) {
  const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (banned.some((b) => name === b || name.startsWith(`${b}/`))) errors.push(`${dir}/package.json: banned dependency ${name}`);
  }
}
for (const f of ["components.json", "web/components.json", "tailwind.config.js", "tailwind.config.ts", "web/tailwind.config.js", "web/tailwind.config.ts"]) {
  if (existsSync(join(root, f))) errors.push(`${f}: kit config file not allowed`);
}

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
for (const dir of ["worker/src", "worker/test", "web/src"]) {
  for (const file of walk(join(root, dir)).filter((f) => /\.(ts|tsx|mts|cts)$/.test(f))) errors.push(`${file}: TypeScript not allowed; use .js or .jsx`);
}
for (const file of walk(join(root, "web/src")).filter((f) => f.endsWith(".css"))) {
  const css = readFileSync(file, "utf8");
  const isTokens = file.endsWith("tokens.css");
  if (/backdrop-filter/.test(css)) errors.push(`${file}: backdrop-filter not allowed`);
  if (/background-clip:\s*text/.test(css)) errors.push(`${file}: background-clip: text not allowed`);
  if (!isTokens && /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/.test(css)) errors.push(`${file}: color literal outside tokens.css`);
  if (!isTokens && /font-family:\s*(?!var\(--font-)/.test(css)) errors.push(`${file}: font-family must use var(--font-*)`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
