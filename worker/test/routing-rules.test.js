import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateLabelRouting, validateWorkItem } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const fake = fakeArtifacts();
const call = (path, method = "POST", body) => worker.fetch(
  new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }),
  { ...env, ARTIFACTS: fake },
);
const changeOf = (id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get();
const itemOf = async (repo, id) => (await (await call(`/api/repos/${repo}/work`, "GET")).json()).items.find((i) => i.change_id === id);

// A repo whose target head is not indexed yet, so a new change stays planned, with issues #1 and #2.
async function setup(name) {
  expect((await call("/api/repos", "POST", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  fake.repos.get(name).commits.push({ sha: "a".repeat(40), message: "init" });
  for (const title of ["Cart overflows", "Pay page"]) expect((await call(`/api/repos/${name}/issues`, "POST", { title })).status).toBe(201);
}

describe("label routing", () => {
  it("a routing rule fires when the label is added: an agent claims the intent, a person drives, a reviewer is requested", async () => {
    await setup("route-fire");
    const rules = [{ label: "auto", agent: "developer@v3" }, { label: "pay", driver: "ann@example.com" }, { label: "sec", reviewer: "sam@example.com" }];
    expect((await call("/api/repos/route-fire/routing", "PUT", { rules: [{ label: "x", agent: "a", driver: "b" }] })).status).toBe(400);
    const put = await call("/api/repos/route-fire/routing", "PUT", { rules });
    expect(put.status).toBe(200);
    const got = await (await call("/api/repos/route-fire/routing", "GET")).json();
    expect(validateLabelRouting(got).errors).toEqual([]);
    expect(got.rules).toEqual(rules);

    // Intents: the agent rule claims #1 with a change by its agent; the person rule assigns #2 to that person.
    expect((await call("/api/repos/route-fire/issues/1", "PATCH", { labels: ["auto"] })).status).toBe(200);
    const claimed = await env.DB.prepare("SELECT l.change_id FROM issue_links l JOIN issues i ON i.id = l.issue_id JOIN repos r ON r.id = i.repo_id " +
      "WHERE r.name = 'route-fire' AND i.number = 1").first("change_id");
    expect((await changeOf(claimed)).agent_version).toBe("developer@v3");
    expect((await (await call("/api/repos/route-fire/issues/2", "PATCH", { labels: ["pay"] })).json()).assignee).toBe("ann@example.com");

    // Changes: the person rule makes them its driver, the reviewer rule requests their review.
    const make = async () => (await (await call("/api/repos/route-fire/changes", "POST", { intent: "Pay flow" })).json()).id;
    const [driven, reviewed] = [await make(), await make()];
    expect((await call(`/api/changes/${driven}`, "PATCH", { labels: ["pay"] })).status).toBe(200);
    expect((await changeOf(driven)).driver).toBe("ann@example.com");
    expect((await call(`/api/changes/${reviewed}`, "PATCH", { labels: ["sec"] })).status).toBe(200);
    expect((await changeOf(reviewed)).reviewers).toEqual([{ person: "sam@example.com" }]);
  });

  it("label edits on a change that carries an intent show on its board card", async () => {
    await setup("route-card");
    const { id } = await (await call("/api/repos/route-card/changes", "POST", { intent: "#1 Cart overflows" })).json();
    expect((await call(`/api/changes/${id}`, "PATCH", { labels: ["cart"], priority: "P1" })).status).toBe(200);
    const item = await itemOf("route-card", id);
    expect(validateWorkItem(item).errors).toEqual([]);
    expect(item).toMatchObject({ n: 1, labels: ["cart"], priority: "P1" });
  });
});
