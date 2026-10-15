// Consumer for the cinder-events Queue: cf.artifacts.repo.pushed events, payload {ref, before, after, commits}.
// A fork push (a changes.fork) moves the change's head and queues a guard job. A push to a target repo
// with no claimed merge job for that branch is recorded as unexpected_target_push; one to a protected target (the default
// branch or a policy target) that cinder didn't write is also rolled back, except the first push that creates the default branch. A push to refs/for/<target> in the base repo
// by a person holding its Git credentials, creates a change driven by that person and verifies it.
// A person's push to the head branch of their open change copies it into the change's fork and re-verifies it.
import { byOwnerToken, groupsOf, isOwnerEmail, personOf } from "./access.js";
import { AGENTS_REPO } from "./agents.js";
import { validateAgentVersion } from "./api/contract.js";
import { createArtifacts } from "./artifacts.js";
import { REVERIFY, newChange, verifyHead } from "./changes.js";
import { indexCode } from "./code.js";
import { modelHarnesses } from "./fleet.js";
import { enqueueFlows } from "./flows.js";
import { isAllowedTarget, refreshPolicy } from "./policy.js";
import { error } from "./router.js";
import { copyRef, listRefs, moveRef } from "./git/index.js";
import { can } from "./people.js";
import { remapThreads } from "./threads.js";

// Long enough for one git push; the person asks again for the next.
const PUSH_TOKEN_TTL_SECONDS = 600;

