export const ROUTE_TARGETS = ["agent", "driver", "reviewer"];

const str = (v) => typeof v === "string" && v.trim() !== "";

// A repo's label routing (GET/PUT /api/repos/:name/routing): rules in order, each a label and exactly one of agent
// (an agent version that claims it), driver (a person who drives it) or reviewer (requested on its change).
export function validateLabelRouting(v) {
  const errors = [];
  if (!Array.isArray(v?.rules)) return { ok: false, errors: ["rules: expected an array"] };
  v.rules.forEach((r, i) => {
    const keys = Object.keys(r ?? {});
    if (!str(r?.label) || keys.length !== 2 || !keys.every((k) => k === "label" || (ROUTE_TARGETS.includes(k) && str(r[k])))) {
      errors.push(`rules[${i}]: expected a label and exactly one of ${ROUTE_TARGETS.join(", ")}`);
    }
  });
  return { ok: errors.length === 0, errors };
}
