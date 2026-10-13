import { validateService } from "../../../worker/src/api/contract.js";
import services from "../../../worker/src/api/fixtures/services.json";
import { checked, fetchJson, fixtures, flowsFor } from "../client.js";

// GET /api/repos/:name/services → {ref, sha, services}, plus `added`: the flow names already in .cinder/flows at that ref.
export async function servicesFor(repo) {
  const path = `/api/repos/${encodeURIComponent(repo)}/services`;
  const body = fixtures() ? { ref: null, sha: null, services } : await fetchJson(path);
  const { list } = body.sha ? await flowsFor({ name: repo }, body.ref) : { list: [] };
  return { ...body, services: checked(path, body.services, validateService), added: list.map((f) => f.flow) };
}
