// GET /api/account (src/overview.js): the monthly agent-token budget (null: none), this month's model spend, whether
// agent work is paused because spend reached the budget, what happens when it does (when_reached), when the month
// resets and the owners who can raise it.
export const WHEN_REACHED = ["pause", "alert"];

export function validateAccount(v) {
  const errors = [];
  if (!(v?.budget_tokens === null || (Number.isInteger(v?.budget_tokens) && v.budget_tokens > 0))) errors.push("budget_tokens: expected null or integer > 0");
  if (!(Number.isInteger(v?.spent) && v.spent >= 0)) errors.push("spent: expected integer >= 0");
  if (typeof v?.paused !== "boolean") errors.push("paused: expected boolean");
  if (!WHEN_REACHED.includes(v?.when_reached)) errors.push(`when_reached: expected one of ${WHEN_REACHED.join(", ")}`);
  if (Number.isNaN(Date.parse(v?.resets_at))) errors.push("resets_at: expected ISO timestamp");
  if (!(Array.isArray(v?.owners) && v.owners.every((o) => typeof o === "string" && o.length > 0))) errors.push("owners: expected array of non-empty strings");
  return { ok: errors.length === 0, errors };
}
