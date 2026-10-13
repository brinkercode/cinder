// Flow step logs, step statuses and annotations. The runner holding a flow job posts each step's lines in numbered
// batches; they are masked and appended to R2 LOGS as chunks of whole "<at> <text>\n" lines under
// flows/<run>/<job_key>/<idx>/<chunk>, which an R2 lifecycle rule expires after 30 days (deploy/reconcile.sh).
import { maskedJson } from "./keystore.js";
import { publish } from "./live.js";
import { error, runnerOf } from "./router.js";

const CHUNK_BYTES = 256 * 1024;
const JOB_BYTES = 50 * 1024 * 1024;
const PAGE = 2000;
const STATUSES = ["running", "passed", "failed", "skipped", "cancelled"];
const LEVELS = ["error", "warning", "notice"];
const size = (s) => new TextEncoder().encode(s).length;
const chunkKey = (run, key, idx, c) => `flows/${run}/${key}/${idx}/${c}`;
const expired = () => error(410, "expired", "this log has expired");
const outOfOrder = (seq) => Response.json({ error: { code: "out_of_order", message: `expected seq ${seq}` }, expected_seq: seq }, { status: 409 });

// The flow job id leased to the calling runner, with its repo and where each of its steps lives: [run id, job key, idx].
// A legacy flow job's steps are each a one-step job of the run (flows.js recordStep).
export async function leased(request, env, id) {
  const runner = await runnerOf(request, env);
  const job = runner && (await env.DB.prepare("SELECT j.payload, r.name AS repo FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE j.id = ? AND j.kind = 'flow' AND j.runner_id = ? AND j.status = 'claimed'")
    .bind(id, runner.runner_id).first());
  if (!job) return null;
  const p = JSON.parse(job.payload);
  // A legacy job's own steps (index past its steps) show on its first step's job (Set up job, Checkout) or last (the rest).
  const legacyPlace = (i) => {
    const sys = i - p.steps.length, s = p.steps[i] ?? p.steps[[0, 2].includes(sys) ? 0 : p.steps.length - 1];
    return [id, `${s.stage}/${s.name}`, i < p.steps.length ? 0 : 1 + sys];
  };
  const place = (i) => (p.run_id ? [p.run_id, p.key, i] : legacyPlace(i));
  return { repo: job.repo, steps: p.steps, place, run: !!p.run_id };
}

// A run's job also logs the runner's own steps, numbered after its own in this order (flows.js getRun shows them
// around the job's steps).
export const SYSTEM_STEPS = ["Set up job", "Complete job", "Checkout", "Upload artifacts"];

// The step at path index idx of the leased job id, or the refusal to answer.
async function leasedStep(request, env, id, idx) {
  const job = await leased(request, env, id);
  if (!job) return { refused: error(403, "forbidden", `flow job ${id} is not leased to this worker`) };
  const i = Number(idx);
  const name = Number.isInteger(i) && (job.steps[i]?.name ?? SYSTEM_STEPS[i - job.steps.length]);
  if (!name) return { refused: error(400, "bad_request", `no step ${idx} in this flow job`) };
  const [run, key, at] = job.place(i);
  const ensure = env.DB.prepare("INSERT OR IGNORE INTO flow_step_logs (run_id, job_key, idx, job_id) VALUES (?, ?, ?, ?)").bind(run, key, at, id);
  return { repo: job.repo, name, run, key, idx: at, job: id, ensure };
}

// POST /api/work/jobs/:job/steps/:idx/status {status, exit_code?}
export async function postStepStatus(request, env, { job: id, idx }) {
  const s = await leasedStep(request, env, id, idx);
  if (s.refused) return s.refused;
  const b = await request.json().catch(() => null);
  if (!STATUSES.includes(b?.status) || (b.exit_code != null && !Number.isInteger(b.exit_code))) {
    return error(400, "bad_request", `body must be {status, exit_code?} with status from: ${STATUSES.join(", ")}`);
  }
  const now = new Date().toISOString();
  const end = b.status !== "running";
  await env.DB.batch([s.ensure,
    env.DB.prepare(`INSERT INTO flow_step_runs (run_id, job_key, idx, name, status, started_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT DO UPDATE SET status = ?5, started_at = coalesce(?6, started_at), finished_at = ?7`).bind(s.run, s.key, s.idx, s.name, b.status, end ? null : now, end ? now : null),
    env.DB.prepare("UPDATE flow_step_logs SET exit_code = ? WHERE run_id = ? AND job_key = ? AND idx = ?").bind(end ? (b.exit_code ?? null) : null, s.run, s.key, s.idx)]);
  return new Response(null, { status: 204 });
}

