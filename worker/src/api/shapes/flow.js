import { parseYaml } from "../../yaml.js";

// A flow is .cinder/flows/<name>.yml (what cinder runs):
// name, on: [triggers], cron, env: {KEY: "value"}, secrets: [keystore names the steps get as env], concurrency (queue or cancel the flow's other runs, flows.js), runs-on (the default pool labels), and steps as a map of
// name to step (a step's own `secrets: [..]` are read just before it runs and only it gets them), e.g.
//   ship: { stage: deploy, deploy: production, needs: [test] }
// A step runs a command or deploys to an environment (the Deployments card). Steps live in a map because the YAML subset
// (src/yaml.js) has no lists of block maps. A step may instead use cinder/verify or cloudflare/workflow (`uses`) or wait on an
// `approval`; its other keys (target, workflow, if) are kept as written. Steps group into jobs with `job`, `matrix`, `shard`
// and `runs-on`, and a top-level `stages: { <stage>: { needs: [..] } }` orders stages (planFlow). A deploy to a target other than Cloudflare
// (AWS, Google Cloud, Azure, SSH) may also give the `run` command that deploys, run on the flow's worker with its secrets;
// without one the step fails when it runs. Its aws, gcp, azure or ssh map (TARGET_CONFIG) says how the flow's worker signs in
// (runner/cmd/cinder-verify/deploy.go). A run step may carry `setup: { go: "1.24.13" }`: the worker puts those
// toolchain versions on the step's PATH first (runner/cmd/cinder-verify/toolcache.go, worker/src/toolcache.js).
export const SETUP_TOOLS = ["node", "python", "go", "rust", "dotnet", "java", "ruby", "php", "terraform", "helm"];
export const TOOL_VERSION = /^[0-9][0-9A-Za-z.-]*$/;
export const FLOW_TRIGGERS = ["push", "change", "cron", "manual"];
export const STEP_STATUSES = ["queued", "running", "passed", "failed", "skipped", "cancelled"];
export const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const CONCURRENCY = ["cancel", "queue", "parallel"];
// The config a deploy step or an environment (validateDeploy) carries under aws, gcp, azure or ssh. A credential is only ever a
// Keystore secret's name: `secret` (`key_secret` for ssh); without one, aws assumes role_arn and gcp uses the workload identity
// provider over OIDC, and azure uses its federated credential.
export const TARGET_CONFIG = {
  aws: { auth: "role_arn", service: ["lambda", "ecs", "apprunner"], fields: ["region", "resource"] },
  gcp: { auth: "provider", service: ["run", "functions"], fields: ["region", "name"] },
  azure: { service: ["containerapps", "functions"], fields: ["subscription", "resource_group", "app"] },
  ssh: { fields: ["host", "user", "command", "fingerprint"] },
};
export function targetErrors(kind, c, at) {
  const t = TARGET_CONFIG[kind], key = kind === "ssh" ? "key_secret" : "secret", errors = [];
  const bad = (k, desc) => errors.push(`${at}.${kind}.${k}: expected ${desc}`);
  if (!c || typeof c !== "object" || Array.isArray(c)) return [`${at}.${kind}: expected a map`];
  for (const k of t.fields) if (typeof c[k] !== "string" || !c[k] || unsafe(c[k])) bad(k, "a one-line value");
  if (c.region != null && !/^[a-z0-9-]+$/.test(c.region)) bad("region", "a region id like eu-west-1");
  if (kind === "ssh" && !String(c.fingerprint).startsWith("SHA256:")) bad("fingerprint", "the host key's SHA256: fingerprint");
  if (t.service && !t.service.includes(c.service)) bad("service", `one of ${t.service.join(", ")}`);
  if ((c[key] != null || kind === "ssh") && !(typeof c[key] === "string" && ENV_KEY.test(c[key]))) bad(key, "a Keystore secret's name");
  if (t.auth && (c[key] != null) === (typeof c[t.auth] === "string" && c[t.auth] !== "" && !unsafe(c[t.auth]))) bad(t.auth, `exactly one of ${t.auth} or ${key}`);
  return errors;
}
const CRON = /^\S+( \S+){4}$/;
const MAX_LEGS = 32;
const relPath = (p) => typeof p === "string" && /^[\w.*/-]+$/.test(p) && !p.startsWith("/") && !p.split("/").includes("..");

