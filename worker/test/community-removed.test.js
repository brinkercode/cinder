import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const call = (method, path, body = {}) => worker.fetch(new Request(`http://cinder.test${path}`, {
  method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: method === "GET" ? undefined : JSON.stringify(body),
}), { ...env, ARTIFACTS: fakeArtifacts() });

it("Worker test: the explore, topics, stars/like and pins routes answer 404", async () => {
  expect((await call("POST", "/api/repos", { name: "gone-community" })).status).toBe(201);
  const routes = [["GET", "/api/explore"], ["GET", "/api/topics/go"], ["PUT", "/api/topics/go"], ["PUT", "/api/topics/go/pins"],
    ["PUT", "/api/topics/go/follow"], ["DELETE", "/api/topics/go/follow"], ["GET", "/api/me/topics"], ["GET", "/api/me/cheers"],
    ["PUT", "/api/repos/gone-community/topics"], ["POST", "/api/repos/gone-community/topic-suggestions/j1"],
    ...["star", "like", "cheer"].flatMap((v) => [["PUT", `/api/repos/gone-community/${v}`], ["DELETE", `/api/repos/gone-community/${v}`]])];
  for (const [method, path] of routes) expect((await call(method, path)).status, `${method} ${path}`).toBe(404);
});
