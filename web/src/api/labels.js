import { validateLabelRouting } from "../../../worker/src/api/contract.js";
import { fetchJson, fixtures, postJson } from "../client.js";

// PATCH {labels?, priority?} on a change or an intent (issue #n); each answers the saved record.
export const editChange = (id, body) => postJson(`/api/changes/${encodeURIComponent(id)}`, body, "PATCH");
export const editIntent = (repo, n, body) => postJson(`/api/repos/${encodeURIComponent(repo)}/issues/${n}`, body, "PATCH");

const routingPath = (repo) => `/api/repos/${encodeURIComponent(repo)}/routing`;
const valid = (path, body) => {
  const { ok, errors } = validateLabelRouting(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
};
// GET/PUT /api/repos/:name/routing {rules}. Fixtures serve no rules.
export const getRouting = async (repo) => (fixtures() ? { rules: [] } : valid(routingPath(repo), await fetchJson(routingPath(repo))));
export const putRouting = async (repo, rules) => valid(routingPath(repo), await postJson(routingPath(repo), { rules }, "PUT"));
