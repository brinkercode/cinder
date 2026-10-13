import { validateFlowAnnotation, validateFlowArtifact, validateFlowLogPage, validateFlowRunTree, validateFlowTests } from "../../../worker/src/api/contract.js";
import annotations from "../../../worker/src/api/fixtures/flow-annotations.json";
import fixture from "../../../worker/src/api/fixtures/flow-run-tree.json";
import { checked, fetchJson, fixtures, postJson } from "../client.js";

const runPath = (repo, id) => `/api/repos/${encodeURIComponent(repo)}/flow-runs/${encodeURIComponent(id)}`;

// GET /api/repos/:name/flow-runs/:id → FlowRunTree. Fixtures serve flow-run-tree.json for its id, else a 404.
export async function flowRunTree(repo, id) {
  const path = runPath(repo, id);
  if (fixtures() && id !== fixture.id) throw Object.assign(new Error(`${path}: HTTP 404`), { status: 404 });
  const body = fixtures() ? fixture : await fetchJson(path);
  const { ok, errors } = validateFlowRunTree(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// GET …/annotations, …/tests and …/artifacts → {notes, tests, artifacts} for the run's Summary. Fixtures serve
// flow-annotations.json and no tests or artifacts.
export async function flowRunResults(repo, id) {
  const path = runPath(repo, id);
  const [notes, tests, artifacts] = fixtures() ? [annotations, [], []]
    : await Promise.all(["annotations", "tests", "artifacts"].map((k) => fetchJson(`${path}/${k}`)));
  const { ok, errors } = validateFlowTests(tests);
  if (!ok) throw new Error(`${path}/tests: ${errors.join("; ")}`);
  return { notes: checked(`${path}/annotations`, notes, validateFlowAnnotation), tests, artifacts: checked(`${path}/artifacts`, artifacts, validateFlowArtifact) };
}

// POST /api/repos/:name/flow-runs/:id/rerun {scope: all|failed|job, key?} → {id, attempt}.
export const rerunFlowRun = (repo, id, scope, key) => postJson(`${runPath(repo, id)}/rerun`, { scope, key });

// …/jobs/:key/log.txt: the job's whole stored log.
export const logTextUrl = (repo, id, key) => `${runPath(repo, id)}/jobs/${encodeURIComponent(key)}/log.txt`;

// GET …/jobs/:key/log?step=&from= → FlowLogPage. Fixtures serve an empty page.
export async function flowLogPage(repo, id, key, step, from) {
  const path = `${runPath(repo, id)}/jobs/${encodeURIComponent(key)}/log?step=${step}&from=${from}`;
  const body = fixtures() ? { step, from, lines: [] } : await fetchJson(path);
  const { ok, errors } = validateFlowLogPage(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// POST /api/repos/:name/flow-runs/:id/cancel → 202.
export const cancelFlowRun = (repo, id) => postJson(`${runPath(repo, id)}/cancel`, {});
