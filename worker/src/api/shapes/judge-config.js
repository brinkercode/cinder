import { JUDGMENT_KINDS } from "../contract.js";

// A configured judge's own settings (judge_config): GET /api/repos/:name/judges sends it as a judge's `config` when the
// series is the one the kind runs now, and PUT /api/repos/:name/judges/:kind/airlock returns it. airlock: it scores, but
// its verdict doesn't count. min_outcomes: its trust threshold, null for the repo's. min_confidence: below it, it abstains.
export function validateJudgeConfig(v) {
  const errors = [];
  if (!JUDGMENT_KINDS.includes(v?.kind)) errors.push(`kind: expected one of ${JUDGMENT_KINDS.join(", ")}`);
  if (typeof v?.airlock !== "boolean") errors.push("airlock: expected boolean");
  if (v?.min_outcomes !== null && !(Number.isInteger(v?.min_outcomes) && v.min_outcomes >= 1)) errors.push("min_outcomes: expected integer >= 1 or null");
  if (v?.min_confidence !== null && !(typeof v?.min_confidence === "number" && v.min_confidence >= 0 && v.min_confidence <= 1)) errors.push("min_confidence: expected 0..1 or null");
  return { ok: errors.length === 0, errors };
}
