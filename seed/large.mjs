// atlas-monorepo: a repo large in history and moderate at its head, for partial (blobless) clones. Generated at seed time
// from a fixed PRNG seed, so every run writes the same commits. seedLarge writes it through the seed route.
export const LARGE = "atlas-monorepo";

const PACKAGES = ["auth", "billing", "cache", "catalog", "cli", "config", "crypto", "events", "files", "flags", "geo", "graph",
  "http", "i18n", "images", "inbox", "jobs", "ledger", "logger", "mail", "maps", "media", "metrics", "notify", "orders", "payments",
  "pricing", "queue", "rates", "router", "search", "session", "shipping", "storage", "stream", "tax", "tiles", "users", "vault", "web"];
const VERBS = ["parse", "format", "merge", "split", "score", "build", "check", "load", "store", "route", "group", "rank"];
const NOUNS = ["Entry", "Record", "Batch", "Window", "Range", "Token"];
const MODULES = VERBS.flatMap((v) => NOUNS.map((n) => v + n)).slice(0, 23);
const BUNDLES = ["vendor/tiles-a.js", "vendor/tiles-b.js"];
// Over code search's 1 MiB per-file cap, so the bundles stay out of its index.
const BUNDLE_BYTES = 1_250_000;
const REBUILDS = 47;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// mulberry32: 32-bit ints from seed.
const prng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
};

// Random base64 text, so neither zlib nor git's deltas shrink one build against another.
function bundle(seed) {
  const next = prng(seed);
  const lines = [`// Generated tile data, build ${seed}. Do not edit.`, "export default ["];
  for (let size = 0; size < BUNDLE_BYTES;) {
    let line = '  "';
    for (let i = 0; i < 15; i++) {
      const n = next();
      line += B64[n & 63] + B64[(n >>> 6) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 18) & 63] + B64[(n >>> 24) & 63];
    }
    line += '",';
    lines.push(line);
    size += line.length + 1;
  }
  lines.push("];\n");
  return lines.join("\n");
}

function module(pkg, name, seed) {
  const next = prng(seed);
  const table = Array.from({ length: 48 }, () => (next() % 10000) / 100);
  return `// ${name} for @atlas/${pkg}.
const TABLE = [
  ${table.join(", ")},
];

export function ${name}(items, options = {}) {
  const limit = options.limit ?? ${10 + (next() % 90)};
  const out = [];
  for (const [i, item] of items.entries()) {
    if (out.length >= limit) break;
    const weight = TABLE[i % TABLE.length];
    if (item == null || weight < (options.min ?? 0)) continue;
    out.push({ ...item, weight, package: "${pkg}" });
  }
  return out.sort((a, b) => b.weight - a.weight);
}
`;
}

const day = (i) => new Date(Date.UTC(2026, 0, 5 + i, 9, 30)).toISOString();

// The repo's commits for the seed route, oldest first: the whole tree, then REBUILDS commits that each regenerate one
// vendor bundle and touch one module.
export function largeCommits() {
  const files = {
    "README.md": "# atlas-monorepo\n\nA generated test fixture for large-repo behaviour: about a thousand small modules at its head and a long history of regenerated vendor bundles, so a blobless clone is a fraction of a full one.\n",
    "package.json": `${JSON.stringify({ name: "atlas-monorepo", private: true, type: "module", workspaces: ["packages/*"] }, null, 2)}\n`,
  };
  for (const [p, pkg] of PACKAGES.entries()) {
    files[`packages/${pkg}/package.json`] = `${JSON.stringify({ name: `@atlas/${pkg}`, version: "0.1.0", type: "module", main: "src/index.js" }, null, 2)}\n`;
    files[`packages/${pkg}/src/index.js`] = MODULES.map((m) => `export { ${m} } from "./${m}.js";\n`).join("");
    for (const [m, name] of MODULES.entries()) files[`packages/${pkg}/src/${name}.js`] = module(pkg, name, p * 1000 + m);
  }
  for (const [b, path] of BUNDLES.entries()) files[path] = bundle(b + 1);
  const commits = [{ author: "atlas-ci", message: "Add the atlas monorepo", at: day(0), files }];
  for (let i = 1; i <= REBUILDS; i++) {
    const pkg = PACKAGES[i % PACKAGES.length];
    const name = MODULES[i % MODULES.length];
    const path = BUNDLES[i % BUNDLES.length];
    commits.push({ author: "atlas-ci", message: `Regenerate ${path} (build ${i + 2})`, at: day(i), files: {
      [path]: bundle(i + 2), [`packages/${pkg}/src/${name}.js`]: module(pkg, name, 100000 + i) } });
  }
  return commits;
}

// Creates atlas-monorepo and writes its history through commit (the seed route), at most ~4 MB a request. A run stopped
// part way resumes after the newest commit already on main (commit messages are unique), so a complete repo is left as it is.
export async function seedLarge(api, commit) {
  if (!(await api("GET", `/api/repos/${LARGE}`))) await api("POST", "/api/repos", { name: LARGE, default_branch: "main" });
  const log = (await api("GET", `/api/repos/${LARGE}/log?ref=main`)) ?? [];
  const newest = (Array.isArray(log) ? log : log.commits ?? [])[0]?.message?.split("\n")[0];
  const all = largeCommits();
  let rest = all.slice(newest ? all.findIndex((c) => c.message === newest) + 1 : 0);
  // The first commit (the whole tree) goes alone.
  if (!newest) { await commit({ repo: LARGE, branch: "main", commits: [rest[0]] }); rest = rest.slice(1); }
  for (let i = 0; i < rest.length; i += 3) await commit({ repo: LARGE, branch: "main", commits: rest.slice(i, i + 3) });
}
