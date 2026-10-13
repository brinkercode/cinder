// The Agents page lists these (design/proto/data.js C.AGENTS). config holds the editable settings of the
// stable version (and the canary, when there is one), keyed by version; the editor diffs a draft against stable.
export const AGENT_ENTRY_CHANNELS = ["stable", "canary", "retired"];

const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const count = (v) => Number.isInteger(v) && v >= 0;
const strings = (v) => Array.isArray(v) && v.every(nonEmpty);

export function validateAgentEntry(v) {
  const errors = [];
  for (const k of ["name", "role"]) if (!nonEmpty(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!Array.isArray(v?.versions) || !v.versions.length) errors.push("versions: expected array with at least 1 item(s)");
  else v.versions.forEach((x, i) => {
    if (!/^\d+\.\d+\.\d+$/.test(x?.version) || !nonEmpty(x?.model)) errors.push(`versions[${i}]: expected a MAJOR.MINOR.PATCH version and a model`);
    if (!AGENT_ENTRY_CHANNELS.includes(x?.channel)) errors.push(`versions[${i}].channel: expected one of ${AGENT_ENTRY_CHANNELS.join(", ")}`);
    if (Number.isNaN(Date.parse(x?.released_at))) errors.push(`versions[${i}].released_at: expected ISO timestamp`);
    if (!(x?.wins === null || count(x?.wins)) || !count(x?.races) || !count(x?.active)) errors.push(`versions[${i}]: wins (or null), races and active must be integers >= 0`);
  });
  const stable = v?.versions?.find?.((x) => x?.channel === "stable");
  if (!stable) errors.push("versions: expected a stable version");
  else if (!v?.config?.[stable.version]) errors.push(`config.${stable.version}: required for the stable version`);
  for (const [ver, c] of Object.entries(v?.config ?? {})) {
    if (!nonEmpty(c?.model) || typeof c?.prompt !== "string") errors.push(`config.${ver}: expected model and prompt strings`);
    if (!strings(c?.tools) || !strings(c?.egress)) errors.push(`config.${ver}: tools and egress must be string arrays`);
    for (const k of ["max_output_tokens", "token_budget", "max_parallel"]) if (!(Number.isInteger(c?.[k]) && c[k] >= 1)) errors.push(`config.${ver}.${k}: expected integer >= 1`);
  }
  if (!Array.isArray(v?.races)) errors.push("races: expected array");
  else v.races.forEach((r, i) => {
    if (![r?.id, r?.change_id, r?.intent].every(nonEmpty) || !strings(r?.legs)) errors.push(`races[${i}]: expected id, change_id, intent and legs`);
  });
  return { ok: errors.length === 0, errors };
}
