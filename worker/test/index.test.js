import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.js";

it("sends nosniff and frame-ancestors none on an API response", async () => {
  const res = await worker.fetch(new Request("http://cinder.test/api/repos"), env);
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
});
