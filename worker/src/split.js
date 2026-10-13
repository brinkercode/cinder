import { newChange } from "./changes.js";
import { judge } from "./judgments.js";

const SPLIT_QUESTIONS = { mixed: { kind: "noul", prompt: "Does this intent ask for more than one independent change?",
  guide: "The state holds one intent, as a person filed it. Answer yes when it asks for two or more changes that could each ship, be reviewed " +
    "and be reverted on their own, such as \"add retries and rename the config file\". Answer no for one behaviour together with its tests, docs " +
    "or the refactor it needs, and for a list of steps that only make sense together." } };

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));

// At planning. Recorded as kind split on the change; only a trusted yes proposes a split, otherwise the change runs whole.
// Either way the answer is scored: "yes" when the change is split (acceptSplit), "no" when it merges whole (scoreMerge).
export async function judgeIntentSplit(env, change) {
  const { mixed } = await judge(env, change.repo_id, "split", { intent: change.intent }, SPLIT_QUESTIONS, change.id);
  if (mixed.trusted && mixed.answer === "yes") await changeDO(env, change.id).proposeSplit({ reason: "mixed", p: mixed.p });
  return mixed;
}

// The owner accepted the ordered sub-intents: one change per sub-intent, each stacked on
// the one before, waiting until it pushes (scheduler.js unblock). The first plans as usual; the split change is closed.
// lazy: stacked parts carry no lease until System 1 predicts their symbols; lease them at planning once it does.
export async function acceptSplit(env, change, intents) {
  if (!Array.isArray(intents) || intents.length < 2 || !intents.every((i) => typeof i === "string" && i.trim())) {
    throw new Error("a split needs at least two non-empty sub-intents");
  }
  const repo = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first();
  const event = (kind, action, id) => ({ kind, actor: { type: "system", id: "cinder" }, action, target: id, result: "ok", reason: "split" });
  const pin = change.agent_version && { agent_version: change.agent_version };
  const parts = [];
  for (const intent of intents) {
    const part = await newChange(env, repo.name, change.repo_id, intent, change.target_branch, [], "change", undefined, false, pin || {});
    // Before its jobs are queued, so they record the split change's requester (migrations/202610072200_job_requesters.sql).
    await env.DB.prepare("INSERT INTO change_requesters SELECT ?, person FROM change_requesters WHERE change_id = ?").bind(part.id, change.id).run();
    const prev = parts.at(-1);
    if (prev) {
      const stub = changeDO(env, part.id);
      await stub.transition("leased", event("leased", "change.lease", part.id));
      await stub.transition("waiting", event("stacked", "change.lease", part.id), { stacked_on: prev.id });
      await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, ?)")
        .bind(crypto.randomUUID(), change.repo_id, part.id, new Date().toISOString(), JSON.stringify({ lease: [], wait_for: prev.id, base: null, ...(pin && { agent: pin.agent_version }) })).run();
    }
    parts.push(part);
  }
  await env.DB.prepare("INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, 'yes', answer = 'yes', ? FROM judgments " +
    "WHERE change_id = ? AND kind = 'split' AND id NOT IN (SELECT judgment_id FROM outcomes)").bind(new Date().toISOString(), change.id).run();
  await changeDO(env, change.id).transition("closed", event("closed", "change.close", change.id));
  return Promise.all(parts.map((p) => changeDO(env, p.id).get()));
}
