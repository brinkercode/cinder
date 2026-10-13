// GET /api/marketplace returns an array of these: a bundled or published agent template. Any other key fails, so a
// listing can never carry the publisher's secrets, model keys or changes.
const count = (v) => Number.isInteger(v) && v >= 0;
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
const KEYS = ["name", "source", "description", "publisher", "harness", "model", "tools", "egress", "versions", "wins", "races", "installs", "tokens_per_merge", "visibility", "mine"];

export function validateCatalogEntry(v) {
  const errors = [];
  for (const k of ["name", "description", "publisher", "harness", "model"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  if (!["bundled", "published"].includes(v?.source)) errors.push("source: expected bundled or published");
  if (!strings(v?.tools) || !strings(v?.egress)) errors.push("tools and egress: expected string arrays");
  if (!Array.isArray(v?.versions) || !v.versions.length || !v.versions.every((n) => Number.isInteger(n) && n >= 1)) errors.push("versions: expected non-empty array of integers >= 1");
  if (!count(v?.wins) || !count(v?.races) || !count(v?.installs)) errors.push("wins, races and installs: expected integers >= 0");
  if (!(v?.tokens_per_merge === null || count(v?.tokens_per_merge))) errors.push("tokens_per_merge: expected null or integer >= 0");
  if (!(v?.visibility === null || ["organization", "instance"].includes(v?.visibility))) errors.push("visibility: expected null, organization or instance");
  if (typeof v?.mine !== "boolean") errors.push("mine: expected boolean");
  for (const k of Object.keys(v ?? {})) if (!KEYS.includes(k)) errors.push(`${k}: not a catalog field`);
  return { ok: errors.length === 0, errors };
}
