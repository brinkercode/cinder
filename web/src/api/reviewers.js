import { validateJudges, validateSuggestedReviewer } from "../../../worker/src/api/contract.js";
import { checked, fetchJson, fixtures, list, postJson } from "../client.js";

// The Request picker's rows: suggested owners of the touched paths, people, and the repo's judges as agent versions
// "<kind>@<model_version>". Fixture mode serves the people fixture and no suggestions or judges. /api/people is for
// managers only: without it the picker lists no people, but suggestions and judges still load.
export async function reviewerSources(repo, id) {
  const sugPath = `/api/changes/${encodeURIComponent(id)}/reviewers/suggested`, judgePath = `/api/repos/${encodeURIComponent(repo)}/judges`;
  const [people, suggested, judges] = await Promise.all([list("/api/people").catch(() => []), fixtures() ? [] : fetchJson(sugPath), fixtures() ? null : fetchJson(judgePath)]);
  if (judges) {
    const { ok, errors } = validateJudges(judges);
    if (!ok) throw new Error(`${judgePath}: ${errors.join("; ")}`);
  }
  return { people: people.map((p) => p.email), suggested: checked(sugPath, suggested, validateSuggestedReviewer),
    judges: [...new Set((judges?.judges ?? []).map((j) => `${j.kind}@${j.model_version}`))] };
}

// DELETE /api/changes/:id/reviewers/:who. Fixture mode deletes nothing.
export const removeReviewer = (id, who) => postJson(`/api/changes/${encodeURIComponent(id)}/reviewers/${encodeURIComponent(who)}`, undefined, "DELETE");
