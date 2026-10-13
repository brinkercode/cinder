// An A/B race: two to four agent versions on the same intent.
const str = (v) => typeof v === "string" && v.length > 0;
const count = (v) => Number.isInteger(v) && v >= 0;

function legErrors(l, path) {
  const errors = [];
  const need = (ok, k, desc) => { if (!ok) errors.push(`${path}.${k}: expected ${desc}`); };
  need(str(l?.agent), "agent", "non-empty string");
  need(str(l?.ver), "ver", "non-empty string");
  need(["stable", "canary"].includes(l?.channel), "channel", "one of stable, canary");
  need(["pass", "fail"].includes(l?.verdict), "verdict", "one of pass, fail");
  need(Array.isArray(l?.tok) && l.tok.length === 3 && l.tok.every(count), "tok", "[in, out, cache] integers >= 0");
  for (const k of ["secs", "adds", "dels", "files"]) need(count(l?.[k]), k, "integer >= 0");
  need(typeof l?.risk === "number" && l.risk >= 0 && l.risk <= 1, "risk", "number in [0, 1]");
  return errors;
}

export function validateRace(v) {
  const errors = [];
  const need = (ok, k, desc) => { if (!ok) errors.push(`${k}: expected ${desc}`); };
  for (const k of ["id", "change_id", "repo_id", "intent", "target_branch"]) need(str(v?.[k]), k, "non-empty string");
  need(str(v?.judge?.name) && count(v.judge.count), "judge", "{ name, count } of the risk judge");
  need(Array.isArray(v?.legs) && v.legs.length >= 2 && v.legs.length <= 4, "legs", "array of 2 to 4 legs");
  if (Array.isArray(v?.legs)) v.legs.forEach((l, i) => errors.push(...legErrors(l, `legs[${i}]`)));
  return { ok: errors.length === 0, errors };
}
