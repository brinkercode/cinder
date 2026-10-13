// Drives real activity through cinder's API after the seed: `node seed/activity.mjs`, with the seed's env (CINDER_URL,
// CINDER_TOKEN, the Access service token). It only starts work and waits: runners, the flow executor and the judges do
// it, and every outcome it reports is the state cinder shows. It never claims or reports a job.
import { CI, client } from "./seed.mjs";

// A change stops here for a person or for good; the summary reports any other state as still pending.
const TERMINAL = ["merged", "failed", "needs_fix", "closed", "draft", "awaiting approval"];
const TIMEOUT = 3_600_000;

// Stops with one message naming every missing piece: a runner pool, the flow executor or the owner's Mine model access.
async function preflight(api) {
  const online = (await api("GET", "/api/workers")).filter((r) => r.online);
  // Managed pools scale from zero per queued job, so a pool that can take a kind counts like an online worker.
  const pools = (await api("GET", "/api/workers/pools")).filter((p) => p.max > 0);
  const takes = (kind) => online.some((r) => r.kinds.includes(kind)) || pools.some((p) => !p.kinds?.length || p.kinds.includes(kind));
  const { source, providers } = await api("GET", "/api/me/models");
  const missing = [
    !takes("develop") && "runner pools (no online worker or pool takes develop jobs; start a pool on Workers)",
    !takes("flow") && "the flow executor (no online worker or pool takes flow jobs)",
    (source !== "mine" || !providers.some((p) => p.source === "mine" && p.status === "connected"))
      && "the owner's own model credential (set the source to Mine with a connected provider on My model access, /me/models)",
  ].filter(Boolean);
  if (missing.length) throw new Error(`activity: missing ${missing.join("; ")}`);
}

// The tail of a step's logs, as the run detail shows them.
async function tail(api, repo, id, step) {
  const run = await api("GET", `/api/repos/${repo}/flow-runs/${id}`);
  return (run?.steps?.find((s) => s.name === step)?.logs ?? "").trimEnd().split("\n").slice(-10).join("\n");
}

// The one expected failure, marked "Deliberate failure" in its flow file: svc-orders-go's ci at its integration job alone.
export const DELIBERATE = { repo: "svc-orders-go", flow: "ci", step: "integration" };
const expected = (repo, r) => {
  const failed = r.steps.filter((s) => s.status === "failed");
  return repo === DELIBERATE.repo && r.flow === DELIBERATE.flow && failed.length === 1 && failed[0].name === DELIBERATE.step;
};

// What cinder shows now for this run's changes, the flow runs and scans since `since`, whether all of it has settled, and
// once it has, failures: each unexpected flow failure and each page activity feeds that is still empty.
async function outcomes(api, repos, picked, since, seeded) {
  const changes = [];
  for (const { repo, issue, id } of picked) {
    const { state, review } = await api("GET", `/api/changes/${id}`);
    // The risk judgment the Changes page shows (review.p); null until a judge answered.
    const judgments = review?.p == null ? 0 : 1;
    // Verifying on a person's review route waits for that person.
    changes.push({ repo, issue, id, state: state === "verifying" && review?.route === "human" ? "awaiting approval" : state, judgments });
  }
  const runs = [];
  const scans = [];
  for (const repo of repos) {
    for (const r of (await api("GET", `/api/repos/${repo}/flow-runs`)).filter((r) => r.created_at >= since || seeded.includes(r.id))) {
      runs.push({ repo, id: r.id, flow: r.flow, status: r.status, settled: ["done", "failed"].includes(r.status), steps: Object.fromEntries(r.steps.map((s) => [s.name, s.status])),
        unexpected: r.status === "failed" && !expected(repo, r) });
    }
    const scan = (await api("GET", `/api/repos/${repo}/watchtower/scans`)).find((s) => s.started_at >= since);
    scans.push({ repo, status: scan?.status ?? "queued" });
  }
  const pending = [
    ...changes.filter((c) => !TERMINAL.includes(c.state)).map((c) => `${c.repo} change ${c.id} (${c.state})`),
    ...runs.filter((r) => !r.settled).map((r) => `${r.repo} flow ${r.flow} run ${r.id} (${r.status})`),
    ...scans.filter((s) => ["queued", "running"].includes(s.status)).map((s) => `${s.repo} scan (${s.status})`),
  ];
  if (pending.length) return { settled: false, pending, changes, runs, scans, failures: [] };
  const failures = [];
  for (const r of runs.filter((r) => r.unexpected)) {
    const step = Object.keys(r.steps).find((name) => r.steps[name] === "failed");
    failures.push(`${r.repo} flow ${r.flow} run ${r.id} failed at step ${step ?? "(none reported)"}:\n${step ? await tail(api, r.repo, r.id, step) : ""}`);
  }
  const empty = [
    (!changes.length || changes.some((c) => !c.judgments)) && "Changes (a picked change has no judgment)",
    !(await api("GET", "/api/fleet")).agents.some((a) => a.runs_24h > 0) && "Agents (no run in the last 24 h)",
    scans.some((s) => s.status !== "done") && "Watchtower (a repo's scan is not done)",
    repos.some((repo) => !runs.some((r) => r.repo === repo)) && "Flows (a repo has no settled run)",
  ].filter(Boolean);
  if (empty.length) failures.push(`activity: empty pages: ${empty.join("; ")}`);
  return { settled: true, pending, changes, runs, scans, failures };
}

