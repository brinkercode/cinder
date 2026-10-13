import fixtures from "../../worker/src/api/fixtures/repos.json";

// What a fake fetch answers for the repos: the list at /api/repos, one repo at /api/repos/:name, else undefined.
export const repoAt = (url, repos = fixtures) => (url === "/api/repos" ? repos : repos.find((r) => url === `/api/repos/${encodeURIComponent(r.name)}`));
