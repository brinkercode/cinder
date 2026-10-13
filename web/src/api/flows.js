import { validateFlowFile } from "../../../worker/src/api/contract.js";
import { fetchJson } from "../client.js";

// GET /api/repos/:name/flows/:flow?ref= → FlowFile: one flow's YAML, head and its last run's step statuses.
export async function flowFile(repo, flow, ref) {
  const path = `/api/repos/${encodeURIComponent(repo)}/flows/${encodeURIComponent(flow)}?ref=${encodeURIComponent(ref)}`;
  const body = await fetchJson(path), { ok, errors } = validateFlowFile(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}
