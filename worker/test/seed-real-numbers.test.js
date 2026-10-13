// The seed writes no made-up judge outcomes, gateway logs, race legs or model runs: those come only from real runners.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { client, seed } from "../../seed/seed.mjs";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";
import { seedArtifacts } from "./fakes/seed.js";

const fake = seedArtifacts();
const cf = fakeCloudflare();
const real = (url, init) => worker.fetch(signedIn(url, init), { ...env, ARTIFACTS: fake, ...cf.env });

beforeAll(() => { env.ARTIFACTS = fake; vi.stubGlobal("fetch", cf.through(real)); });
afterAll(() => { delete env.ARTIFACTS; vi.unstubAllGlobals(); });

it("a full seed records no judgment, usage log, race leg or model usage", async () => {
  // No runners: every section that doesn't play one (race, changes and the like report as the seed's runner).
  await seed(client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real }), undefined, ["judges", "insights", "models", "repos"]);
  const counts = {};
  for (const t of ["judgments", "usage_logs", "race_legs", "model_usage"]) counts[t] = await env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first("n");
  expect(counts).toEqual({ judgments: 0, usage_logs: 0, race_legs: 0, model_usage: 0 });
}, 120000);
