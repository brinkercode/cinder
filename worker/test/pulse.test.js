import { expect, it } from "vitest";
import { parseDeploy } from "../src/deploy.js";
import manifest from "../../demo/pulse/.cinder.yml?raw";

it("the pulse .cinder.yml validates with the delivery manifest validator", () => {
  const d = parseDeploy(manifest);
  expect(d.environments).toEqual([
    { name: "preview", from: "change" },
    { name: "staging", branch: "develop", auto_sync: true },
    { name: "production", branch: "main", auto_sync: true, gradual: [10, 50, 100], health: "/healthz" },
  ]);
  expect(d.resources.map((r) => r.type)).toEqual(["d1", "kv"]);
});
