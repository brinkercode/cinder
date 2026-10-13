import { personOf } from "./access.js";
import { flowFileErrors } from "./api/shapes/flow.js";
import { createArtifacts } from "./artifacts.js";
import { newChange } from "./changes.js";
import { isAllowedTarget } from "./policy.js";
import { error } from "./router.js";

const filled = (v) => typeof v === "string" && v !== "";
const systemEvent = (kind, action, id) => ({ kind, actor: { type: "system", id: "cinder" }, action, target: id, result: "ok", reason: kind });

// POST /api/repos/:name/changes/edit {target, path, base_sha, content, intent, choice?}: a person's edit becomes a change that
// leases the symbols the edit touches and queues a commit job writing content to path on the change's fork.
// A held symbol refuses the edit with the holder and CHOICES; resending with a choice stacks on the holder, shares the
// lease (parallel), or sends the edit to the holder's agent as a message.
// With change_id instead of target, the edit commits into that change's fork while the person drives it (takeover.js).
const CHOICES = ["stack", "parallel", "send"];

export async function editChange(request, env, { name }) {
  if (!(await env.CHANGE_LIMIT.limit({ key: `${personOf(request)} ${name}` })).success) return error(429, "rate_limited", `too many changes on ${name}; retry in a minute`);
  const { target: asked, path, base_sha: base, content, intent, change_id: changeId, choice } = (await request.json().catch(() => null)) ?? {};
  if (![changeId === undefined ? asked : changeId, path, base].every(filled) || typeof content !== "string" || typeof intent !== "string" || !intent.trim()) {
    return error(400, "bad_request", "body must be {target or change_id, path, base_sha, content, intent} with non-empty target or change_id, path, base_sha and intent");
  }
  const invalid = flowFileErrors(path, content);
  if (invalid.length) return error(400, "invalid_flow", invalid.join("; "));
  if (choice !== undefined && !CHOICES.includes(choice)) return error(400, "bad_request", `choice must be one of ${CHOICES.join(", ")}`);
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const held = changeId === undefined ? null : await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(changeId)).get();
  if (changeId !== undefined && held?.repo_id !== repo.id) return error(404, "not_found", `no change ${changeId} in ${name}`);
  if (held && held.driver !== personOf(request)) return error(409, "not_driving", `take over ${changeId} before editing its workspace`);
  const target = held?.target_branch ?? asked;
  const store = held?.fork ?? name;
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  if (!held && !isAllowedTarget(await repoDO.policy(name, repo.default_branch), target)) {
    return error(422, "target_not_allowed", `branch policy does not allow target ${target}`);
  }
  const artifacts = createArtifacts(env.ARTIFACTS);
  const log = await artifacts.log(store, target);
  const head = log[0]?.sha;
  if (!head) return error(404, "not_found", `unknown target ${target}`);
  const current = await artifacts.readFile(store, head, path);
  // Stale when base isn't on the target, or the file changed since base; edits elsewhere in the repo don't matter.
  if (!log.some((c) => c.sha === base) || (base !== head && (await artifacts.readFile(store, base, path)) !== current)) {
    return Response.json({ error: { code: "stale_base", message: `${path} changed since ${base}` }, current_sha: head }, { status: 409 });
  }

  // The base lines the edit changed (common prefix and suffix trimmed); a pure insertion touches the line it lands on.
  const before = current?.split("\n") ?? [];
  const after = content.split("\n");
  let top = 0;
  while (top < before.length && top < after.length && before[top] === after[top]) top++;
  if (current !== null && top === before.length && top === after.length) return error(400, "bad_request", "the edit changes nothing");
  const queueCommit = (id, lease, extra) => env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'commit', ?, 'queued', ?, ?)")
    .bind(crypto.randomUUID(), repo.id, id, new Date().toISOString(), JSON.stringify({ lease, path, content, base_sha: base, ...extra })).run();
  // The driven change already holds its leases; the edit adds none.
  if (held) {
    await queueCommit(held.id, []);
    return Response.json({ ...held, events: undefined });
  }
  let tail = 0;
  while (tail < before.length - top && tail < after.length - top && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT name FROM symbols WHERE repo_id = ? AND sha = ? AND path = ? AND start_line <= ? AND end_line >= ? ORDER BY name",
  ).bind(repo.id, head, path, Math.max(top + 1, before.length - tail), top + 1).all();
  const symbols = results.map((s) => `${path}#${s.name}`);

  const change = await newChange(env, name, repo.id, intent, target, [], "change", { type: "human", id: personOf(request) });
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  const leased = await stub.transition("leased", systemEvent("leased", "change.lease", change.id), {}, "planned");
  const { overlaps } = await repoDO.grant(target, change.id, symbols, choice === "parallel" ? symbols : []);
  const holder = overlaps?.[0];
  let result = leased;
  if (holder && choice === "stack") {
    result = await stub.transition("waiting", systemEvent("stacked", "change.lease", change.id), { stacked_on: holder });
  } else if (holder) {
    await stub.transition("closed", systemEvent("lease_held", "change.close", change.id));
    if (choice === "send") {
      await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(holder)).addMessage({
        text: `${intent}\n\n${path}:\n${content}`, by: personOf(request), at: new Date().toISOString(),
      });
      return Response.json({ holder }, { status: 202 });
    }
    return Response.json({ error: { code: "lease_held", message: `the edit touches symbols leased by ${overlaps.join(", ")}` }, holder, choices: CHOICES }, { status: 409 });
  }
  await queueCommit(change.id, symbols, holder && { wait_for: holder });
  return Response.json(result, { status: 201 });
}
