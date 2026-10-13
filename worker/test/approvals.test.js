import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { validateChangeDetail, validateNeed } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

beforeEach(serveCerts);
afterEach(() => vi.restoreAllMocks());

// A repo whose production environment is gated on the "production owners" role, with a promote of a published
// release waiting on a Release approval; dev@ is a developer, prod@ holds "production owners".
async function gated(name) {
  const fake = fakeArtifacts();
  const created = [];
  const PIPELINE = { create: async (opts) => { created.push(opts); return { id: opts.id }; } };
  const call = async (method, path, body, headers = OWNER) => {
    const res = await worker.fetch(new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }), { ...ACCESS, ARTIFACTS: fake, PIPELINE });
    return { status: res.status, json: await res.json() };
  };
  await call("POST", "/api/repos", { name });
  fake.repos.get(name).files[".cinder.yml"] = "deploy:\n  environments:\n    - { name: production, branch: main, approvers: production owners }\n  worker: wrangler.jsonc\n";
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: name },
    payload: { ref: "refs/tags/v1.0.0", before: "0".repeat(40), after: "a".repeat(40), commits: [{ message: "v1" }] } } }] }, env);
  const release = (await call("POST", `/api/repos/${name}/releases`, { tag: "v1.0.0", title: "One" })).json;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO roles (name, capabilities) VALUES ('production owners', '[\"repo.read\",\"repo.write\"]')"),
    env.DB.prepare("INSERT OR REPLACE INTO person_roles (email, role) VALUES ('dev@appr.test', 'developer'), ('prod@appr.test', 'production owners')"),
  ]);
  const { need } = (await call("POST", `/api/repos/${name}/environments/production/promote`, { release: release.id })).json;
  return { call, created, need, fake };
}

it("a developer outside production owners can't approve a production release", async () => {
  const { call, created, need } = await gated("appr-dev");
  for (const action of ["Approve", "Reject", "Dismiss"]) {
    const res = await call("POST", `/api/needs/${need}/resolve`, { action }, await as("dev@appr.test"));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("not_an_approver");
  }
  expect(created).toEqual([]);
  expect((await call("GET", "/api/needs")).json.some((n) => n.id === need)).toBe(true);
});

it("a production owner approves and the release syncs", async () => {
  const { call, created, need } = await gated("appr-owner");
  expect((await call("POST", `/api/needs/${need}/resolve`, { action: "Approve" }, await as("prod@appr.test"))).status).toBe(200);
  expect(created.map((c) => c.params)).toMatchObject([{ repo: "appr-owner", branch: "main", sha: "a".repeat(40), actor: "prod@appr.test" }]);
  expect((await call("GET", "/api/needs")).json.some((n) => n.id === need)).toBe(false);
});

it("needs lists can_resolve false for a non-approver", async () => {
  const { call, need } = await gated("appr-list");
  const item = async (email) => (await call("GET", "/api/needs", undefined, await as(email))).json.find((n) => n.id === need);
  const dev = await item("dev@appr.test");
  expect(dev).toMatchObject({ kind: "Release approval", approvers: "production owners", can_resolve: false });
  expect(validateNeed(dev)).toEqual({ ok: true, errors: [] });
  expect(await item("prod@appr.test")).toMatchObject({ approvers: "production owners", can_resolve: true });
});

// A change on a gated repo, read as each person: maint@ is a maintainer (change.approve), dev@ a developer.
async function change(name) {
  const { call, need, fake } = await gated(name);
  env.ARTIFACTS = fake; // the repo's Durable Object reads its policy through the global env
  onTestFinished(() => { delete env.ARTIFACTS; });
  await env.DB.prepare("INSERT OR REPLACE INTO person_roles (email, role) VALUES ('maint@appr.test', 'maintainer')").run();
  const { id } = (await call("POST", `/api/repos/${name}/changes`, { intent: "add retries" })).json;
  const read = async (email) => (await call("GET", `/api/changes/${id}`, undefined, await as(email))).json;
  return { call, need, read };
}

it("disabled state comes from can_resolve and the gate role: the change detail's can_approve is the caller's change.approve", async () => {
  const { read } = await change("appr-can");
  const dev = await read("dev@appr.test");
  expect(dev.can_approve).toBe(false);
  expect(validateChangeDetail(dev)).toEqual({ ok: true, errors: [] });
  expect((await read("maint@appr.test")).can_approve).toBe(true);
});

it("who can approve is listed by name: the need's approver_names and the change detail's approvers", async () => {
  const { call, need, read } = await change("appr-names");
  const item = (await call("GET", "/api/needs", undefined, await as("dev@appr.test"))).json.find((n) => n.id === need);
  expect(item.approver_names).toContain("prod@appr.test");
  expect(item.approver_names).not.toContain("dev@appr.test");
  expect(validateNeed(item)).toEqual({ ok: true, errors: [] });
  const { approvers } = await read("dev@appr.test");
  expect(approvers).toContain("maint@appr.test");
  expect(approvers).not.toContain("dev@appr.test");
});
