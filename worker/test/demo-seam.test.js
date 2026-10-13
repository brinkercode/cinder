import { env } from "cloudflare:workers";
import { expect, it, onTestFinished } from "vitest";
import { REPO, demo } from "../../seed/demo.mjs";
import { client } from "../../seed/seed.mjs";
import worker from "../src/index.js";
import { PULSE_SOURCES, indexPulse, relayCommit, seedArtifacts } from "./fakes/seed.js";

it("the demo intents produce exactly one seam change on pulse", async () => {
  const fake = seedArtifacts();
  // RepoDO reads .cinder.yml through its own env (see seed.test.js).
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), { ...env, ARTIFACTS: fake, PIPELINE: { create: async () => ({}) } }) });
  const commit = relayCommit(`demo-seam-${crypto.randomUUID()}`, fake);
  await Promise.all([demo(api, commit, PULSE_SOURCES), indexPulse(api)]);
  await demo(api, commit, PULSE_SOURCES);
  const seams = (await api("GET", `/api/repos/${REPO}/changes`)).filter((c) => c.kind === "seam");
  expect(seams).toHaveLength(1);
  expect(seams[0].intent).toContain("src/index.js#alerts");
});
