import { CHANGE_STATES } from "../contract.js";

// A converge job's payload. theirs are the changes it converges onto, each with its intent for a later resolve.
// base, when set, is a stacked base's fork head to converge onto instead of the target. runner/internal/api decodes it.
export function validateConvergePayload(v) {
  const errors = [];
  const str = (x) => typeof x === "string" && x.length > 0;
  if (!str(v?.target)) errors.push("target: expected non-empty string");
  if (!CHANGE_STATES.includes(v?.return_to)) errors.push(`return_to: expected one of ${CHANGE_STATES.join(", ")}`);
  if (!Array.isArray(v?.theirs)) errors.push("theirs: expected list");
  else v.theirs.forEach((t, i) => {
    if (!str(t?.id)) errors.push(`theirs.${i}.id: expected non-empty string`);
    if (typeof t?.intent !== "string") errors.push(`theirs.${i}.intent: expected string`);
  });
  if (v?.base != null && !(str(v.base.fork) && str(v.base.sha))) errors.push("base: expected null or { fork, sha }");
  return { ok: errors.length === 0, errors };
}
