// System One client: POST {baseUrl}/v1/systemone with a state and named Choice / Score / Noul questions,
// all answered in one call. HTTP backends differ only by base URL and key; clef / clef-flash send the
// same payload through the Workers AI binding (env.AI) and return the same { answers } shape.
export const MAX_CHOICE_OPTIONS = 255;
export const DEFAULT_TIMEOUT_MS = 10_000;
// Owner to confirm: TypeSafe's hosted endpoint. Override with `baseUrl`.
export const JEV_BASE_URL = "https://api.typesafe.ai";
const KINDS = ["choice", "score", "noul"];
// The only backends airlock allows: nothing leaves the owner's infrastructure.
export const AIRLOCK_BACKENDS = ["stat", "systemone-http"];
export const BACKENDS = [...AIRLOCK_BACKENDS, "jev", "clef", "clef-flash"];
// The Workers AI catalog model behind each pinned clef version; judgments keep the pinned name as their series.
// @2 runs the clef decision models, which take { state, questions } natively; @1 stays for existing judges' history.
export const CLEF_MODELS = {
  "clef@1": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "clef-flash@1": "@cf/meta/llama-3.1-8b-instruct-fast",
  "clef@2": "@cf/cloudflare/clef", "clef-flash@2": "@cf/cloudflare/clef-flash",
};
const PROMPTED = ["clef@1", "clef-flash@1"];
// Only the @1 series: a general chat model answering System One questions as JSON.
const CLEF_PROMPT = "You are a System One judge. The user sends JSON {model, state, questions}. Answer every question about the state. " +
  "Reply with JSON {\"answers\": {<question name>: answer}}: a score or noul answer is P(yes) in [0, 1]; " +
  "a choice answer is an object mapping each option to its probability.";
const ANSWERS_SCHEMA = { type: "object", properties: { answers: { type: "object" } }, required: ["answers"] };

// @2 is Cloudflare's Clef API, whose published schema names System One's fields differently: a question is
// {type, instructions, criteria} (a choice's options are criteria keys, each described by q.criteria), and the call names
// the model ("clef" or "clef-flash"). A System One score is P(yes), which is Clef's noul. The instructions are the question
// (prompt, the label a judgment stores) followed by its guide. Answers come back typed: noul → its probability,
// choice → its probability per option.
const instructions = (q) => (q.guide ? `${q.prompt}\n\n${q.guide}` : q.prompt);
const toClef = (questions) => Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.kind === "choice"
  ? { type: "choice", instructions: instructions(q), criteria: Object.fromEntries(q.options.map((o) => [o, q.criteria?.[o] ?? null])) }
  : { type: "noul", instructions: instructions(q) }]));
const fromClef = (answers) => answers && typeof answers === "object" ? Object.fromEntries(Object.entries(answers)
  .map(([name, a]) => [name, a?.type === "choice" ? a.probabilities : a?.type === "noul" ? a.noul : a])) : answers;

// A pinned model names an exact version: `name@version`, never `latest`.
export function isPinnedModel(model) {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(typeof model === "string" ? model : "");
  return Boolean(m) && m[1] !== "latest";
}

export function buildRequest({ model, state, questions }) {
  if (!isPinnedModel(model)) throw new Error("s1: model must be pinned as name@version");
  if (state === undefined || state === null) throw new Error("s1: state is required");
  const names = questions && typeof questions === "object" ? Object.keys(questions) : [];
  if (names.length === 0) throw new Error("s1: at least one question is required");
  for (const name of names) {
    const q = questions[name];
    if (!q || !KINDS.includes(q.kind)) throw new Error(`s1: question ${name} kind must be one of ${KINDS.join(", ")}`);
    if (typeof q.prompt !== "string" || q.prompt === "") throw new Error(`s1: question ${name} needs a prompt`);
    if (q.kind === "choice") {
      const n = Array.isArray(q.options) ? q.options.length : 0;
      if (n < 2 || n > MAX_CHOICE_OPTIONS) throw new Error(`s1: choice ${name} needs 2..${MAX_CHOICE_OPTIONS} options`);
      if (new Set(q.options).size !== n) throw new Error(`s1: choice ${name} has duplicate options`);
    }
  }
  return { model, state, questions };
}

// Logistic regression on a repo's own outcomes: samples are { features: { name: number }, y: 0 | 1 }.
// Batch gradient descent with a small L2 penalty so a separable set still converges to finite weights.
// lazy: full-batch in memory, fine for one repo's history; move to SGD past ~100k samples.
export function fitLogistic(samples) {
  const steps = 500, rate = 0.5, l2 = 1e-3;
  const names = [...new Set(samples.flatMap((s) => Object.keys(s.features)))];
  const rows = samples.map((s) => names.map((n) => Number(s.features[n]) || 0));
  const w = new Array(names.length).fill(0);
  let b = 0;
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const dot = (x) => x.reduce((sum, v, i) => sum + v * w[i], b);
  for (let step = 0; step < steps; step++) {
    const gw = w.map((wi) => l2 * wi);
    let gb = 0;
    rows.forEach((x, k) => {
      const err = sigmoid(dot(x)) - (samples[k].y ? 1 : 0);
      x.forEach((v, i) => (gw[i] += (err * v) / rows.length));
      gb += err / rows.length;
    });
    w.forEach((_, i) => (w[i] -= rate * gw[i]));
    b -= rate * gb;
  }
  return (features) => sigmoid(dot(names.map((n) => Number(features?.[n]) || 0)));
}

