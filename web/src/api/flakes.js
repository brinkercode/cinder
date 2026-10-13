import { validateFlake } from "../../../worker/src/api/contract.js";
import { checked, fetchJson, fixtures, postJson } from "../client.js";

// GET /api/repos/:name/flakes[?sha=]: each test's flake rate and quarantine; with sha, its result there. Fixtures serve none.
export async function flakes(repo, sha) {
  const path = `/api/repos/${encodeURIComponent(repo)}/flakes${sha ? `?sha=${encodeURIComponent(sha)}` : ""}`;
  return checked(path, fixtures() ? [] : await fetchJson(path), validateFlake);
}

// POST /api/repos/:name/flakes/:test/release: the test counts in the verdict again from the next run.
export const releaseFlake = (repo, test) => postJson(`/api/repos/${encodeURIComponent(repo)}/flakes/${encodeURIComponent(test)}/release`, {});

// "Oct 2" for a quarantined_since or since timestamp.
export const sinceDay = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
