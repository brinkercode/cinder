import { CHANGE_STATES } from "../contract.js";
import { LEASE_MODES } from "./lease-map.js";

const str = (v) => typeof v === "string" && v.length > 0;
const prob = (v) => typeof v === "number" && v >= 0 && v <= 1;
const judge = (j) => str(j?.name) && Number.isInteger(j.count) && j.count >= 0;
const author = (x) => str(x.agent) && (x.ver === null || str(x.ver));
const range = (x) => Number.isInteger(x.from) && Number.isInteger(x.to) && x.from >= 1 && x.from <= x.to;

// The Code page: files with their symbols, per-line authorship and
// workspace text per change, the leases held on them and the changes that hold or touched them.
// Fixture-only until the worker serves it; ver is null for a person, a file's blame null until its blame job reports.
export function validateCodePage(v) {
  const errors = [];
  const check = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  const each = (arr, path, fn) => (Array.isArray(arr) ? arr.forEach((x, i) => fn(x ?? {}, `${path}[${i}]`)) : errors.push(`${path}: expected array`));
  const ids = new Set(Array.isArray(v?.changes) ? v.changes.map((c) => c?.id) : []);
  check(judge(v?.risk_judge), "risk_judge", "{ name, count }");
  check(v?.remote === undefined || v.remote === null || str(v.remote), "remote", "git URL string or null");
  each(v?.changes, "changes", (x, p) => {
    check(str(x.id) && str(x.intent) && author(x), p, "{ id, intent, agent, ver }");
    check(CHANGE_STATES.includes(x.state), `${p}.state`, "a change state");
  });
  each(v?.leases, "leases", (x, p) => {
    check(str(x.symbol) && str(x.file) && ids.has(x.holder), p, "{ symbol, file, holder } held by a listed change");
    check(LEASE_MODES.includes(x.mode), `${p}.mode`, `one of ${LEASE_MODES.join(", ")}`);
    check(Array.isArray(x.waiting) && x.waiting.every(str), `${p}.waiting`, "array of change ids");
  });
  each(v?.history, "history", (x, p) => {
    check(str(x.change) && str(x.sha) && str(x.age) && str(x.intent) && author(x), p, "{ change, sha, age, intent, agent, ver }");
    check(x.risk === null || prob(x.risk), `${p}.risk`, "null or number in [0, 1]");
  });
  each(v?.files, "files", (x, p) => {
    check(str(x.path) && typeof x.text === "string", p, "{ path, text }");
    check(x.ws && typeof x.ws === "object" && Object.values(x.ws).every((t) => typeof t === "string"), `${p}.ws`, "object of change id to text");
    each(x.syms, `${p}.syms`, (s, q) => check(str(s.name) && range(s), q, "{ name, from, to }"));
    if (x.blame !== null) each(x.blame, `${p}.blame`, (b, q) => check(range(b) && str(b.change) && author(b), q, "{ from, to, change, agent, ver }"));
  });
  return { ok: errors.length === 0, errors };
}
