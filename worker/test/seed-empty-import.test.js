// The live checkout-js was created empty by an older seed and has no refs at all (seed-checkout.test.js converges it).
// Its own file: storage is shared within a file, and the other seed files need checkout-js fresh.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { REPOS, client } from "../../seed/seed.mjs";
import worker from "../src/index.js";
import { seedArtifacts } from "./fakes/seed.js";

const fake = seedArtifacts();
const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), { ...env, ARTIFACTS: fake }) });

beforeAll(async () => {
  env.ARTIFACTS = fake;
  await api("POST", "/api/repos", { name: REPOS.gitflow });
  // No refs: every branch logs empty, as on the live instance.
  fake.repos.get(REPOS.gitflow).branches = [];
});
afterAll(() => { delete env.ARTIFACTS; });

it("re-importing a repo that has commits is refused, so nothing is deleted", async () => {
  // Commits on every branch again (beforeAll left it with no refs).
  delete fake.repos.get(REPOS.gitflow).branches;
  fake.repos.get(REPOS.gitflow).files["src/index.js"] = "export {};\n";
  const res = await worker.fetch(new Request(`http://cinder.test/api/repos/${REPOS.gitflow}/import`, { method: "POST",
    headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ url: "https://github.com/octocat/Hello-World.git", branch: "develop" }) }), { ...env, ARTIFACTS: fake });
  expect(res.status).toBe(409);
  expect(fake.calls.filter((c) => c.method === "delete" && c.args[0] === REPOS.gitflow)).toHaveLength(0);
});
