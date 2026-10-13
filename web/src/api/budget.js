import { validateAccount, validateFleet } from "../../../worker/src/api/contract.js";
import { fetchJson, fixtures, get } from "../client.js";

const check = (path, body, validate) => {
  const { ok, errors } = validate(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
};

// GET /api/account → Account: the budget, its spend, the when-reached policy and the owners who can raise it.
export const getAccount = async () => check("/api/account", fixtures()
  ? { budget_tokens: null, spent: 0, paused: false, when_reached: "pause", resets_at: "2026-11-01T00:00:00.000Z", owners: [] }
  : await fetchJson("/api/account"), validateAccount);

// The budget, whether the caller is an owner and the agents the budget pauses (GET /api/fleet).
export async function budgetState() {
  const [account, me, fleet] = await Promise.all([getAccount(), get("/api/me"), fixtures() ? { canary_auto_promote: false, agents: [] } : fetchJson("/api/fleet")]);
  return { account, owner: me.owner, paused: check("/api/fleet", fleet, validateFleet).agents.filter((a) => a.paused).map((a) => a.name) };
}
