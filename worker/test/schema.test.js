import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("release_promotions is not in the migrated schema", async () => {
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'release_promotions'").first()).toBeNull();
});

it("teams and team_members are not in the migrated schema", async () => {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('teams', 'team_members')").all();
  expect(results).toEqual([]);
});

it("repo_visibility is not in the migrated schema", async () => {
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'repo_visibility'").first()).toBeNull();
});

it("job_egress, wiki_page_versions, regressions and repo_events are not in the migrated schema", async () => {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('job_egress', 'wiki_page_versions', 'regressions', 'repo_events')").all();
  expect(results).toEqual([]);
});
