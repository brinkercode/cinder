import { channelAgent } from "./canary.js";
import { newChange } from "./changes.js";
import { schedule } from "./scheduler.js";

// lazy: fixed until seam judgments are calibrated per repo; then derive it from the judge's reliability.
export const SEAM_THRESHOLD = 0.7;
export const SEAM_QUESTIONS = { seam: { kind: "noul", prompt: "Is the overlap a shared interface the intents both need changed?",
  guide: "Two planned changes leased the same symbols. The state holds both intents and the symbols they share. Answer yes when both intents " +
    "need the same change to these symbols' interface (a new parameter, field, return shape or exported helper), so landing that shared piece " +
    "first lets each build on it without a conflict. Answer no when they edit the same code for unrelated reasons, or one only reads it: those " +
    "are stacked instead." } };

// Starts the seam change for a proposal: the leased dependents wait stacked on it, giving up their leases so the seam
// takes the shared symbols. They start on its fork head once it pushes and converge onto the target once it merges
// (scheduler.js). A dependent that already started keeps its lease and is left alone. Returns the seam change.
export async function startSeam(env, repo, target, proposal) {
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(repo.name));
  const stubs = proposal.changes.map((id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)));
  const intents = (await Promise.all(stubs.map((s) => s.get()))).filter(Boolean).map((c) => `- ${c.intent}`).join("\n");
  // Written by developer's version for its id, as any agent change is (createChange), not the harness default.
  const id = crypto.randomUUID();
  const { agent_version: agent } = await channelAgent(env, "develop", id);
  const seam = await newChange(env, repo.name, repo.id,
    `Seam: ${proposal.symbols.join(", ")}\n\nChange only signatures, types or schema plus stubs, with tests, for:\n${intents}`, target, [], "seam",
    undefined, false, { id, ...(agent && { agent_version: agent }) });
  // The seam's jobs record its first dependent's requester that has one (migrations/202610072200_job_requesters.sql).
  await env.DB.prepare("INSERT INTO change_requesters SELECT ?, person FROM change_requesters WHERE change_id IN (?, ?) ORDER BY change_id = ? DESC LIMIT 1")
    .bind(seam.id, ...proposal.changes, proposal.changes[0]).run();
  for (const [i, id] of proposal.changes.entries()) {
    if (!(await stubs[i].transition("waiting", {
      kind: "stacked", actor: { type: "system", id: "cinder" }, action: "change.lease", target: id, result: "ok", reason: "seam",
    }, { stacked_on: seam.id }, "leased"))) continue;
    await repoDO.release(target, id);
    await env.DB.prepare("UPDATE jobs SET payload = json_set(payload, '$.wait_for', ?, '$.shared', json(?)) WHERE change_id = ? AND kind = 'develop' AND status = 'queued'")
      .bind(seam.id, JSON.stringify(proposal.symbols), id).run();
  }
  return schedule(env, seam.id, proposal.symbols);
}
