const LANE = { draft: "progress", planned: "progress", leased: "verify", waiting: "verify", developing: "verify", converging: "verify",
  verifying: "verify", resolving: "verify", needs_fix: "review", in_queue: "queue", merged: "merged", conflict: "verify", failed: "verify" };

// An agent change between a failed check and the verdict on its fix; repairing is part of verifying.
export const repairing = (c) => Boolean(c.repair) && !c.repair.passed && !c.driver && ["needs_fix", "developing", "verifying"].includes(c.state);

// A change decides the lane of its issue. A verifying change routed to a person awaits approval, so it is in review;
// merged ones older than a day, closed changes and closed issues are off the board (null). An issue's change before
// verify is still the claimed intent in progress until its first commit (head_sha) lands; from then it is verifying.
export function laneOf(issue, change) {
  if (!change) return issue?.state === "open" ? "intent" : null;
  if (issue && ["planned", "leased", "waiting", "developing"].includes(change.state)) return change.head_sha ? "verify" : "progress";
  if (change.state === "verifying" && change.review?.route === "human") return "review";
  if (repairing(change)) return "verify";
  if (change.state === "merged" && Date.now() - Date.parse(change.updated_at) > 864e5) return null;
  return LANE[change.state] ?? null;
}
