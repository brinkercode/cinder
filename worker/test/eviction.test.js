import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { fakeArtifacts } from "./fakes/artifacts.js";

// Tests hand Durable Objects the Artifacts fake by patching the live instance (i.env). workerd evicts an idle
// object after 10 s, dropping the patch; a loaded machine stalls a test that long, so later calls failed or hung.
it("a patched Durable Object keeps its fake after 10 s idle", async () => {
  const fake = fakeArtifacts();
  await fake.create("evict-idle");
  const stub = env.REPO_DO.get(env.REPO_DO.idFromName("evict-idle"));
  await runInDurableObject(stub, (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  expect(await stub.policy("evict-idle", "main")).toMatchObject({ integration: ["main"] });
});
