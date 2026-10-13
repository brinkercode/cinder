import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateFlowRunTree } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const FLOW = `name: ci
on: [manual]
steps:
  install: { stage: build, job: build, run: "npm ci", needs: [] }
  test: { stage: build, job: build, run: "npm test", needs: [install] }
`;
const AT = "2026-10-08T09:00:00.000Z";
const KEY = encodeURIComponent("build/build");
let priority = 2e9;

// A repo with flow ci, a started run whose one flow job is claimed by a runner, and helpers to post to and read it.
async function leasedJob(name, e = { ...env }, flow = FLOW) {
  const fake = fakeArtifacts();
  e.ARTIFACTS = fake;
  const call = (method, path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), e);
  await call("POST", "/api/repos", { name });
  Object.assign(fake.repos.get(name), { commits: [{ sha: "s1" }], files: { ".cinder/flows/ci.yml": flow } });
  const runner = async (n) => (await (await call("POST", "/api/runners", { name: `${name}-${n}`, kinds: ["flow"] })).json()).token;
  const token = await runner("lab");
  const run = await (await call("POST", `/api/repos/${name}/flows/ci/runs`)).json();
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE coalesce(json_extract(payload, '$.run_id'), id) = ?").bind(run.id).first("id");
  await env.DB.prepare("INSERT INTO job_priorities (job_id, priority) VALUES (?, ?)").bind(job, priority++).run();
  expect((await (await call("POST", "/api/work/claim", { kinds: ["flow"] }, token)).json()).job.id).toBe(job);
  const log = (step, seq, lines, t = token) => call("POST", `/api/work/jobs/${job}/steps/${step}/log`, { seq, lines }, t);
  const page = async (step, from = 0) => (await call("GET", `/api/repos/${name}/flow-runs/${run.id}/jobs/${KEY}/log?step=${step}&from=${from}`)).json();
  const chunk = async (step, c) => (await env.LOGS.get(`flows/${run.id}/build/build/${step}/${c}`))?.text();
  return { call, runner, token, run, job, log, page, chunk };
}
const lines = (from, count, text = (i) => `line ${i}`) => Array.from({ length: count }, (_, i) => ({ at: AT, text: text(from + i) }));

