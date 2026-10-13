import { flowYaml } from "./api/shapes/flow.js";
import { resolve } from "./code.js";
import { parseJsonc } from "./deploy.js";
import { error } from "./router.js";

const WRANGLER = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
// A wrangler binding list per RESOURCE_API type (deploy.js), and the key that names the resource.
const BINDINGS = [
  ["d1", (c) => c.d1_databases, "database_name"],
  ["kv", (c) => c.kv_namespaces, "binding"],
  ["r2", (c) => c.r2_buckets, "bucket_name"],
  ["queue", (c) => c.queues?.producers, "queue"],
];

// lazy: reads only `key = "string"` lines and [table] / [[array]] headers, enough for wrangler's name, assets and bindings.
function parseToml(text) {
  const out = {};
  let at = out;
  const table = (keys) => keys.reduce((o, k) => (o[k] ??= {}), out);
  for (const line of text.split("\n").map((l) => l.trim())) {
    let m;
    if ((m = /^\[\[([\w.]+)\]\]$/.exec(line))) {
      const keys = m[1].split(".");
      (table(keys.slice(0, -1))[keys.at(-1)] ??= []).push((at = {}));
    } else if ((m = /^\[([\w.]+)\]$/.exec(line))) at = table(m[1].split("."));
    else if ((m = /^(\w+)\s*=\s*"([^"]*)"/.exec(line))) at[m[1]] = m[2];
    else if ((m = /^(\w+)\s*=/.exec(line))) at[m[1]] ??= true;
  }
  return out;
}

// Steps run from the service's directory; every one is a dry run that needs no credentials.
function flow(kind, dir, runs) {
  const name = `${kind}-${dir || "root"}`.replace(/[^\w.-]/g, "-").slice(0, 64);
  const cd = dir ? `cd '${dir}' && ` : "";
  const steps = runs.map(([step, run], i) => ({ name: step, stage: "check", run: cd + run, needs: i ? [runs[i - 1][0]] : [] }));
  return { name, yaml: flowYaml({ name, on: ["manual"], env: {}, steps }) };
}

// lazy: reads the tree per request (root plus one directory level); store services per push when repos get large.
async function detect(r, repoName) {
  const read = (path) => r.artifacts.readFile(r.store, r.sha, path).then((t) => t ?? "");
  const root = (await r.artifacts.readTree(r.store, r.sha, "")) ?? [];
  const dirs = await Promise.all(root.filter((e) => e.type === "tree").map(async (e) => [e.path, (await r.artifacts.readTree(r.store, r.sha, e.path)) ?? []]));
  // Each directory is read at once; flat() keeps the root-first order.
  return (await Promise.all([["", root], ...dirs].map(async ([dir, entries]) => {
    const services = [];
    const files = entries.filter((e) => e.type === "blob").map((e) => e.name);
    const at = (f) => (dir ? `${dir}/${f}` : f);
    const base = { path: dir || ".", name: dir || repoName };
    const add = (kind, s) => services.push({ id: `${kind}:${base.path}`, ...base, kind, ...s });
    const wrangler = WRANGLER.find((f) => files.includes(f));
    if (wrangler) {
      const text = await read(at(wrangler));
      let cfg = {};
      // An unparsable config still marks a Worker; only its suggested resources are unknown.
      try { cfg = wrangler.endsWith(".toml") ? parseToml(text) : parseJsonc(text); } catch { /* keep {} */ }
      const name = typeof cfg.name === "string" && cfg.name ? cfg.name : base.name;
      const resources = [{ type: "worker", name }];
      if (cfg.assets) resources.push({ type: "assets", name: typeof cfg.assets.directory === "string" ? cfg.assets.directory : name });
      for (const [type, list, key] of BINDINGS) {
        for (const b of [].concat(list(cfg) ?? [])) if (typeof b?.[key] === "string" && b[key]) resources.push({ type, name: b[key] });
      }
      add("worker", { name, resources, flow: flow("worker", dir, [["install", "npm ci"], ["dry-run", "npx wrangler deploy --dry-run --outdir dist"]]) });
    } else if (files.includes("Dockerfile")) {
      add("container", { resources: [{ type: "container", name: base.name }, { type: "worker", name: base.name }], flow: flow("container", dir, [["image", "docker build ."]]) });
    }
    const tf = (await Promise.all(files.filter((f) => f.endsWith(".tf")).map((f) => read(at(f))))).join("\n");
    if (/provider\s+"cloudflare"|cloudflare\/cloudflare/.test(tf)) {
      const resources = [...tf.matchAll(/resource\s+"(cloudflare_\w+)"\s+"([\w-]+)"/g)].map(([, type, name]) => ({ type, name }));
      add("terraform", { resources, flow: flow("terraform", dir, [["init", "terraform init -backend=false"], ["plan", "terraform plan -refresh=false -input=false"]]) });
    }
    return services;
  }))).flat();
}

// GET /api/repos/:name/services?ref= (the default branch when unset): reads Artifacts only and creates nothing.
export async function getServices(request, env, { name }) {
  const start = performance.now();
  const url = new URL(request.url);
  if (!url.searchParams.get("ref")) {
    const repo = await env.DB.prepare("SELECT default_branch FROM repos WHERE name = ?").bind(name).first();
    if (!repo) return error(404, "not_found", `no repo ${name}`);
    url.searchParams.set("ref", repo.default_branch);
  }
  const r = await resolve(new Request(url), env, name);
  if (r.empty) return Response.json({ ref: r.ref, sha: null, services: [] });
  if (r.res) return r.res;
  const services = await detect(r, name);
  return Response.json({ ref: r.ref, sha: r.sha, services }, { headers: { "Server-Timing": `total;dur=${(performance.now() - start).toFixed(1)}` } });
}
