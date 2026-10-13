// GET /api/keystore: a keystore entry's metadata. Never the value, the iv or the ciphertext.
const KEYS = ["id", "name", "kind", "scope", "repo", "environment", "flow", "owner", "expires_at", "created_at", "rotated_at", "last_used", "changed_by"];

export function validateKeystoreSecret(v) {
  const errors = [];
  for (const k of ["id", "name", "kind", "scope", "owner", "created_at"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  for (const k of ["repo", "environment", "flow", "expires_at", "rotated_at", "last_used", "changed_by"]) if (v?.[k] !== null && typeof v?.[k] !== "string") errors.push(`${k}: expected string or null`);
  if (v && Object.keys(v).some((k) => !KEYS.includes(k))) errors.push(`expected only ${KEYS.join(", ")}`);
  return { ok: errors.length === 0, errors };
}

// GET /api/keystore/usage: the account's Secrets Store secrets against its cap.
export function validateKeystoreUsage(v) {
  const errors = ["used", "limit"].filter((k) => !Number.isInteger(v?.[k]) || v[k] < 0).map((k) => `${k}: expected integer >= 0`);
  return { ok: errors.length === 0, errors };
}

// GET /api/keystore: {secrets: KeystoreSecret[], wanted}, wanted being each secret a flow run's failed step reported
// missing that no saved secret covers, with the repo, flow, step and run that asked for it.
const WANTED = ["name", "repo", "flow", "step", "run_id"];
export function validateKeystore(v) {
  const errors = [];
  if (!Array.isArray(v?.secrets) || !Array.isArray(v?.wanted)) return { ok: false, errors: ["expected {secrets: [], wanted: []}"] };
  v.secrets.forEach((s, i) => errors.push(...validateKeystoreSecret(s).errors.map((e) => `secrets[${i}].${e}`)));
  v.wanted.forEach((w, i) => {
    for (const k of WANTED) if (typeof w?.[k] !== "string" || !w[k]) errors.push(`wanted[${i}].${k}: expected non-empty string`);
  });
  return { ok: errors.length === 0, errors };
}
