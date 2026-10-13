import { createArtifacts } from "./artifacts.js";
import { announce, cloudflare, parseDeploy, RESOURCE_API } from "./deploy.js";

// Cron (every 10 min, wrangler.jsonc): compares each environment's live Cloudflare state with its last Synced sync.
// A declared resource that's gone, or a live split other than the Synced version at 100%, marks the environment
// OutOfSync with the reasons (actor cinder-drift). With self_heal the missing resources' rows are dropped and the
// last Synced commit is synced again, so reconcile recreates them and the Synced version is redeployed.
export async function checkDrift(env, fetcher = fetch) {
  const base = `/accounts/${env.CF_ACCOUNT_ID}`;
  // SQLite returns the bare columns of the MAX(started_at) row.
  const { results } = await env.DB.prepare(
    "SELECT repo, env, sha, version_id, MAX(started_at), (SELECT status FROM deploy_syncs l WHERE l.repo = s.repo AND l.env = s.env " +
    "ORDER BY started_at DESC LIMIT 1) AS latest FROM deploy_syncs s WHERE status = 'Synced' GROUP BY repo, env",
  ).all();
  const failed = [];
  for (const { repo, env: envName, sha, version_id: synced, latest } of results) {
    // A sync in flight (a heal included) owns the environment until it settles.
    if (latest === "Progressing") continue;
    try {
      const artifacts = createArtifacts(env.ARTIFACTS);
      const deploy = parseDeploy(await artifacts.readFile(repo, sha, ".cinder.yml"));
      const target = deploy?.environments.find((e) => e.name === envName);
      // A flow deploy outside Cloudflare has no Worker to compare.
      if (!target || (target.target ?? "Cloudflare") !== "Cloudflare") continue;
      const { results: rows } = await env.DB.prepare("SELECT type, name, cf_id FROM deploy_resources WHERE repo = ? AND env = ?").bind(repo, envName).all();
      const reasons = [];
      const missing = [];
      for (const { type, name } of deploy.resources ?? []) {
        const row = rows.find((r) => r.type === type && r.name === name);
        // Only a 404 means gone; any other failure aborts the check rather than recreate a resource that may exist.
        const gone = !row || await cloudflare(env, `${base}/${RESOURCE_API[type].path}/${row.cf_id}`, {}, fetcher)
          .then(() => false, (err) => { if (err.status === 404) return true; throw err; });
        if (!gone) continue;
        if (row) missing.push(row);
        reasons.push(`${type} ${name}-${envName} is missing`);
      }
      const script = `${JSON.parse(await artifacts.readFile(repo, sha, deploy.worker)).name}-${envName}`;
      const { result } = await cloudflare(env, `${base}/workers/scripts/${script}/deployments`, {}, fetcher);
      const live = result.deployments?.[0]?.versions ?? [];
      if (live.length !== 1 || live[0].version_id !== synced) {
        reasons.push(`live version ${live.map((v) => `${v.version_id} at ${v.percentage}%`).join(", ") || "none"} is not the Synced ${synced}`);
      }
      if (!reasons.length) continue;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, status, changes, actor, started_at, at) VALUES (?, ?, ?, ?, 'OutOfSync', '[]', 'cinder-drift', ?, ?)")
          .bind(id, repo, envName, sha, now, now),
        env.DB.prepare("INSERT INTO deploy_sync_reasons (sync_id, reason) VALUES (?, ?)").bind(id, reasons.join("; ")),
      ]);
      await announce(env, repo, envName, "OutOfSync");
      if (!target.self_heal) continue;
      for (const r of missing) {
        await env.DB.prepare("DELETE FROM deploy_resources WHERE repo = ? AND env = ? AND type = ? AND name = ?").bind(repo, envName, r.type, r.name).run();
      }
      // The last Synced commit, not the branch head: healing must not deploy commits still waiting for a person.
      const heal = crypto.randomUUID();
      await env.PIPELINE.create({ id: heal, params: { sync: heal, repo, branch: target.branch, sha, actor: "cinder-drift" } });
    } catch (err) {
      failed.push(err);
    }
  }
  if (failed.length) throw new AggregateError(failed, `drift check failed for ${failed.length} environment(s)`);
}
