import { validateRepairRound } from "../../../worker/src/api/contract.js";
import rounds from "../../../worker/src/api/fixtures/repair-rounds.json";
import { checked, fetchJson, fixtures } from "../client.js";

// GET /api/changes/:id/repairs → [RepairRound], oldest first. Fixture mode serves the one repairing fixture change's rounds.
export async function repairRounds(id) {
  const path = `/api/changes/${encodeURIComponent(id)}/repairs`;
  return checked(path, fixtures() ? rounds : await fetchJson(path), validateRepairRound);
}
