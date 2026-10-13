import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { validateNeed } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const ENV = { ...ACCESS, ARTIFACTS: fakeArtifacts() };
const call = (path, body, headers = OWNER, method = body ? "POST" : "GET") =>
  worker.fetch(new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }), ENV);
const needs = async (headers = OWNER) => (await call("/api/needs", undefined, headers)).json();

// A repo with a page mentioning parseConfig; returns the repo's id.
async function repoWithPage(name) {
  expect((await call("/api/repos", { name })).status).toBe(201);
  const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO wiki_pages VALUES (?, ?, NULL, 'Config', 'config', 'page', 'Startup calls parseConfig.', 1, 0, ?, ?)")
    .bind(`${name}-page`, id, now, now).run();
  return id;
}

afterEach(() => vi.restoreAllMocks());

describe("wiki needs", () => {
  it("a comment on a wiki page raises a Wiki comment need for the page's last editor", async () => {
    serveCerts();
    await repoWithPage("nw-comment");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO wiki_editors VALUES ('nw-comment-page', 'ana@example.com', ?)").bind(new Date().toISOString()),
      env.DB.prepare("INSERT OR IGNORE INTO person_roles VALUES ('ana@example.com', 'viewer')"),
    ]);
    const boss = await as("boss@example.com");
    expect((await call("/api/repos/nw-comment/wiki/pages/nw-comment-page/comments", { body: "typo in step 2" }, boss)).status).toBe(201);
    const mine = (await needs(await as("ana@example.com"))).filter((n) => n.repo === "nw-comment");
    expect(mine).toEqual([{ id: expect.any(String), kind: "Wiki comment", repo: "nw-comment", change: null, page: "nw-comment-page",
      text: "boss@example.com commented on Config: typo in step 2", actions: ["Open page", "Resolve"] }]);
    expect(validateNeed(mine[0]).errors).toEqual([]);
    expect((await needs(boss)).filter((n) => n.repo === "nw-comment")).toEqual([]);
    expect((await call(`/api/needs/${mine[0].id}/resolve`, { action: "Resolve" })).status).toBe(200);
    expect(await needs(await as("ana@example.com"))).not.toContainEqual(expect.objectContaining({ repo: "nw-comment" }));
  });

  it("a merge that touches a page's sources raises one Stale wiki page need and Mark reviewed clears it", async () => {
    const repo_id = await repoWithPage("nw-stale");
    const id = "nw-stale-c";
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'in_queue', '')").bind(id, repo_id).run();
    const change = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await runInDurableObject(change, (i) => i.ctx.storage.put({ change: { id, repo_id, target_branch: "main", state: "in_queue" }, events: [] }));
    await env.REPO_DO.get(env.REPO_DO.idFromName("nw-stale")).grant("main", id, ["src/config.js#parseConfig"]);
    await change.transition("merged", { kind: "merge_done", actor: { type: "system", id: "r1" }, action: "job.report", target: "j1", result: "done" });
    const stale = (await needs()).filter((n) => n.repo === "nw-stale");
    expect(stale).toEqual([{ id: expect.any(String), kind: "Stale wiki page", repo: "nw-stale", change: id, page: "nw-stale-page",
      text: `Config names code ${id} changed`, actions: ["Mark reviewed", "Edit", "Hand to agent"] }]);
    expect((await call(`/api/needs/${stale[0].id}/resolve`, { action: "Mark reviewed" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM wiki_stale WHERE page_id = 'nw-stale-page'").first()).toBeNull();
    expect((await needs()).filter((n) => n.repo === "nw-stale")).toEqual([]);
  });

  it("Hand to agent on a Stale wiki page opens a change to update the page", async () => {
    await repoWithPage("nw-hand");
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("nw-hand")), (i) => { i.env = { ...i.env, ARTIFACTS: ENV.ARTIFACTS }; });
    env.ARTIFACTS = ENV.ARTIFACTS;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO needs (id, kind, repo, change_id, text, actions, created_at) VALUES (?, 'Stale wiki page', 'nw-hand', NULL, 'Config is stale', ?, ?)")
        .bind(id, JSON.stringify(["Mark reviewed", "Hand to agent"]), new Date().toISOString()),
      env.DB.prepare("INSERT INTO need_subjects VALUES (?, ?)").bind(id, JSON.stringify({ page: "nw-hand-page", title: "Config" })),
    ]);
    // The picked agent reaches the new change; a bad pick is refused and leaves the item open.
    expect((await call(`/api/needs/${id}/resolve`, { action: "Hand to agent", agent: 5 })).status).toBe(400);
    const res = await call(`/api/needs/${id}/resolve`, { action: "Hand to agent" });
    expect(res.status).toBe(200);
    const { change } = await res.json();
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change)).get()).title).toBe("Update wiki page Config");
  });
});
