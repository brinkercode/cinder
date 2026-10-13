import { validateJudgeConfig } from "../../../worker/src/api/contract.js";
import { postJson } from "../client.js";

// PUT /api/repos/:name/judges/:kind/airlock: the judge's setting, airlock as asked. It applies from the judge's next verdict.
export async function setJudgeAirlock(repo, kind, on) {
  const path = `/api/repos/${encodeURIComponent(repo)}/judges/${encodeURIComponent(kind)}/airlock`;
  const body = await postJson(path, { on }, "PUT");
  const { ok, errors } = validateJudgeConfig(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}
