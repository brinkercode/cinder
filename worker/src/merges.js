// A merging change's files: the paths its last verify's final diff wrote (change_writes). A change no verify reported
// writes for falls back to the paths of the symbols its lease holds. Read before the merge releases the lease.
export async function changedFiles(env, changeId) {
  const { results } = await env.DB.prepare("SELECT symbol FROM change_writes WHERE change_id = ?").bind(changeId).all();
  let symbols = results.map((r) => r.symbol);
  if (!symbols.length) {
    const { name, target_branch } = await env.DB.prepare("SELECT r.name, c.target_branch FROM changes c JOIN repos r ON r.id = c.repo_id WHERE c.id = ?").bind(changeId).first();
    symbols = (await env.REPO_DO.get(env.REPO_DO.idFromName(name)).leases(target_branch))[changeId]?.symbols ?? [];
  }
  return [...new Set(symbols.map((s) => s.split("#")[0]))];
}

// A merged change at sha (its head when unknown): one merges row, and its author and developing agent version gain 1 on
// each file, after every owner of those files decays by half per 90 days since the file's last decay.
export async function recordMerge(env, id, sha, files) {
  const at = new Date().toISOString();
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
  const [change, stages] = [await stub.get(), await stub.stages()];
  sha ??= change.head;
  const owners = [...new Set([change.events[0]?.actor?.id, stages.findLast((s) => s.stage === "develop")?.agent_version].filter(Boolean))];
  const paths = JSON.stringify(files);
  await env.DB.batch([
    ...(sha ? [env.DB.prepare("INSERT OR IGNORE INTO merges (repo_id, sha, change_id, target_branch, intent, diff_summary, paths, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(change.repo_id, sha, change.id, change.target_branch, change.intent ?? "", files.join(", "), paths, at)] : []),
    env.DB.prepare("UPDATE owners SET weight = weight * pow(0.5, (julianday(?3) - julianday(COALESCE((SELECT decayed_at FROM owner_decays d " +
      "WHERE d.repo = owners.repo AND d.path = owners.path), ?3))) / 90) WHERE repo = ?1 AND path IN (SELECT value FROM json_each(?2))").bind(change.repo_id, paths, at),
    env.DB.prepare("INSERT INTO owner_decays (repo, path, decayed_at) SELECT ?1, value, ?3 FROM json_each(?2) WHERE true " +
      "ON CONFLICT (repo, path) DO UPDATE SET decayed_at = excluded.decayed_at").bind(change.repo_id, paths, at),
    env.DB.prepare("INSERT INTO owners (repo, path, owner, weight) SELECT ?1, p.value, o.value, 1 FROM json_each(?2) p, json_each(?3) o WHERE true " +
      "ON CONFLICT (repo, path, owner) DO UPDATE SET weight = weight + 1").bind(change.repo_id, paths, JSON.stringify(owners)),
  ]);
}
