// GET /api/races: one race per item, its scorecard legs plus the winning leg's name (null until decided).
import { validateRaceScorecard } from "./race-scorecard.js";

export function validateRaceSummary(v) {
  const { errors } = validateRaceScorecard(v);
  const won = Array.isArray(v?.legs) ? v.legs.filter((l) => l?.won === 1).map((l) => l.leg) : [];
  if (v?.winner !== (won[0] ?? null) || won.length > 1) errors.push("winner: expected the one won leg's name, or null");
  return { ok: errors.length === 0, errors };
}