// lazy: values are written quoted without escapes, so they may not hold both quote kinds, " #" or a newline.
const q = (s) => (s.includes('"') ? `'${s}'` : `"${s}"`);
const list = (a) => `[${a.join(", ")}]`;
const val = (v) => (Array.isArray(v) ? list(v) : typeof v === "object" ? `{ ${Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => `${k}: ${val(x)}`).join(", ")} }` : q(v));
const unsafe = (s) => typeof s !== "string" || /\n|\s#/.test(s) || (s.includes('"') && s.includes("'"));

const isMap = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const named = (v) => typeof v === "string" && FLOW_NAME.test(v);
const FLOW_KEYS = ["name", "on", "cron", "env", "secrets", "concurrency", "runs-on", "stages", "steps"];
const STEP_KEYS = ["stage", "needs", "run", "deploy", "uses", "approval", "target", "workflow", "if", "secrets", "setup", ...Object.keys(TARGET_CONFIG),
  "job", "matrix", "shard", "runs-on", "retries", "junit", "artifacts"];
// The 1-based line of path (dotted) in parseYaml's line map: its own, else its nearest parent's (keys of an inline {..} share its line).
const lineOf = (at, path) => {
  for (const p = path.split("."); p.length; p.pop()) if (at[p.join(".")]) return at[p.join(".")];
  return 1;
};
// Edit distance counting a swap of two neighbours as one edit, for "did you mean" on an unknown key.
const distance = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
};
const unknownKeys = (at, v, known) => Object.keys(v ?? {}).filter((k) => !known.includes(k)).map((k) => {
  const [d, near] = known.map((x) => [distance(k, x), x]).sort((a, b) => a[0] - b[0])[0];
  return `${at}${k}: unknown key${d <= 2 ? `; did you mean ${near}?` : ""}`;
});

// The def of a flow file: the YAML as written (never coerced; validateFlow says what's wrong), steps as a list with their names.
// Throws, with the line, when the document, steps or stages, or one of their entries, isn't a map. at is parseYaml's line map.
export function parseFlow(text, at = {}) {
  const y = parseYaml(text, at);
  const maps = ["steps", "stages"].flatMap((k) => (isMap(y?.[k]) ? Object.entries(y[k]).map(([n, v]) => [`${k}.${n}`, v]) : []));
  for (const [path, v] of [["flow", y], ["steps", y.steps ?? {}], ["stages", y.stages ?? {}], ...maps]) {
    if (!isMap(v)) throw new Error(`yaml: line ${lineOf(at, path)}: ${path}: expected a map`);
  }
  const { steps, stages, ...top } = y;
  return {
    name: "", on: [], cron: "", env: {}, secrets: [], ...top,
    stages: Object.fromEntries(Object.entries(stages ?? {}).map(([id, st]) => [id, { needs: [], ...st }])),
    steps: Object.entries(steps ?? {}).map(([name, s]) => ({ stage: "", run: "", deploy: "", ...s, name })),
  };
}

// The flow file at path (.cinder/flows/<name>.yml): its def (null when it doesn't parse) and every error, each with its line and
// text "<path>:<line>: <field>: <problem>".
export function readFlow(text, path) {
  const at = {};
  let def;
  try {
    def = parseFlow(text, at);
  } catch (e) {
    const [, n = "1", msg = e.message] = /^yaml: line (\d+): (.*)$/s.exec(e.message) ?? [];
    return { def: null, errors: [{ line: Number(n), text: `${path}:${n}: ${msg}` }] };
  }
  const file = path.split("/").pop().replace(/\.yml$/, "");
  const errors = [...(def.name === file ? [] : [`name: must equal the file name ${file}`]), ...validateFlow(def).errors];
  return { def, errors: errors.map((e) => {
    const line = lineOf(at, e.slice(0, e.indexOf(":")));
    return { line, text: `${path}:${line}: ${e}` };
  }) };
}