describe("flow step logs", () => {
  it("a log batch with an out-of-order seq answers 409 with expected_seq", async () => {
    const { log } = await leasedJob("fl-seq");
    expect((await log(0, 1, lines(0, 2))).status).toBe(204);
    for (const seq of [3, 1]) {
      const res = await log(0, seq, lines(2, 1));
      expect(res.status).toBe(409);
      expect((await res.json()).expected_seq).toBe(2);
    }
    expect((await log(0, 2, lines(2, 1))).status).toBe(204);
  });

  it("a 20,000-line job pages in 2,000-line pages with next, and every line comes back once in order", async () => {
    const { log, page, chunk, run } = await leasedJob("fl-page");
    const pad = (i) => `line ${i} `.padEnd(80, "x");
    for (let b = 0; b < 20; b++) expect((await log(1, b + 1, lines(b * 1000, 1000, pad))).status).toBe(204);
    expect(await chunk(1, 1)).toBeDefined(); // the log rolled over into several chunks
    const seen = [];
    let from = 0;
    let pages = 0;
    while (from !== undefined) {
      const p = await page(1, from);
      expect(p.lines.length).toBe(2000);
      seen.push(...p.lines);
      pages++;
      from = p.next;
    }
    expect(pages).toBe(10);
    expect(seen.map((l) => l.n)).toEqual([...Array(20000).keys()]);
    expect(seen.every((l, i) => l.text === pad(i) && l.at === AT)).toBe(true);
    const { lines: count } = await env.DB.prepare("SELECT lines FROM flow_step_runs WHERE run_id = ? AND idx = 1").bind(run.id).first();
    expect(count).toBe(20000);
  });

  it("log.txt is byte-identical to the stored chunks, group and annotation markers included", async () => {
    const { log, chunk, call, run } = await leasedJob("fl-txt");
    const marked = ["##[group]npm ci", "added 812 packages ✓", "##[error]file=src/a.js,line=3::boom", "##[warning]deprecated", "##[endgroup]"];
    expect((await log(0, 1, lines(0, 3000, (i) => `${marked[i % 5]} ${"y".repeat(100)}`))).status).toBe(204);
    expect((await log(1, 1, marked.map((text) => ({ at: AT, text })))).status).toBe(204);
    const stored = [await chunk(0, 0), await chunk(0, 1), await chunk(1, 0)];
    expect(stored.every((s) => s !== undefined)).toBe(true);
    const res = await call("GET", `/api/repos/fl-txt/flow-runs/${run.id}/jobs/${KEY}/log.txt`);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(new TextEncoder().encode(stored.join("")));
    expect(stored[2]).toBe(marked.map((t) => `${AT} ${t}\n`).join(""));
  });

  it("a secret on the last line of one chunk and the first line of the next is masked in both", async () => {
    const SECRET = "s3cr3t-value-0123456789";
    const e = { ...env, SECRETS: { read: async () => SECRET } };
    const { log, chunk } = await leasedJob("fl-mask", e);
    await env.DB.prepare(`INSERT INTO keystore_secrets (id, name, kind, scope, repo, owner, store_id, store_secret_id, store_secret_name, created_at)
      VALUES ('ks-fl-mask', 'DEPLOY_KEY', 'flow_secret', 'repo', 'fl-mask', 'owner', 'store1', 'ss1', 'deploy_key', ?)`).bind(AT).run();
    // 255 lines of 1,024 bytes fill the first 256 KB chunk; the 2,000-byte line after them starts the next.
    const first = lines(0, 255, (i) => (i === 254 ? `token ${SECRET} `.padEnd(998, "a") : "a".repeat(998)));
    expect((await log(0, 1, first)).status).toBe(204);
    expect((await log(0, 2, [{ at: AT, text: `token ${SECRET} `.padEnd(2000, "b") }])).status).toBe(204);
    const [a, b] = [await chunk(0, 0), await chunk(0, 1)];
    expect(a.split("\n").at(-2)).toMatch(/^\S+ token \*\*\* a/);
    expect(b.split("\n")[0]).toMatch(/^\S+ token \*\*\* b/);
    expect(a + b).not.toContain(SECRET);
  });

  it("past 50 MB a job stores one ##[warning]log truncated line and drops the rest", async () => {
    const { log, page, run } = await leasedJob("fl-cap");
    // Step 0 already holds all but 100 bytes of the job's 50 MB.
    await env.DB.prepare("INSERT INTO flow_step_logs (run_id, job_key, idx, job_id, bytes) VALUES (?, 'build/build', 0, (SELECT job_id FROM flow_jobs WHERE run_id = ?1), ?)")
      .bind(run.id, 50 * 1024 * 1024 - 100).run();
    expect((await log(1, 1, [{ at: AT, text: "fits" }, { at: AT, text: "z".repeat(200) }, { at: AT, text: "dropped" }])).status).toBe(204);
    expect((await log(1, 2, [{ at: AT, text: "dropped too" }])).status).toBe(204);
    const p = await page(1);
    expect(p.lines.map((l) => l.text)).toEqual(["fits", "##[warning]log truncated"]);
    expect(p.next).toBeUndefined();
  });

  it("a log or status post for a job not leased to the runner is refused with 403", async () => {
    const { call, runner, job, log } = await leasedJob("fl-lease");
    const other = await runner("other");
    expect((await log(0, 1, lines(0, 1), other)).status).toBe(403);
    expect((await call("POST", `/api/work/jobs/${job}/steps/0/status`, { status: "running" }, other)).status).toBe(403);
    expect((await call("POST", `/api/work/jobs/${job}/annotations`, [], other)).status).toBe(403);
  });

  it("a step the runner stopped on cancel is stored cancelled", async () => {
    const { call, job, run, token } = await leasedJob("fl-cancel");
    expect((await call("POST", `/api/work/jobs/${job}/steps/0/status`, { status: "cancelled", exit_code: 143 }, token)).status).toBe(204);
    expect(await env.DB.prepare("SELECT status FROM flow_step_runs WHERE run_id = ? AND idx = 0").bind(run.id).first("status")).toBe("cancelled");
  });

  it("the runner's pre steps (Set up job, Checkout) and post steps (Upload artifacts, Complete job) show around the job's steps in the run tree", async () => {
    const { call, job, run, token, log, page } = await leasedJob("fl-system");
    const status = (idx, st) => call("POST", `/api/work/jobs/${job}/steps/${idx}/status`, { status: st }, token);
    expect((await status(2, "running")).status).toBe(204);
    expect((await log(2, 1, lines(0, 1, () => "Runner name: 'lab'"))).status).toBe(204);
    expect((await status(2, "passed")).status).toBe(204);
    expect((await status(3, "passed")).status).toBe(204);
    expect((await status(4, "passed")).status).toBe(204);
    expect((await status(5, "passed")).status).toBe(204);
    expect((await status(6, "passed")).status).toBe(400);
    expect((await page(2)).lines.map((l) => l.text)).toEqual(["Runner name: 'lab'"]);
    expect((await log(0, 1, lines(0, 1))).status).toBe(204);
    expect(await (await call("GET", `/api/repos/fl-system/flow-runs/${run.id}/jobs/${KEY}/log.txt`)).text()).toBe(`${AT} Runner name: 'lab'\n${AT} line 0\n`);
    const tree = await (await call("GET", `/api/repos/fl-system/flow-runs/${run.id}`)).json();
    expect(validateFlowRunTree(tree)).toEqual({ ok: true, errors: [] });
    expect(tree.stages[0].jobs[0].steps.map((s) => [s.idx, s.name, s.status])).toEqual([[2, "Set up job", "passed"], [4, "Checkout", "passed"], [0, "install", "running"], [1, "test", "queued"], [5, "Upload artifacts", "passed"], [3, "Complete job", "passed"]]);
  });

  it("run.log goes only to sockets subscribed to that run and job", async () => {
    const { log, run } = await leasedJob("fl-live");
    const stub = env.REPO_DO.get(env.REPO_DO.idFromName("fl-live"));
    const open = async (sub) => {
      const ws = (await stub.fetch("http://do/live", { headers: { Upgrade: "websocket" } })).webSocket;
      const got = [];
      ws.accept();
      ws.addEventListener("message", (m) => got.push(JSON.parse(m.data)));
      if (sub) ws.send(JSON.stringify({ type: "subscribe", ...sub }));
      return got;
    };
    const [mine, otherJob, none] = [await open({ run: run.id, key: "build/build" }), await open({ run: run.id, key: "test/unit" }), await open(null)];
    const attached = () => runInDurableObject(stub, (_, state) => state.getWebSockets().filter((w) => w.deserializeAttachment()).length);
    for (let i = 0; i < 50 && (await attached()) < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await attached()).toBe(2);
    expect((await log(0, 1, lines(0, 2))).status).toBe(204);
    await stub.broadcast({ kind: "run.updated", id: run.id });
    for (let i = 0; i < 50 && [mine, otherJob, none].some((g) => !g.some((m) => m.kind === "run.updated")); i++) await new Promise((r) => setTimeout(r, 10));
    expect(mine.map((m) => m.kind)).toEqual(["run.log", "run.updated"]);
    expect(mine[0]).toMatchObject({ id: run.id, key: "build/build", step: 0, from: 0, lines: [{ n: 0, at: AT, text: "line 0" }, { n: 1, at: AT, text: "line 1" }] });
    expect(otherJob.map((m) => m.kind)).toEqual(["run.updated"]);
    expect(none.map((m) => m.kind)).toEqual(["run.updated"]);
  });

  it("annotations are stored from the structured post and listed by the annotations route", async () => {
    const { call, job, run, token } = await leasedJob("fl-notes");
    const notes = [{ step: "test", level: "error", message: "expected 2 to be 3", file: "src/a.test.js", file_line: 12, line: 41 },
      { step: "install", level: "warning", message: "deprecated package", line: 3 }];
    expect((await call("POST", `/api/work/jobs/${job}/annotations`, [{ ...notes[0], level: "fatal" }], token)).status).toBe(400);
    expect((await call("POST", `/api/work/jobs/${job}/annotations`, notes, token)).status).toBe(204);
    const listed = await (await call("GET", `/api/repos/fl-notes/flow-runs/${run.id}/annotations`)).json();
    expect(listed).toEqual([{ job_key: "build/build", step: "test", line: 41, level: "error", message: "expected 2 to be 3", file: "src/a.test.js", file_line: 12 },
      { job_key: "build/build", step: "install", line: 3, level: "warning", message: "deprecated package" }]);
    const tree = await (await call("GET", `/api/repos/fl-notes/flow-runs/${run.id}`)).json();
    expect(tree.annotations_count).toEqual({ error: 1, warning: 1 });
  });

  it("a flow with no jobs shows the runner's Set up job and Checkout on its first step's job and Complete job on its last", async () => {
    const { call, job, run, token, log } = await leasedJob("fl-legacy-sys", undefined,
      "name: ci\non: [change, manual]\nsteps:\n  install: { stage: build, run: \"npm ci\", needs: [] }\n  test: { stage: build, run: \"npm test\", needs: [install] }\n");
    expect(job).toBe(run.id);
    const status = (idx, st) => call("POST", `/api/work/jobs/${job}/steps/${idx}/status`, { status: st }, token);
    for (const idx of [2, 4, 3]) expect((await status(idx, "passed")).status).toBe(204);
    expect((await log(2, 1, lines(0, 1, () => "Runner name: 'lab'"))).status).toBe(204);
    expect((await log(3, 1, lines(0, 1, () => "Steps took 4s"))).status).toBe(204);
    const tree = await (await call("GET", `/api/repos/fl-legacy-sys/flow-runs/${run.id}`)).json();
    const [install, test] = tree.stages[0].jobs;
    expect(install.steps.map((s) => s.name)).toEqual(["Set up job", "Checkout", "install"]);
    expect(test.steps.map((s) => s.name)).toEqual(["test", "Complete job"]);
    const page = async (key, step) => (await (await call("GET", `/api/repos/fl-legacy-sys/flow-runs/${run.id}/jobs/${encodeURIComponent(key)}/log?step=${step}`)).json()).lines.map((l) => l.text);
    expect(await page("build/install", 1)).toEqual(["Runner name: 'lab'"]);
    expect(await page("build/test", 2)).toEqual(["Steps took 4s"]);
  });

  it("lines posted after a step's status still land on its page", async () => {
    // A flow with no jobs runs as one flow job (id = run id) whose steps each post their own log.
    const { call, job, run, token, log } = await leasedJob("fl-late", undefined, "name: ci\non: [manual]\nsteps:\n  install: { stage: build, run: \"npm ci\", needs: [] }\n");
    expect(job).toBe(run.id);
    const key = encodeURIComponent("build/install");
    for (const status of ["running", "passed"]) expect((await call("POST", `/api/work/jobs/${job}/steps`, { name: "install", status, logs: "" }, token)).status).toBe(204);
    expect((await log(0, 1, lines(0, 3))).status).toBe(204);
    const page = await (await call("GET", `/api/repos/fl-late/flow-runs/${run.id}/jobs/${key}/log?step=0`)).json();
    expect(page.lines.map((l) => l.text)).toEqual(["line 0", "line 1", "line 2"]);
    const txt = await (await call("GET", `/api/repos/fl-late/flow-runs/${run.id}/jobs/${key}/log.txt`)).text();
    expect(txt).toBe(lines(0, 3).map((l) => `${l.at} ${l.text}\n`).join(""));
    const tree = await (await call("GET", `/api/repos/fl-late/flow-runs/${run.id}`)).json();
    expect(tree.stages[0].jobs[0].steps[0]).toMatchObject({ status: "passed", lines: 3 });
  });

  it("masks an Artifacts token in a step log line", async () => {
    const { log, page } = await leasedJob("fl-art-token");
    const url = "https://x:art_v1_0123456789abcdef?expires=1791000000@artifacts.cloudflare.net/r.git";
    expect((await log(0, 1, [{ at: AT, text: `clone ${url}` }])).status).toBe(204);
    expect((await page(0)).lines[0].text).toBe("clone https://x:***@artifacts.cloudflare.net/r.git");
  });
});
