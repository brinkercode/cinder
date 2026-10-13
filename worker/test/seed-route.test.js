// POST /api/repos/:name/seed into a relay bare repo.
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import worker from "../src/index.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const dir = crypto.randomUUID();
const repo = `seed-route-${dir.slice(0, 8)}`;
const seed = (body) => worker.fetch(new Request(`http://cinder.test/api/repos/${repo}/seed`, { method: "POST",
  headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify(body) }), { ...env, ARTIFACTS: { get: async (name) => bareRepo(`${dir}-${name}`) } });
const shas = async (body) => (await (await seed(body)).json()).shas;
const at = (ref) => git(["--git-dir", `${dir}-${repo}.git`, "rev-parse", ref]);

beforeAll(async () => {
  await git(["init", "-q", "--bare", "-b", "main", `${dir}-${repo}.git`]);
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', '2026-10-01T00:00:00Z')").bind(repo, repo).run();
  await shas({ commits: [{ author: "ana", message: "Scaffold", files: { "README.md": "# r\n" } }] });
  await shas({ branch: "feature/x", from: "main", commits: [{ author: "ben", message: "Add x", files: { "x.txt": "x\n" } }] });
});

it("a seed commit with merge has the merged branch head as its second parent", async () => {
  const [main, feature] = [await at("main"), await at("feature/x")];
  const [merge] = await shas({ commits: [{ author: "ana", message: "Merge feature/x into main", merge: "feature/x", files: { "x.txt": "x\n" } }] });
  expect(await git(["--git-dir", `${dir}-${repo}.git`, "log", "-1", "--format=%P", merge])).toBe(`${main} ${feature}`);
  expect(await git(["--git-dir", `${dir}-${repo}.git`, "ls-tree", "-r", "--name-only", merge])).toBe("README.md\nx.txt");
});

it("POST /seed answers 404 outside nonprod", async () => {
  const before = await at("main");
  for (const CINDER_ENV of [undefined, "production"]) {
    const res = await worker.fetch(new Request(`http://cinder.test/api/repos/${repo}/seed`, { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
      body: JSON.stringify({ commits: [{ author: "ana", message: "Prod", files: { "p.txt": "p\n" } }] }) }), { ...env, CINDER_ENV, ARTIFACTS: { get: async (name) => bareRepo(`${dir}-${name}`) } });
    expect(res.status).toBe(404);
  }
  expect(await at("main")).toBe(before);
});

it("a seed commit merging a missing branch answers 400", async () => {
  const before = await at("main");
  const res = await seed({ commits: [{ author: "ana", message: "Merge feature/gone", merge: "feature/gone", files: { "y.txt": "y\n" } }] });
  expect(res.status).toBe(400);
  expect(await at("main")).toBe(before);
});
