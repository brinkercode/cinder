import { expect, it } from "vitest";
import { listRefs } from "../src/git/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// workerd logs an uncaught internal error for each fetch whose DNS lookup fails; test/setup.js refuses the fake's host first.
it("a full worker run reports no uncaught exceptions", async () => {
  const fake = fakeArtifacts();
  await fake.create("unreachable");
  await expect(listRefs(await fake.get("unreachable"))).rejects.toThrow("artifacts.fake is not reachable from tests");
});