function backendConfig({ backend, model, env = {}, baseUrl, apiKey, samples, metadata }) {
  if (backend === "jev") {
    if (!apiKey) throw new Error("s1: jev needs a TYPESAFE_API_KEY Keystore secret");
    return { baseUrl: baseUrl || JEV_BASE_URL, apiKey };
  }
  if (backend === "clef" || backend === "clef-flash") {
    if (!env.AI) throw new Error(`s1: ${backend} needs the AI binding`);
    if (!CLEF_MODELS[model]) throw new Error(`s1: no Workers AI model for ${backend} ${model}`);
    return { ai: env.AI, catalog: CLEF_MODELS[model], gateway: { id: env.AI_GATEWAY_ID, metadata } };
  }
  if (backend === "stat") {
    if (!Array.isArray(samples) || samples.length === 0) throw new Error("s1: stat needs outcome samples");
    return { stat: fitLogistic(samples) };
  }
  if (backend === "systemone-http") {
    if (!baseUrl) throw new Error("s1: systemone-http needs a base URL");
    // A self-hosted server behind Cloudflare Tunnel is guarded by an Access service token.
    const access = env.S1_ACCESS_CLIENT_ID && env.S1_ACCESS_CLIENT_SECRET
      ? { "cf-access-client-id": env.S1_ACCESS_CLIENT_ID, "cf-access-client-secret": env.S1_ACCESS_CLIENT_SECRET } : {};
    return { baseUrl, apiKey, access };
  }
  throw new Error(`s1: unknown backend ${backend}`);
}

export function createS1Client({ backend, model, env, baseUrl, apiKey, samples, metadata, airlock = false, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!isPinnedModel(model)) throw new Error("s1: model must be pinned as name@version");
  if (airlock && !AIRLOCK_BACKENDS.includes(backend)) {
    const error = `s1: airlock is on, hosted backend ${backend} refused; use ${AIRLOCK_BACKENDS.join(" or ")}`;
    return { backend, model, ask: async () => ({ ok: false, error }) };
  }
  const cfg = backendConfig({ backend, model, env, baseUrl, apiKey, samples, metadata });
  if (cfg.stat) {
    return {
      backend,
      model,
      // The state is the feature map; only Noul questions have a fitted answer.
      async ask(state, questions) {
        buildRequest({ model, state, questions });
        const names = Object.keys(questions);
        if (names.some((n) => questions[n].kind !== "noul")) return { ok: false, error: "s1: stat answers noul questions only" };
        return { ok: true, backend, model, answers: Object.fromEntries(names.map((n) => [n, cfg.stat(state)])) };
      },
    };
  }
  const url = cfg.ai ? null : `${cfg.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  return {
    backend,
    model,
    // Invalid questions throw (caller bug). Any network, timeout or response failure returns
    // { ok: false, error } so the caller falls back to its safe default.
    async ask(state, questions) {
      const body = buildRequest({ model, state, questions });
      const headers = { "content-type": "application/json", ...cfg.access };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      try {
        let json;
        if (cfg.ai) {
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new DOMException("timeout", "TimeoutError")), timeoutMs));
          const input = !PROMPTED.includes(model) ? { model: backend, state, questions: toClef(questions) } : {
            messages: [{ role: "system", content: CLEF_PROMPT }, { role: "user", content: JSON.stringify(body) }],
            response_format: { type: "json_schema", json_schema: ANSWERS_SCHEMA },
          };
          const result = await Promise.race([cfg.ai.run(cfg.catalog, input, { gateway: cfg.gateway }), timeout]);
          const out = PROMPTED.includes(model) ? result?.response : result;
          json = typeof out === "string" ? JSON.parse(out) : out;
          if (!PROMPTED.includes(model)) json = json && { ...json, answers: fromClef(json.answers) };
        } else {
          const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) return { ok: false, error: `s1: http ${res.status}` };
          json = await res.json();
        }
        const answers = json && json.answers;
        if (!answers || typeof answers !== "object" || Object.keys(questions).some((n) => !(n in answers))) {
          return { ok: false, error: "s1: response missing answers" };
        }
        return { ok: true, backend, model, answers };
      } catch (err) {
        return { ok: false, error: `s1: ${err && err.name === "TimeoutError" ? "timeout" : `request failed: ${err?.message}`}` };
      }
    },
  };
}