// The errors of content written to path when path is a flow file (.cinder/flows/<name>.yml); none for any other file.
export function flowFileErrors(path, content) {
  const m = /^\.cinder\/flows\/([^/]+)\.yml$/.exec(path);
  return m && FLOW_NAME.test(m[1]) ? readFlow(content, path).errors.map((e) => e.text) : [];
}

export const flowYaml = (f) => [
  `name: ${f.name}`, `on: ${list(f.on)}`, ...(f.cron ? [`cron: ${q(f.cron)}`] : []),
  ...(Object.keys(f.env).length ? ["env:", ...Object.entries(f.env).map(([k, v]) => `  ${k}: ${q(v)}`)] : []),
  ...(f.secrets?.length ? [`secrets: ${list(f.secrets)}`] : []),
  ...(f.concurrency ? [`concurrency: ${f.concurrency}`] : []), ...(f["runs-on"]?.length ? [`runs-on: ${list(f["runs-on"])}`] : []),
  ...(Object.keys(f.stages ?? {}).length ? ["stages:", ...Object.entries(f.stages).map(([id, st]) => `  ${id}: ${val(st)}`)] : []),
  "steps:", ...f.steps.map(({ name, stage, run, deploy, needs, ...more }) => {
    const rest = Object.entries(more).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${val(v)}`);
    return `  ${name}: { ${[`stage: ${stage}`, deploy && `deploy: ${typeof deploy === "object" ? val(deploy) : deploy}`, (run || (!deploy && !rest.length)) && `run: ${q(run)}`, ...rest, `needs: ${list(needs)}`].filter(Boolean).join(", ")} }`;
  }),
  "",
].join("\n");

export function validateFlow(f) {
  const errors = unknownKeys("", f, FLOW_KEYS);
  if (!named(f?.name)) errors.push(`name: must match ${FLOW_NAME}`);
  if (!Array.isArray(f?.on) || !f.on.length || !f.on.every((t) => FLOW_TRIGGERS.includes(t))) errors.push(`on: expected a non-empty list from ${FLOW_TRIGGERS.join(", ")}`);
  if (f?.on?.includes?.("cron") ? !CRON.test(f.cron ?? "") || unsafe(f.cron) : f?.cron) errors.push("cron: five fields, and only with the cron trigger");
  if (f?.env != null && !isMap(f.env)) errors.push("env: expected a map of KEY: value");
  else for (const [k, v] of Object.entries(f?.env ?? {})) if (!ENV_KEY.test(k) || unsafe(v)) errors.push(`env.${k}: key must match ${ENV_KEY}, value a one-line string`);
  if (f?.secrets != null && !(Array.isArray(f.secrets) && f.secrets.every((k) => typeof k === "string" && ENV_KEY.test(k)))) errors.push(`secrets: a list of names matching ${ENV_KEY}`);
  if (f?.concurrency != null && !CONCURRENCY.includes(f.concurrency)) errors.push(`concurrency: one of ${CONCURRENCY.join(", ")}`);
  if (f?.["runs-on"] != null && !(Array.isArray(f["runs-on"]) && f["runs-on"].every(named))) errors.push(`runs-on: a list of labels matching ${FLOW_NAME}`);
  const steps = Array.isArray(f?.steps) ? f.steps : [];
  if (!steps.length) errors.push("steps: at least one");
  const names = steps.map((s) => s?.name);
  for (const s of steps) {
    const at = `steps.${s?.name}`;
    errors.push(...unknownKeys(`${at}.`, s, ["name", ...STEP_KEYS]));
    if (!named(s?.name) || names.indexOf(s.name) !== names.lastIndexOf(s.name)) errors.push(`${at}: name must be unique and match ${FLOW_NAME}`);
    if (!named(s?.stage)) errors.push(`${at}.stage: required, matching ${FLOW_NAME}`);
    for (const k of ["run", "deploy", "uses", "approval", "target", "workflow", "if"]) if (s?.[k] != null && typeof s[k] !== "string") errors.push(`${at}.${k}: expected a string`);
    const external = Boolean(s?.deploy && s.target && s.target !== "Cloudflare");
    if ([s?.run, s?.deploy, s?.uses, s?.approval].filter(Boolean).length !== (external && s.run ? 2 : 1) || unsafe(s?.run ?? "") || (s?.deploy && !named(s.deploy))) {
      errors.push(`${at}: give one of run (a one-line command), deploy (an environment, plus run for a target other than Cloudflare), uses or approval`);
    }
    for (const k of Object.keys(TARGET_CONFIG)) if (s?.[k] != null) errors.push(...targetErrors(k, s[k], at));
    const setup = Object.entries(s?.setup ?? {});
    if (s?.setup != null && (!s.run || typeof s.setup !== "object" || Array.isArray(s.setup) || !setup.length
      || !setup.every(([t, v]) => SETUP_TOOLS.includes(t) && typeof v === "string" && TOOL_VERSION.test(v)))) {
      errors.push(`${at}.setup: on a run step, {tool: "version"} with tools from ${SETUP_TOOLS.join(", ")} and versions matching ${TOOL_VERSION}`);
    }
    if (s?.secrets != null && !(Array.isArray(s.secrets) && s.secrets.every((k) => typeof k === "string" && ENV_KEY.test(k)))) errors.push(`${at}.secrets: names matching ${ENV_KEY}`);
    if (s?.uses === "cloudflare/workflow" && !named(s.workflow)) errors.push(`${at}.workflow: a Workflow name matching ${FLOW_NAME}`);
    if (!Array.isArray(s?.needs) || !s.needs.every((n) => n !== s.name && names.includes(n))) errors.push(`${at}.needs: required, a list of other steps of this flow ([] for none)`);
    // A step without job is its own job named after the step, so that name may not also be another step's job.
    if (s?.job != null ? !named(s.job) : steps.some((o) => o?.job === s?.name && o.stage === s?.stage)) errors.push(`${at}.job: must match ${FLOW_NAME} and be unique in its stage`);
    const matrix = Object.entries(s?.matrix ?? {});
    if (s?.matrix != null && (typeof s.matrix !== "object" || Array.isArray(s.matrix) || !matrix.length
      || !matrix.every(([k, v]) => FLOW_NAME.test(k) && Array.isArray(v) && v.length && v.every((x) => FLOW_NAME.test(String(x)))))) {
      errors.push(`${at}.matrix: {key: [values]} with keys and values matching ${FLOW_NAME}`);
    }
    if (s?.retries != null && (typeof s.retries === "object" || !/^[0-9]+$/.test(String(s.retries)))) errors.push(`${at}.retries: a whole number, at least 0`);
    if (s?.shard != null && (typeof s.shard === "object" || !/^[1-9][0-9]*$/.test(String(s.shard)))) errors.push(`${at}.shard: a whole number of shards, at least 1`);
    else if (matrix.reduce((n, [, v]) => n * [].concat(v).length, Number(s?.shard ?? 1)) > MAX_LEGS) errors.push(`${at}: matrix × shard gives more than ${MAX_LEGS} legs`);
    if (s?.["runs-on"] != null && !(Array.isArray(s["runs-on"]) && s["runs-on"].every(named))) errors.push(`${at}.runs-on: a list of labels matching ${FLOW_NAME}`);
    for (const k of ["junit", "artifacts"]) if (s?.[k] != null && !(Array.isArray(s[k]) && s[k].length && s[k].every(relPath))) errors.push(`${at}.${k}: a list of relative paths inside the repo`);
  }
  const stageIds = [...new Set(steps.map((s) => s?.stage))];
  for (const [id, st] of Object.entries(f?.stages ?? {})) {
    errors.push(...unknownKeys(`stages.${id}.`, st, ["needs"]));
    if (!stageIds.includes(id) || !Array.isArray(st?.needs) || !st.needs.every((n) => n !== id && stageIds.includes(n))) errors.push(`stages.${id}: a stage of this flow's steps, whose needs name its other stages`);
  }
  if (errors.length) return { ok: false, errors };
  const done = order(names, (n) => steps[names.indexOf(n)].needs);
  if (done.length < steps.length) errors.push(`steps: dependency cycle through ${names.filter((n) => !done.includes(n)).join(", ")}`);
  const staged = order(stageIds, (id) => f.stages?.[id]?.needs ?? []);
  if (staged.length < stageIds.length) errors.push(`stages: dependency cycle through ${stageIds.filter((id) => !staged.includes(id)).join(", ")}`);
  return { ok: errors.length === 0, errors };
}

// Kahn: ids in dependency order, earliest listed first; ids left out sit on a dependency cycle.
function order(ids, needs) {
  const done = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const id of ids) if (!done.includes(id) && needs(id).every((n) => done.includes(n))) { done.push(id); grew = true; }
  }
  return done;
}