// POST /api/repos/:name/git-credentials → {remote, token, expires_at}: a write token for name itself, used by git as the
// HTTP Basic password (any username). Only owners and people whose roles grant repo.write on name; onPushes, not the
// token, keeps protected targets to changes. Only the CLI (bearer or service token) gets one: a browser, signed in by the
// Access cookie, never holds an Artifacts token. Access passes its cookie on to token callers too, so the caller's
// verified identity decides: the OWNER_TOKEN or an allowlisted service token is the CLI, a person's email is not.
export async function createGitCredentials(request, env, { name }) {
  const person = personOf(request);
  if (/(?:^|;\s*)CF_Authorization=/.test(request.headers.get("Cookie") ?? "") && !byOwnerToken(request) && !person.endsWith("@service-token")) {
    return error(403, "cli_only", `git credentials are issued only to the cinder CLI: run cinder repo credentials ${name}`);
  }
  if (person !== "owner" && !isOwnerEmail(env, person) && !(await can(env, person, request.method, new URL(request.url).pathname, null, groupsOf(request)))) {
    return error(403, "forbidden", `you need write access to ${name} to get git credentials`);
  }
  const repo = await env.DB.prepare("SELECT EXISTS (SELECT 1 FROM repo_meta m WHERE m.repo_id = repos.id AND m.archived_at IS NOT NULL) AS archived FROM repos WHERE name = ?")
    .bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  if (repo.archived) return error(409, "archived", `${name} is archived; unarchive it to push`);
  const artifacts = createArtifacts(env.ARTIFACTS);
  const cap = await artifacts.get(name);
  if (!cap) return error(404, "not_found", `no repo ${name}`);
  const { token, expiresAt } = await artifacts.createToken(name, "write", PUSH_TOKEN_TTL_SECONDS);
  // fork holds the base repo's name here: onPushes attributes a refs/for push on name to this person.
  await env.DB.prepare("INSERT INTO push_tokens (id, fork, person, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), name, person, expiresAt, new Date().toISOString()).run();
  return Response.json({ remote: (await cap.info()).remote, token, expires_at: expiresAt });
}

// Unreadable flows are logged, not thrown: throwing retries the whole batch and repeats its guard jobs.
const flowsFailed = (e) => console.error(`flows: ${e.message}`);

export async function onPushes(batch, env) {
  for (const { body } of batch.messages) {
    // A malformed event is skipped, not thrown: throwing retries the whole batch and repeats its guard jobs.
    if (body?.type !== "cf.artifacts.repo.pushed" || typeof body.payload?.after !== "string" || !body.payload.after || typeof body.source?.repoName !== "string") continue;
    const { ref, before, after } = body.payload;
    const repo = body.source.repoName;
    // The Code API's cached ref heads of this store (code.js resolve).
    await env.REPO_DO.get(env.REPO_DO.idFromName(repo)).dropHeads();
    const at = new Date().toISOString();
    const tag = repo === AGENTS_REPO && /^refs\/tags\/agent\/([a-z0-9-]{1,63})\/v([1-9]\d*)$/.exec(ref ?? "");
    if (tag) {
      // The release commit's message is the tag's lock (runner release.go); the event carries commit messages, not tag messages.
      let lock = null;
      try {
        lock = JSON.parse(body.payload.commits?.at(-1)?.message ?? "null");
      } catch {
        // not a lock: skipped below
      }
      // An older runner writes an agent with no tools as tools: null; it means none.
      if (lock?.tools === null) lock.tools = [];
      const [name, version] = [tag[1], Number(tag[2])];
      const egress = lock?.egress ?? [];
      if (lock?.name !== name || lock?.version !== version || !validateAgentVersion({ ...lock, id: `agent/${name}/v${version}` }).ok ||
        !Array.isArray(egress) || !egress.every((h) => typeof h === "string" && h)) continue;
      // Only a tag cinder wrote (a ref_writes marker) or one pushed while a release job of name holds its lease is a release.
      // A report leaves the lease set, so an event arriving after the job reported still counts.
      const written = await env.DB.prepare("SELECT 1 FROM ref_writes WHERE repo = ?1 AND ref = ?2 AND sha = ?3 UNION ALL SELECT 1 FROM jobs " +
        "WHERE kind = 'release' AND json_extract(payload, '$.name') = ?4 AND status IN ('claimed', 'done') AND lease_expires_at > ?5").bind(repo, ref, after, name, at).first();
      if (!written) continue;
      // A version whose model its harness can't run is refused, not recorded: the repo's live feed gets the reason.
      if (!modelHarnesses(lock.model).includes(lock.harness)) {
        await env.REPO_DO.get(env.REPO_DO.idFromName(repo)).broadcast({ kind: "agent.tag_refused", ref, sha: after, reason: "model_not_for_harness",
          harness: lock.harness, model: lock.model, at });
        continue;
      }
      // Idempotent on re-delivery: every insert keeps the first; only an agent's first release points canary at it.
      await env.DB.batch([
        env.DB.prepare("INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .bind(`agent/${name}/v${version}`, name, version, lock.harness, lock.model, lock.effort, lock.prompt_hash, JSON.stringify(lock.tools), JSON.stringify(lock.limits)),
        env.DB.prepare("INSERT INTO agent_releases (name, version, egress, released_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .bind(name, version, JSON.stringify(egress), at),
        // The channel the newest release job of name picked, applied only by the push that first recorded this version (its released_at).
        env.DB.prepare("INSERT INTO channels (agent_name, channel, version) SELECT ?1, json_extract(payload, '$.channel'), ?2 FROM jobs " +
          "WHERE json_extract(payload, '$.channel') IS NOT NULL AND EXISTS (SELECT 1 FROM agent_releases WHERE name = ?1 AND version = ?2 AND released_at = ?3) " +
          "AND rowid = (SELECT MAX(rowid) FROM jobs WHERE kind = 'release' AND json_extract(payload, '$.name') = ?1) " +
          "ON CONFLICT (agent_name, channel) DO UPDATE SET version = ?2").bind(name, version, at),
        env.DB.prepare("INSERT INTO agent_release_egress_mode (name, version, egress_mode) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
          .bind(name, version, lock.egress_mode === "audit" ? "audit" : "enforce"),
        env.DB.prepare("INSERT INTO agent_release_web (name, version, web) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
          .bind(name, version, lock.web === "raw" ? "raw" : "markdown"),
        env.DB.prepare("INSERT INTO agent_release_prompts (name, version, prompt) SELECT ?, ?, ? WHERE ?3 IS NOT NULL ON CONFLICT DO NOTHING")
          .bind(name, version, typeof lock.prompt === "string" ? lock.prompt : null),
        env.DB.prepare("INSERT INTO channels (agent_name, channel, version) SELECT ?1, 'canary', ?2 WHERE (SELECT COUNT(*) FROM agent_versions WHERE name = ?1) = 1 ON CONFLICT DO NOTHING")
          .bind(name, version),
      ]);
      continue;
    }
    // cinder's own branch writes (git/index.js) leave a marker, kept so a redelivered event is still known as cinder's.
    // lazy: markers are never pruned, so a person may move a branch back to a sha cinder once wrote there; prune by age once it matters.
    const ours = await env.DB.prepare("SELECT 1 FROM ref_writes WHERE repo = ? AND ref = ? AND sha = ?").bind(repo, ref ?? "", after).first();
    const own = ref?.startsWith("refs/for/") ? await env.DB.prepare(
      // The event names no pusher: the person is known only while one person holds live credentials for the repo.
      "SELECT min(t.person) AS person, count(DISTINCT t.person) AS people, r.id AS repo_id, r.name, r.default_branch FROM push_tokens t JOIN repos r ON r.name = t.fork " +
      "WHERE t.fork = ? AND t.expires_at > ? AND NOT EXISTS (SELECT 1 FROM repo_meta m WHERE m.repo_id = r.id AND m.archived_at IS NOT NULL) GROUP BY r.id",
    ).bind(repo, at).first() : null;
    if (own) {
      // cinder's own delete of the ref (reverify) opens nothing.
      if (/^0+$/.test(after)) continue;
      // An unknown pusher opens no change; the ref is deleted so the next push to it is a new ref.
      if (own.people > 1) {
        console.warn(`push: ${ref} of ${repo} opens no change: ${own.people} people hold live credentials, so the pusher is unknown`);
        await moveRef(await createArtifacts(env.ARTIFACTS).get(repo), ref, after, "0".repeat(40))
          .catch((e) => console.error(`push: deleting ${ref} of ${repo} failed: ${e.message}`));
        continue;
      }
      const branch = ref.slice("refs/for/".length);
      const policy = branch && await env.REPO_DO.get(env.REPO_DO.idFromName(own.name)).policy(own.name, own.default_branch);
      if (!policy || !isAllowedTarget(policy, branch)) continue;
      // A redelivered event, or the same commit pushed again, makes no second change.
      const seen = await env.DB.prepare("SELECT 1 FROM changes c JOIN change_heads h ON h.change_id = c.id WHERE c.repo_id = ? AND c.target_branch = ? AND h.head_sha = ?")
        .bind(own.repo_id, branch, after).first();
      if (seen) continue;
      // The head commit's message is the intent (its subject the title): from the event, else the log; a failed read falls back.
      let message = [].concat(body.payload.commits ?? []).find((c) => c?.id === after)?.message;
      if (typeof message !== "string" || !message.trim()) {
        const [head] = await createArtifacts(env.ARTIFACTS).log(repo, after)
          .catch((e) => (console.error(`push: reading ${after} of ${repo} failed: ${e.message}`), []));
        message = head?.sha === after ? head.message : null;
      }
      // The pusher drives it: their commit is verified, no agent develops it.
      const change = await newChange(env, own.name, own.repo_id, (typeof message === "string" && message.trim()) || `Pushed ${after} to ${ref}`, branch, [], "change", { type: "human", id: own.person }, false,
        { head_branch: ref, driver: own.person });
      await reverify(env, change, repo, ref, after);
      continue;
    }
    const forked = await env.DB.prepare("SELECT c.id, c.repo_id, r.name FROM change_numbers n JOIN changes c ON c.id = n.change_id JOIN repos r ON r.id = c.repo_id WHERE n.fork = ?").bind(repo).first();
    if (forked) {
      const change = forked;
      await env.DB.batch([
        env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?1, ?2) ON CONFLICT DO UPDATE SET head_sha = ?2").bind(change.id, after),
        env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'guard', ?, 'queued', ?, ?)")
          .bind(crypto.randomUUID(), change.repo_id, change.id, at, JSON.stringify({ fork: repo, ref, before, after })),
        // The push of a claimed commit job is the commit of the suggestion it applies.
        env.DB.prepare("INSERT OR REPLACE INTO review_thread_applied SELECT json_extract(payload, '$.thread'), ?1 FROM jobs WHERE change_id = ?2 AND kind = 'commit' AND status = 'claimed' AND json_extract(payload, '$.thread') IS NOT NULL")
          .bind(after, change.id),
      ]);
      await remapThreads(env, change.id, repo, after);
      await enqueueFlows(env, { id: change.repo_id, name: forked.name }, repo, after, "change", after,
        { change_id: change.id, ref: ref?.replace(/^refs\/heads\//, "") ?? null }).catch(flowsFailed);
      if (ref?.startsWith("refs/heads/")) await indexCode(env, repo, ref.slice("refs/heads/".length), after);
      const event = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).stageEvent({
        kind: "pushed", actor: { type: "system", id: "artifacts" }, action: "change.push", target: after, result: "ok",
      }, { head: after });
      await env.REPO_DO.get(env.REPO_DO.idFromName(forked.name)).broadcast(event);
      continue;
    }
    // History jobs write refs/cinder/changes/<id>; only branch moves are unexpected.
    if (ref?.startsWith("refs/cinder/")) continue;
    const target = await env.DB.prepare("SELECT id, name, default_branch, " +
      "EXISTS (SELECT 1 FROM repo_meta m WHERE m.repo_id = repos.id AND m.archived_at IS NOT NULL) AS archived FROM repos WHERE name = ?").bind(repo).first();
    if (!target) continue;
    // A merge running for this branch that pushed this sha, or one that landed it (a redelivered event). A running merge's
    // sha is known only at its report, so its commit is the one whose tree is a tree the merge job's batch verified.
    const tree = ref?.startsWith("refs/heads/") && !ours && !/^0+$/.test(after) ? await createArtifacts(env.ARTIFACTS).rootTree(repo, after) : null;
    const merging = await env.DB.prepare(
      "SELECT 1 FROM jobs j JOIN changes c ON c.id = j.change_id WHERE j.repo_id = ?1 AND j.kind = 'merge' AND j.status = 'claimed' AND 'refs/heads/' || c.target_branch = ?2 " +
      "AND EXISTS (SELECT 1 FROM json_each(j.payload, '$.batch') b WHERE json_extract(b.value, '$.tree') = ?4) " +
      "UNION ALL SELECT 1 FROM change_merged_shas m JOIN changes c ON c.id = m.change_id WHERE c.repo_id = ?1 AND m.merged_sha = ?3",
    ).bind(target.id, ref, after, tree).first();
    const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    // The default branch is checked by name: the policy is read from its head, which this push may have just moved.
    // A tag with a release never moves: a push that moves or deletes it is put back.
    const released = ref?.startsWith("refs/tags/") && !ours && await env.DB.prepare("SELECT 1 FROM releases WHERE repo = ? AND tag = ?").bind(repo, ref.slice("refs/tags/".length)).first();
    // The push that creates the default branch is a new repo's first commit (a pushed default branch can't be deleted): it lands.
    const first = branch === target.default_branch && /^0{40}$/.test(before ?? "");
    // An archived repo refuses every push: a write token issued before the archive lives out its TTL, so its push is put back.
    if ((target.archived && !ours) || released || (branch && !ours && !merging && !first && (branch === target.default_branch ||
      isAllowedTarget(await env.REPO_DO.get(env.REPO_DO.idFromName(repo)).policy(repo, target.default_branch), branch)))) {
      // A direct push to a protected target or released tag: put it back where it was (a new branch is deleted); a branch lands only through a change.
      // Recorded first: until the rollback lands (or if it fails), flows refuse this head of the default branch.
      await env.DB.prepare("INSERT OR IGNORE INTO rejected_pushes (repo, ref, sha) VALUES (?, ?, ?)").bind(repo, ref, after).run();
      try {
        if (!/^[0-9a-f]{40}$/.test(before ?? "")) throw new Error(`no previous sha (${before})`);
        await moveRef(await createArtifacts(env.ARTIFACTS).get(repo), ref, after, before);
      } catch (e) {
        // Logged, not thrown: a retry would repeat the whole batch; the error log is the record.
        console.error(`push: rolling back ${repo} ${ref} failed: ${e.message}`);
      }
      continue;
    }
    // A person's push to the head branch of their open change (not its deletion): the fork follows it and verify runs on it.
    if (branch && !ours && !/^0+$/.test(after)) {
      const states = [...REVERIFY, "in_queue", "converging"];
      const { results } = await env.DB.prepare("SELECT c.id FROM changes c JOIN change_cards k ON k.change_id = c.id WHERE c.repo_id = ? " +
        `AND json_extract(k.card, '$.head_branch') = ? AND json_extract(k.card, '$.driver') IS NOT NULL AND c.state IN (${states.map(() => "?").join(", ")})`)
        .bind(target.id, branch, ...states).all();
      for (const { id } of results) {
        const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
        let change = await stub.get();
        // A queued or converging change would land its old head: it goes back to needs_fix, then verifies the new one.
        if (change.state === "in_queue" || change.state === "converging") {
          change = await stub.transition("needs_fix", {
            kind: "head_moved", actor: { type: "system", id: "artifacts" }, action: "change.push", target: after, result: "ok",
          }, {}, change.state) ?? await stub.get();
        }
        await reverify(env, change, repo, ref, after);
      }
    }
    // The binding lists no refs, so a pushed tag is recorded for Releases and Code; a re-push moves it, a delete (zero sha) drops it.
    // A release keeps its own sha, so it outlives its tag's row.
    if (ref?.startsWith("refs/tags/") && /^0+$/.test(after)) {
      await env.DB.prepare("DELETE FROM tags WHERE repo = ? AND name = ?").bind(repo, ref.slice("refs/tags/".length)).run();
    } else if (ref?.startsWith("refs/tags/")) {
      const name = ref.slice("refs/tags/".length);
      // An annotated tag's after is the tag object; the row records the commit it peels to. Logged, not thrown, on a failed read.
      let sha = after;
      try {
        sha = (await listRefs(await createArtifacts(env.ARTIFACTS).get(repo))).find((r) => r.kind === "tag" && r.name === name)?.sha ?? after;
      } catch (e) {
        console.error(`push: peeling ${repo} ${ref} failed: ${e.message}`);
      }
      await env.DB.prepare("INSERT INTO tags (repo, name, sha, message, tagger, created_at) VALUES (?, ?, ?, ?, 'push', ?) ON CONFLICT (repo, name) DO UPDATE SET sha = excluded.sha")
        .bind(repo, name, sha, body.payload.commits?.at(-1)?.message || ref, at).run();
    }
    if (ref?.startsWith("refs/heads/")) {
      await indexCode(env, repo, ref.slice("refs/heads/".length), after);
      // A re-import's safety check reads the branches a refs job saw (branchWithFiles). One statement, so two pushes can't both queue one.
      await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) SELECT ?1, ?2, 'refs', 'queued', ?3, '{}'
        WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE repo_id = ?2 AND kind = 'refs' AND status IN ('queued', 'claimed'))`).bind(crypto.randomUUID(), target.id, at).run();
    }
    await env.DB.prepare("INSERT INTO repo_meta (repo_id, pushed_at) VALUES (?1, ?2) ON CONFLICT (repo_id) DO UPDATE SET pushed_at = ?2").bind(target.id, at).run();
    if (ref === `refs/heads/${target.default_branch}`) {
      await enqueueFlows(env, target, repo, after, "push", after).catch(flowsFailed);
      // Logged, not thrown: a bad .cinder.yml must not redeliver the batch; the stored policy stays as it was.
      await refreshPolicy(env, repo, target.default_branch).catch((e) => console.error(`push: refreshing ${repo} policy failed: ${e.message}`));
    }
  }
}

// The person's pushed commit reaches the change's fork at the same ref, verify runs on it, and its timeline shows the push.
async function reverify(env, change, repo, ref, after) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  // Logged, not thrown: a retry would repeat the whole batch; verify then fails on the missing commit and the next push copies again.
  // The fork's target-named branch is the change's branch for every job that works on it (converge, merge, develop), so
  // the push moves it too.
  const copied = await copyRef(await artifacts.get(repo), await artifacts.get(change.fork), ref, after, [`refs/heads/${change.target_branch}`]).then(() => true,
    (e) => console.error(`push: copying ${ref} of ${repo} into ${change.fork} failed: ${e.message}`));
  // git refuses the next push to refs/for/<branch> as a non-fast-forward while this one is still there; once the push
  // lives on in the change's fork, the ref is deleted so every push to it is a new ref.
  if (copied && ref.startsWith("refs/for/")) {
    await moveRef(await artifacts.get(repo), ref, after, "0".repeat(40))
      .catch((e) => console.error(`push: deleting ${ref} of ${repo} failed: ${e.message}`));
  }
  await verifyHead(env, change, after, change.state);
  const event = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).stageEvent({
    kind: "pushed", actor: { type: "system", id: "artifacts" }, action: "change.push", target: after, result: "ok",
  });
  await env.REPO_DO.get(env.REPO_DO.idFromName(repo)).broadcast(event);
}
