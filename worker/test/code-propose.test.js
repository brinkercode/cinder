import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, onTestFinished } from "vitest";
import { commit } from "../src/git/index.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const ANN = { name: "Ann", email: "ann@x.test", time: 1700000000 };

it("a multi-file proposal from Code leaves the change verifying with a verify job on the committed head", async () => {
  const fake = fakeArtifacts();
  const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
  expect((await call("/api/repos", { name: "propose" })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("propose")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });

  // proposeFiles (web/src/client.js): create, take over, then one commit of every staged file on the change's fork.
  const created = await (await call("/api/repos/propose/changes", { intent: "Add discount", target_branch: "main" })).json();
  expect((await call(`/api/changes/${created.id}/takeover`)).status).toBe(200);
  await git(["init", "-q", "--bare", "-b", "main", `${created.fork}.git`]);
  const base = await commit(bareRepo(created.fork), { branch: "main", base: null, message: "base", author: ANN, changes: [{ path: "README", content: "hi\n" }] });
  const get = fake.get;
  fake.get = async (name) => (name === created.fork ? bareRepo(name) : get(name));
  const res = await call(`/api/repos/${created.fork}/commits`, { branch: "main", base_sha: base.sha, message: "Add discount",
    changes: [{ path: "src/discount.js", content: "export const discount = 1;\n" }, { path: "README", content: "discounts\n" }] });
  expect(res.status).toBe(201);
  const { sha } = await res.json();

  const change = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(created.id)).get();
  expect(change.state).toBe("verifying");
  const { results } = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'verify' AND status = 'queued'").bind(created.id).all();
  expect(results.map((j) => JSON.parse(j.payload).head_sha)).toEqual([sha]);
  expect(await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(created.id).first("head_sha")).toBe(sha);
});