// "<k> <v>[, …]" per matrix combination, times "i/n" per shard; [""] when the job has neither.
function legs(matrix, shard) {
  let out = [""];
  const times = (vals) => { out = out.flatMap((l) => vals.map((v) => (l ? `${l}, ${v}` : v))); };
  for (const [k, v] of Object.entries(matrix ?? {})) times([].concat(v).map((x) => `${k} ${x}`));
  if (shard) times(Array.from({ length: Number(shard) }, (_, i) => `${i + 1}/${shard}`));
  return out;
}

// The stage → job → step plan of a valid flow. Steps sharing stage and job form one job in file order; a step without job
// is its own job. A job's matrix, shard and runs-on come from the first of its steps that sets them; runs-on falls back to the flow's.
export function planFlow(def) {
  const jobs = new Map();
  for (const s of def.steps) {
    const k = `${s.stage}/${s.job || s.name}`;
    jobs.set(k, [...(jobs.get(k) ?? []), s]);
  }
  const needs = (id) => def.stages?.[id]?.needs ?? [];
  return {
    stages: order([...new Set(def.steps.map((s) => s.stage))], needs).map((id) => ({
      id, needs: needs(id),
      jobs: [...jobs.values()].filter(([first]) => first.stage === id).flatMap((steps) => {
        const pick = (k) => steps.find((s) => s[k] != null)?.[k];
        const name = steps[0].job || steps[0].name;
        return legs(pick("matrix"), pick("shard")).map((leg) => ({
          key: [id, name, leg].filter(Boolean).join("/"), name, ...(leg && { leg }), runs_on: [].concat(pick("runs-on") ?? def["runs-on"] ?? []), steps: steps.map((s) => s.name),
        }));
      }),
    })),
  };
}

