import { validateAgentSuggestion, validateIssueDetail, validateWorkBoard, validateWorkItem } from "../../../worker/src/api/contract.js";
import work from "../../../worker/src/api/fixtures/work.json";
import { checked, fetchJson, fixtures, postJson } from "../client.js";

const api = (repo, rest) => `/api/repos/${encodeURIComponent(repo)}${rest}`;

// GET /api/repos/:name/work: every open issue and live change once, in its lane, plus the tiles. Fixtures serve work.json.
export async function workFor(repo) {
  const path = `/api/repos/${encodeURIComponent(repo)}/work`;
  const body = fixtures() ? work : await fetchJson(path);
  const { ok, errors } = validateWorkBoard(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// GET …/agents/suggest?issue=n: agent versions by p(merge) on the repo, best first. Fixtures serve none.
export async function suggestAgents(repo, n) {
  if (fixtures()) return [];
  const path = api(repo, `/agents/suggest?issue=${n}`);
  return checked(path, await fetchJson(path), validateAgentSuggestion);
}

// GET …/issues/:n for the intent drawer's body; null in fixture mode.
export async function issueFor(repo, n) {
  if (fixtures()) return null;
  const path = api(repo, `/issues/${n}`);
  const body = await fetchJson(path);
  const { ok, errors } = validateIssueDetail(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// POST …/issues/:n/claim {mode, agents?} → the board item now carrying #n.
export async function claimIntent(repo, n, body) {
  const path = api(repo, `/issues/${n}/claim`);
  const item = await postJson(path, body);
  const { ok, errors } = validateWorkItem(item);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return item;
}
// DELETE …/issues/:n/claim: closes #n's changes while none has a commit (409 verifier_owned after one).
export const unclaimIntent = (repo, n) => postJson(api(repo, `/issues/${n}/claim`), undefined, "DELETE");