// The advisory each seed repo's pinned package has. An agent change asks the agent to read it on osv.dev, which no
// agent's allowlist has, so its egress proxy denies the host and Watchtower › Network shows a denied host to Allow.
export const ADVISORIES = { "web-store": "GHSA-35jh-r3h4-6jhm", "svc-orders-go": "GO-2022-1059", "infra-cloudflare-tf": "GHSA-67mh-4wv8-2f99" };
export const agentIntent = (repo, title) => (ADVISORIES[repo] ? `${title} (first read https://osv.dev/vulnerability/${ADVISORIES[repo]} and say whether it affects this repo)` : title);

// repos: the seed repos. The changes the seed filed there are waited for, as the pools take them. Each one's first open
// issue no change has picked up becomes a change (an agent develops it on the runner pool) linked to that issue, and each
// repo gets a Watchtower scan and a run of each flow at its head: the seed's are dry-run (they plan, build and test, and
// deploy nothing); svc-orders-go's ci fails at its integration job, on the repo's open gap. Pushes to a default branch
// start that repo's push flows, which are awaited too. Returns outcomes() once settled, or on timeout with what is still pending as a failure.
export async function activity(api, repos, every = 10_000) {
  await preflight(api);
  const since = new Date().toISOString();
  // The seed's CI run started before this script: waited for like the runs it starts.
  const seeded = ((await api("GET", `/api/repos/${CI.repo}/flow-runs`)) ?? []).filter((r) => r.flow === CI.flow && !["done", "failed"].includes(r.status)).map((r) => r.id);
  const picked = [];
  for (const repo of repos) {
    const issues = await api("GET", `/api/repos/${repo}/issues`);
    if (!issues) throw new Error(`activity: no repo ${repo}; run seed/seed.mjs first`);
    for (const c of await api("GET", `/api/repos/${repo}/changes`)) if (!TERMINAL.includes(c.state)) picked.push({ repo, issue: null, id: c.id });
    const issue = issues.find((i) => i.state === "open" && !i.change);
    if (issue) {
      const change = await api("POST", `/api/repos/${repo}/changes`, { intent: agentIntent(repo, issue.title) });
      await api("PUT", `/api/repos/${repo}/issues/${issue.number}/changes/${change.id}`);
      picked.push({ repo, issue: issue.number, id: change.id });
    }
    await api("POST", `/api/repos/${repo}/watchtower/scans`);
    for (const { flow } of await api("GET", `/api/repos/${repo}/flows`) ?? []) await api("POST", `/api/repos/${repo}/flows/${flow}/runs`);
  }
  const end = Date.now() + TIMEOUT;
  for (;;) {
    const now = await outcomes(api, repos, picked, since, seeded);
    if (now.settled) return now;
    if (Date.now() > end) return { ...now, failures: [`activity: timed out; still pending: ${now.pending.join("; ")}`] };
    await new Promise((r) => setTimeout(r, every));
  }
}

if (globalThis.process?.argv[1] && globalThis.process.argv[1] === new URL(import.meta.url).pathname) {
  const { CINDER_URL: url, CINDER_TOKEN: token, CINDER_ACCESS_CLIENT_ID: accessId, CINDER_ACCESS_CLIENT_SECRET: accessSecret } = process.env;
  if (!url || !token) {
    console.error("activity: CINDER_URL and CINDER_TOKEN must be set");
    process.exit(1);
  }
  const { readdirSync } = await import("node:fs");
  const repos = readdirSync(new URL("./repos/", import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  try {
    const out = await activity(client({ url, token, accessId, accessSecret }), repos);
    for (const c of out.changes) console.log(`${c.repo}${c.issue ? ` #${c.issue}` : ""}: change ${c.id} ${c.state}, ${c.judgments} judgments`);
    for (const r of out.runs) console.log(`${r.repo} flow ${r.flow}: ${r.status} (${Object.entries(r.steps).map(([s, v]) => `${s} ${v}`).join(", ")})`);
    for (const s of out.scans) console.log(`${s.repo} scan: ${s.status}`);
    if (out.failures.length) throw new Error(out.failures.join("\n"));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
