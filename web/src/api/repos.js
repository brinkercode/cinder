import { validateRepo } from "../../../worker/src/api/contract.js";
import repos from "../../../worker/src/api/fixtures/repos.json";
import { fetchJson, fixtures } from "../client.js";

// GET /api/repos/:name → Repo: one repo without waiting on the shell's repo list. A missing repo throws a 404 Response.
export async function repoNamed(name) {
  const path = `/api/repos/${encodeURIComponent(name)}`;
  const body = fixtures() ? repos.find((r) => r.name === name)
    : await fetchJson(path).catch((e) => { throw e.status === 404 ? new Response("Repo not found", { status: 404 }) : e; });
  if (!body) throw new Response("Repo not found", { status: 404 });
  const { ok, errors } = validateRepo(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}
