import { describe, expect, it } from "vitest";
import lock from "../../package-lock.json?raw";

describe("dependencies", () => {
  it("the lockfile pins sharp at 0.35.5 or later", () => {
    const { version } = JSON.parse(lock).packages["node_modules/sharp"];
    const [major, minor, patch] = version.split(".").map(Number);
    expect(major > 0 || minor > 35 || (minor === 35 && patch >= 5), `sharp ${version}`).toBe(true);
  });
});
