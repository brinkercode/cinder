// Plays a pool's runner for one change: claims `kind` jobs until that change's, then reports it. Jobs claimed on the
// way stay claimed.
export async function runFor(api, kind, changeId, report) {
  const { token } = await api("POST", "/api/runners", { name: "pool", kinds: [kind], slots: 64 });
  for (let claim; (claim = await api("POST", "/api/work/claim", { kinds: [kind], slots_free: 99 }, token));) {
    if (claim.job.change_id === changeId) return api("POST", `/api/work/jobs/${claim.job.id}/report`, report, token);
  }
  throw new Error(`no ${kind} job for ${changeId}`);
}

// Plays a pool's index runner: indexes repo's target head with symbols.
export async function indexFor(api, repo, target, symbols) {
  const { sha } = await api("GET", `/api/repos/${repo}/symbols?target=${target}`);
  const { id } = await api("GET", `/api/repos/${repo}`);
  const { token } = await api("POST", "/api/runners", { name: "pool", kinds: ["index"], slots: 64 });
  for (let claim; (claim = await api("POST", "/api/work/claim", { kinds: ["index"], slots_free: 99 }, token));) {
    if (claim.job.repo_id !== id || claim.payload.sha !== sha) continue;
    await api("PUT", `/api/work/repos/${repo}/symbols/${sha}`, symbols, token);
    return api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done" }, token);
  }
  throw new Error(`no index job for ${repo} ${target}`);
}

// Plays the person the seed leaves its drafts to: marks every draft change on repos ready, so a pool can take it.
// Then plays the pool's index runner, finding no symbols, so the changes waiting on their target's index lease.
export async function markReady(api, repos) {
  for (const repo of repos) {
    for (const c of await api("GET", `/api/repos/${repo}/changes`)) if (c.state === "draft") await api("POST", `/api/changes/${c.id}/ready`);
  }
  const { token } = await api("POST", "/api/runners", { name: "pool", kinds: ["index"] });
  for (let claim; (claim = await api("POST", "/api/work/claim", { kinds: ["index"], slots_free: 1 }, token));) {
    await api("PUT", `/api/work/repos/${claim.payload.repo}/symbols/${claim.payload.sha}`, [], token);
    await api("POST", `/api/work/jobs/${claim.job.id}/report`, { status: "done" }, token);
  }
}
