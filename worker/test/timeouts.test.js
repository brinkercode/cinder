import { expect, it } from "vitest";
import config from "../vitest.config.js?raw";

const files = { "vitest.config.js": config, ...import.meta.glob(["./*.test.js", "./helpers/*.js"], { query: "?raw", import: "default", eager: true }) };

it("grep ponytail: stopgap in worker finds nothing and vitest config has 30000 for both timeouts", () => {
  const marker = ["ponytail", "stopgap"].join(": "); // split so this file doesn't match itself
  expect(Object.keys(files).filter((f) => files[f].includes(marker))).toEqual([]);
  expect(config).toMatch(/testTimeout: 30000\b/);
  expect(config).toMatch(/hookTimeout: 30000\b/);
});