// GET /api/repos/:name/flow-runs/:id (src/flows.js): status is its flow job's; steps in flow order.
export function validateFlowRun(v) {
  const errors = [];
  for (const k of ["id", "flow", "sha"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  if (v?.ref != null && typeof v.ref !== "string") errors.push("ref: expected string or null");
  if (v?.change !== undefined && (typeof v.change?.id !== "string" || !v.change.id || (v.change.title !== null && typeof v.change.title !== "string"))) errors.push("change: expected {id, title (null when unknown)}");
  if (!["queued", "claimed", "done", "failed"].includes(v?.status)) errors.push("status: expected queued, claimed, done or failed");
  if (Number.isNaN(Date.parse(v?.created_at))) errors.push("created_at: expected ISO timestamp");
  if (!Array.isArray(v?.steps) || !v.steps.every((s) => typeof s?.name === "string" && STEP_STATUSES.includes(s.status) && typeof s.logs === "string")) {
    errors.push(`steps: expected [{name, status, logs}] with status from ${STEP_STATUSES.join(", ")}`);
  } else if (!v.steps.every((s) => s.missing_secrets == null || (Array.isArray(s.missing_secrets) && s.missing_secrets.every((k) => typeof k === "string" && ENV_KEY.test(k))))) {
    errors.push(`steps: missing_secrets, when given, is a list of names matching ${ENV_KEY}`);
  }
  return { ok: errors.length === 0, errors };
}
