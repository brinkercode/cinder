import { createArtifacts } from "./artifacts.js";
import { diffFiles } from "./code.js";
import { error, runnerOf } from "./router.js";

const MAX_BYTES = 1 << 20;
const CONTEXT = 3;

// lineDiff's prefixed lines as unified hunks with CONTEXT lines around each change.
function hunks(lines) {
  const changed = lines.map((l) => l[0] !== " ");
  const out = [];
  let a = 0, b = 0, h = null;
  lines.forEach((l, i) => {
    if (changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).includes(true)) {
      if (!h) out.push(h = { a: a + 1, b: b + 1, n: 0, m: 0, body: [] });
      h.body.push(l);
      if (l[0] !== "+") h.n++;
      if (l[0] !== "-") h.m++;
    } else h = null;
    if (l[0] !== "+") a++;
    if (l[0] !== "-") b++;
  });
  return out.map((x) => `@@ -${x.n ? x.a : x.a - 1},${x.n} +${x.m ? x.b : x.b - 1},${x.m} @@\n${x.body.join("\n")}\n`).join("");
}

// GET /api/work/jobs/:job/diff → {diff}: the review job's change as unified diff text, from its verified base (the
// payload's base) to the fork's head, read from Artifacts. Only the runner holding the job's live lease may read it.
// A base the fork lacks diffs the head against its parent; past 1 MB the rest of the files are named, not shown.
export async function getReviewDiff(request, env, { job: id }) {
  const runner = await runnerOf(request, env);
  const job = await env.DB.prepare("SELECT change_id, payload FROM jobs WHERE id = ? AND runner_id = ? AND kind = 'review' AND status = 'claimed' AND lease_expires_at > ?")
    .bind(id, runner?.runner_id ?? null, new Date().toISOString()).first();
  if (!job?.change_id) return error(403, "forbidden", `review job ${id} is not leased to this runner`);
  const change = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(job.change_id)).get();
  const artifacts = createArtifacts(env.ARTIFACTS);
  const [head, parent] = await artifacts.log(change.fork, change.target_branch);
  if (!head) return error(404, "not_found", `fork ${change.fork} has no ${change.target_branch}`);
  const base = JSON.parse(job.payload ?? "{}").base;
  const from = base && (await artifacts.rootTree(change.fork, base)) ? base : parent?.sha ?? null;
  let diff = "";
  const left = [];
  for (const f of await diffFiles(artifacts, change.fork, from, head.sha)) {
    const text = `diff --git a/${f.path} b/${f.path}\n--- ${f.status === "added" ? "/dev/null" : `a/${f.path}`}\n+++ ${f.status === "deleted" ? "/dev/null" : `b/${f.path}`}\n`
      + (f.lines ? hunks(f.lines) : "(too large to show)\n");
    if (left.length || diff.length + text.length > MAX_BYTES) left.push(f.path);
    else diff += text;
  }
  if (left.length) diff += `\n[diff truncated at 1 MB; not shown: ${left.join(", ")}]\n`;
  return Response.json({ diff });
}
