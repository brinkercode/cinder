import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

afterEach(() => vi.restoreAllMocks());

describe("router", () => {
  it("refuses a cookie-authenticated POST from another origin", async () => {
    serveCerts();
    const Cookie = `CF_Authorization=${(await as("boss@example.com"))["Cf-Access-Jwt-Assertion"]}`;
    const post = (Origin, name) => worker.fetch(new Request("https://cinder.test/api/repos", {
      method: "POST", headers: { Cookie, Origin, "Content-Type": "text/plain" }, body: JSON.stringify({ name }),
    }), { ...ACCESS, ARTIFACTS: fakeArtifacts() });
    const res = await post("https://evil.example", "csrf-evil");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("cross_origin");
    expect((await post("https://cinder.test", "csrf-same")).status).toBe(201);
  });

  it("refuses an oversized runner registration before parsing it", async () => {
    const json = vi.spyOn(Response.prototype, "json");
    const res = await worker.fetch(new Request("https://cinder.test/api/runners", {
      method: "POST", body: JSON.stringify({ pool_token: "x", pad: "a".repeat(4096) }),
    }), { ARTIFACTS: fakeArtifacts() });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("too_large");
    expect(json).toHaveBeenCalledTimes(1);
  });
});
