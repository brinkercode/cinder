import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished } from "vitest";
import { validateIssue, validateIssueDetail } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

async function setup(name) {
  const fake = fakeArtifacts();
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  expect((await call("POST", "/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  return call;
}

const merge = async (id) => {
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
  await runInDurableObject(stub, async (i) => { await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "in_queue" }); });
  await stub.transition("merged", { kind: "merge_done", actor: { type: "system", id: "r1" }, action: "job.report", target: id, result: "done" });
};

describe("issues", () => {
  it("create, comment, label, assign, close and link an issue to a change; all persist after a reload", async () => {
    const call = await setup("iss-crud");
    const at = "/api/repos/iss-crud/issues";
    const first = await call("POST", at, { title: "Checkout drops the cart", body: "Steps…" });
    expect(first.status).toBe(201);
    expect(validateIssue(first.json)).toEqual({ ok: true, errors: [] });
    expect((await call("POST", at, { title: "Second" })).json.number).toBe(2);
    expect((await call("POST", at, { title: " " })).status).toBe(400);
    const n = first.json.number;
    expect((await call("POST", `${at}/${n}/comments`, { body: "Seen on mobile too" })).status).toBe(201);
    expect((await call("POST", `${at}/${n}/comments`, { body: "" })).status).toBe(400);
    expect((await call("PATCH", `${at}/${n}`, { labels: ["bug", "bug", "checkout"], assignee: "ada@example.com" })).status).toBe(200);
    expect((await call("PATCH", `${at}/${n}`, { labels: [""] })).status).toBe(400);
    expect((await call("PATCH", `${at}/${n}`, { state: "done" })).status).toBe(400);
    const closed = await call("PATCH", `${at}/${n}`, { state: "closed" });
    expect(validateIssue(closed.json)).toEqual({ ok: true, errors: [] });
    const change = (await call("POST", "/api/repos/iss-crud/changes", { intent: "keep the cart on reload" })).json;
    expect((await call("PUT", `${at}/${n}/changes/${change.id}`)).status).toBe(204);
    expect((await call("PUT", `${at}/${n}/changes/nope`)).status).toBe(404);
    expect((await call("GET", `${at}/99`)).status).toBe(404);

    const reloaded = (await call("GET", `${at}/${n}`)).json;
    expect(validateIssueDetail(reloaded)).toEqual({ ok: true, errors: [] });
    expect(reloaded).toMatchObject({ state: "closed", labels: ["bug", "checkout"], assignee: "ada@example.com" });
    expect(reloaded.comments.map((c) => c.body)).toEqual(["Seen on mobile too"]);
    expect(reloaded.changes.map((c) => c.id)).toEqual([change.id]);
    expect((await call("GET", at)).json.map((i) => [i.number, i.state])).toEqual([[2, "open"], [1, "closed"]]);
    const reopened = (await call("PATCH", `${at}/${n}`, { state: "open", assignee: null })).json;
    expect(reopened).toMatchObject({ state: "open", assignee: null, closed_at: null });
  });

  it("PATCH an issue's priority and labels", async () => {
    const call = await setup("iss-prio");
    const at = "/api/repos/iss-prio/issues";
    const { number } = (await call("POST", at, { title: "Cart overflows" })).json;
    expect((await call("PATCH", `${at}/${number}`, { priority: "urgent" })).status).toBe(400);
    expect((await call("PATCH", `${at}/${number}`, { labels: "cart" })).status).toBe(400);
    const res = await call("PATCH", `${at}/${number}`, { priority: "P1", labels: ["cart", "ui"] });
    expect(res.status).toBe(200);
    expect(validateIssue(res.json)).toEqual({ ok: true, errors: [] });
    expect((await call("GET", `${at}/${number}`)).json).toMatchObject({ priority: "P1", labels: ["cart", "ui"] });
  });

  it("a change naming #n links the issue and merging it with fixes #n closes the issue", async () => {
    const call = await setup("iss-fixes");
    const at = "/api/repos/iss-fixes/issues";
    for (const title of ["one", "two", "three"]) await call("POST", at, { title });
    const change = (await call("POST", "/api/repos/iss-fixes/changes", { intent: "Fixes #1, see #2" })).json;
    expect((await call("GET", `${at}/2`)).json.changes.map((c) => c.id)).toEqual([change.id]);
    expect((await call("GET", `${at}/1`)).json.state).toBe("open");
    await merge(change.id);
    const states = (await call("GET", at)).json.map((i) => [i.number, i.state]);
    expect(states).toEqual([[3, "open"], [2, "open"], [1, "closed"]]);
  });

  it("an issue moved to In review shows Done after its fix merges", async () => {
    const call = await setup("iss-board-merge");
    const at = "/api/repos/iss-board-merge/issues";
    await call("POST", at, { title: "one" });
    expect((await call("PATCH", `${at}/1`, { status: "review" })).json.status).toBe("review");
    const change = (await call("POST", "/api/repos/iss-board-merge/changes", { intent: "Fixes #1" })).json;
    await merge(change.id);
    expect((await call("GET", `${at}/1`)).json).toMatchObject({ state: "closed", status: "done" });
    expect((await call("GET", at)).json.map((i) => i.status)).toEqual(["done"]);
  });
});