// POST /api/work/jobs/:job/steps/:idx/log {seq, lines: [{at, text}]} → 204, or 409 {expected_seq} out of order.
export async function postStepLog(request, env, { job: id, idx }) {
  const s = await leasedStep(request, env, id, idx);
  if (s.refused) return s.refused;
  const b = await maskedJson(request, env, id);
  if (!Number.isInteger(b?.seq) || !Array.isArray(b.lines) || !b.lines.every((l) => /^\S+$/.test(l?.at) && typeof l.text === "string" && !l.text.includes("\n"))) {
    return error(400, "bad_request", "body must be {seq, lines: [{at, text}]} with at free of spaces and text a single line");
  }
  return appendLog(env, s, b.seq, b.lines);
}

// Appends lines to a step's stored log (R2 chunks plus its flow_step_logs row) and publishes them; seq must be the next one.
// s is {repo, name, run, key, idx, job, ensure}. A null seq takes the next one (a writer inside the Worker, not a runner).
export async function appendLog(env, s, seq, lines) {
  await s.ensure.run();
  const where = [s.run, s.key, s.idx];
  const row = await env.DB.prepare("SELECT seq, chunks, open_bytes, bytes FROM flow_step_logs WHERE run_id = ? AND job_key = ? AND idx = ?").bind(...where).first();
  seq ??= row.seq + 1;
  if (seq !== row.seq + 1) return outOfOrder(row.seq + 1);
  const job = await env.DB.prepare("SELECT sum(bytes) AS bytes, max(truncated) AS truncated FROM flow_step_logs WHERE job_id = ?").bind(s.job).first();
  const chunks = JSON.parse(row.chunks);
  const first = chunks.reduce((a, n) => a + n, 0);
  let [open, total, truncated, bytes] = [row.open_bytes, job.bytes, job.truncated, row.bytes];
  const texts = new Map(); // chunk index → its whole new text
  const out = [];
  for (const l of lines) {
    if (truncated) break;
    let line = { at: l.at, text: l.text };
    let n = size(`${line.at} ${line.text}\n`);
    if (total + n > JOB_BYTES) {
      line = { at: new Date().toISOString(), text: "##[warning]log truncated" };
      n = size(`${line.at} ${line.text}\n`);
      truncated = 1;
    }
    if (!chunks.length || (open && open + n > CHUNK_BYTES)) {
      chunks.push(0);
      open = 0;
    }
    const c = chunks.length - 1;
    if (!texts.has(c)) {
      const old = open ? await env.LOGS.get(chunkKey(s.run, s.key, s.idx, c)) : null;
      if (open && !old) return expired();
      texts.set(c, old ? await old.text() : "");
    }
    texts.set(c, `${texts.get(c)}${line.at} ${line.text}\n`);
    chunks[c]++;
    [open, total, bytes] = [open + n, total + n, bytes + n];
    out.push({ n: first + out.length, ...line });
  }
  for (const [c, text] of texts) await env.LOGS.put(chunkKey(s.run, s.key, s.idx, c), text);
  // A repeat of the same batch (a runner retry racing itself) wrote the same text; only one moves seq on.
  const [moved] = await env.DB.batch([
    env.DB.prepare("UPDATE flow_step_logs SET seq = ?, chunks = ?, open_bytes = ?, bytes = ?, truncated = ? WHERE run_id = ? AND job_key = ? AND idx = ? AND seq = ?")
      .bind(seq, JSON.stringify(chunks), open, bytes, truncated, ...where, row.seq),
    env.DB.prepare(`INSERT INTO flow_step_runs (run_id, job_key, idx, name, status, lines) VALUES (?1, ?2, ?3, ?4, 'running', ?5)
      ON CONFLICT DO UPDATE SET lines = ?5`).bind(...where, s.name, first + out.length),
  ]);
  if (!moved.meta.changes) return outOfOrder(row.seq + 2);
  if (out.length) await publish(env, s.repo, "run.log", { id: s.run, key: s.key, step: s.idx, from: first, lines: out });
  return new Response(null, { status: 204 });
}

