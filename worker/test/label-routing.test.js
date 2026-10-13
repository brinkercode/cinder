import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

// A repo whose default branch holds .cinder.yml `yml`.
async function setup(name, yml) {
  const fake = fakeArtifacts();
  const call = (path, body, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  fake.repos.get(name).files[".cinder.yml"] = yml;
  fake.repos.get(name).commits.unshift({ sha: "c1" });
  return call;
}

const ROUTES = `routes:
  - { label: payments, agent: payments@v3 }
  - { label: security, reviewer: Sec@example.com }
`;

describe("label routing", () => {
  it("a change labelled payments gets the agent its rule names", async () => {
    const call = await setup("route-agent", ROUTES);
    const res = await call("/api/repos/route-agent/changes", { intent: "refund flow", labels: ["payments"] });
    expect(res.status).toBe(201);
    const change = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName((await res.json()).id)).get();
    expect(change.agent_version).toBe("payments@v3");
    expect(change.events.find((e) => e.kind === "routed")).toMatchObject({ reason: "routes: label payments → agent payments@v3" });
  });

  it("a reviewer rule requests that reviewer when the label is added later", async () => {
    const call = await setup("route-reviewer", ROUTES);
    const { id } = await (await call("/api/repos/route-reviewer/changes", { intent: "rotate keys", draft: true })).json();
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).reviewers).toBeUndefined();
    const res = await call(`/api/changes/${id}`, { labels: ["security"] }, "PATCH");
    expect(res.status).toBe(200);
    const change = await res.json();
    expect(change.reviewers).toEqual([{ person: "sec@example.com" }]);
    expect(change.events.at(-1)).toMatchObject({ kind: "routed", reason: "routes: label security → reviewer Sec@example.com" });
    // Labels changing without changing the matching rule apply nothing again.
    const again = await (await call(`/api/changes/${id}`, { labels: ["security", "docs"] }, "PATCH")).json();
    expect(again.events.filter((e) => e.kind === "routed")).toHaveLength(1);
  });

  it("a rule naming two targets is rejected with 422", async () => {
    const call = await setup("route-bad", "routes:\n  - { label: payments, agent: payments@v3, reviewer: sec@example.com }\n");
    const res = await call("/api/repos/route-bad/policy", undefined, "GET");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "invalid_policy", message: expect.stringContaining("routes[0]") });
    expect((await call("/api/repos/route-bad/changes", { intent: "x" })).status).toBe(422);
  });
});
