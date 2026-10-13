import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";

// Strips the jsonc line comments; no string value in wrangler.jsonc contains " //".
const config = JSON.parse(raw.replace(/(^|\s)\/\/.*$/gm, ""));

describe("wrangler observability", () => {
  it("a config test asserts the block", () => {
    expect(config.observability).toEqual({
      enabled: true,
      logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 },
      traces: { enabled: true, head_sampling_rate: 1 },
    });
    // Container apps don't inherit the root block, so their logs are switched on one by one.
    for (const c of config.containers) expect(c.observability, c.class_name).toEqual({ logs: { enabled: true } });
  });
});
