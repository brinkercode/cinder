import { validateSeedRun } from "../../../worker/src/api/contract.js";
import { postJson } from "../client.js";

// POST /api/admin/seed (reset, then reseed) or /api/admin/demo (the demo scenario) → {id}.
export const startSeed = (kind) => postJson(`/api/admin/${kind}`);

// GET /api/admin/seed/:id, fresh on every poll (fetchJson would serve the first answer from its cache).
export async function seedRun(id) {
  const path = `/api/admin/seed/${encodeURIComponent(id)}`;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const run = await res.json();
  const { ok, errors } = validateSeedRun(run);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return run;
}