// POST /api/work/jobs/:job/annotations [{step, level, message, file?, file_line?, line}] → 204
export async function postAnnotations(request, env, { job: id }) {
  const job = await leased(request, env, id);
  if (!job) return error(403, "forbidden", `flow job ${id} is not leased to this worker`);
  const b = await maskedJson(request, env, id);
  const idxOf = (a) => job.steps.findIndex((x) => x.name === a?.step);
  if (!Array.isArray(b) || !b.every((a) => idxOf(a) >= 0 && LEVELS.includes(a.level) && typeof a.message === "string" && a.message
    && Number.isInteger(a.line) && a.line >= 0 && (a.file == null || typeof a.file === "string") && (a.file_line == null || Number.isInteger(a.file_line)))) {
    return error(400, "bad_request", `body must be [{step, level, message, file?, file_line?, line}] with step a step of this job and level from: ${LEVELS.join(", ")}`);
  }
  if (!b.length) return new Response(null, { status: 204 });
  const [run] = job.place(0);
  const rows = b.map((a) => ({ job_key: job.place(idxOf(a))[1], step: a.step, line: a.line, level: a.level, message: a.message,
    ...(a.file != null && { file: a.file }), ...(a.file_line != null && { file_line: a.file_line }) }));
  await env.DB.batch(rows.map((a) => env.DB.prepare("INSERT INTO flow_annotations (run_id, job_key, step, line, level, message, file, file_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(run, a.job_key, a.step, a.line, a.level, a.message, a.file ?? null, a.file_line ?? null)));
  await publish(env, job.repo, "run.annotation", { id: run, annotations: rows });
  return new Response(null, { status: 204 });
}

export const runIn = (env, name, id) => env.DB.prepare("SELECT 1 AS ok FROM flow_runs f JOIN repos r ON r.id = f.repo_id WHERE f.id = ? AND r.name = ?").bind(id, name).first("ok");

// GET /api/repos/:name/flow-runs/:id/jobs/:key/log?step=&from=&limit= → FlowLogPage; key is URL-encoded (it holds a /).
export async function getLogPage(request, env, { name, id, key }) {
  const q = new URL(request.url).searchParams;
  const [step, from, limit] = [Number(q.get("step")), Number(q.get("from") ?? 0), Number(q.get("limit") ?? PAGE)];
  if (!q.get("step") || !Number.isInteger(step) || step < 0 || !Number.isInteger(from) || from < 0 || !Number.isInteger(limit) || limit < 1 || limit > PAGE) {
    return error(400, "bad_request", `step and from must be integers >= 0 and limit 1..${PAGE}`);
  }
  if (!(await runIn(env, name, id))) return error(404, "not_found", `no flow run ${id} in ${name}`);
  const jobKey = decodeURIComponent(key);
  const counts = JSON.parse((await env.DB.prepare("SELECT chunks FROM flow_step_logs WHERE run_id = ? AND job_key = ? AND idx = ?").bind(id, jobKey, step).first("chunks")) ?? "[]");
  const lines = [];
  let start = 0;
  for (const [c, count] of counts.entries()) {
    if (lines.length < limit && start + count > from) {
      const obj = await env.LOGS.get(chunkKey(id, jobKey, step, c));
      if (!obj) return expired();
      const all = (await obj.text()).split("\n");
      for (let i = Math.max(0, from - start); i < count && lines.length < limit; i++) {
        const sp = all[i].indexOf(" ");
        lines.push({ n: start + i, at: all[i].slice(0, sp), text: all[i].slice(sp + 1) });
      }
    }
    start += count;
  }
  const end = from + lines.length;
  return Response.json({ step, from, lines, ...(end < start && { next: end }) });
}

// GET /api/repos/:name/flow-runs/:id/jobs/:key/log.txt → the job's stored chunks, every step in order, as stored.
export async function getLogText(request, env, { name, id, key }) {
  if (!(await runIn(env, name, id))) return error(404, "not_found", `no flow run ${id} in ${name}`);
  const jobKey = decodeURIComponent(key);
  // rowid is the order the runner started the steps in: its pre steps, the job's steps, then its post steps.
  const { results } = await env.DB.prepare("SELECT idx, chunks FROM flow_step_logs WHERE run_id = ? AND job_key = ? ORDER BY rowid").bind(id, jobKey).all();
  const keys = results.flatMap((r) => JSON.parse(r.chunks).map((_, c) => chunkKey(id, jobKey, r.idx, c)));
  // The oldest chunk is swept first, so a log whose first chunk is there is whole unless a sweep lands mid-stream.
  const head = keys.length ? await env.LOGS.get(keys[0]) : null;
  if (keys.length && !head) return expired();
  const { readable, writable } = new TransformStream();
  (async () => {
    for (const [i, k] of keys.entries()) {
      const obj = i ? await env.LOGS.get(k) : head;
      if (!obj) throw new Error(`log chunk ${k} expired`);
      await obj.body.pipeTo(writable, { preventClose: true });
    }
    await writable.close();
  })().catch((e) => writable.abort(e));
  return new Response(readable, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// GET /api/repos/:name/flow-runs/:id/annotations → [{job_key, step, line, level, message, file?, file_line?}]
export async function listAnnotations(request, env, { name, id }) {
  if (!(await runIn(env, name, id))) return error(404, "not_found", `no flow run ${id} in ${name}`);
  const { results } = await env.DB.prepare("SELECT job_key, step, line, level, message, file, file_line FROM flow_annotations WHERE run_id = ? ORDER BY rowid").bind(id).all();
  return Response.json(results.map(({ file, file_line, ...a }) => ({ ...a, ...(file != null && { file }), ...(file_line != null && { file_line }) })));
}
