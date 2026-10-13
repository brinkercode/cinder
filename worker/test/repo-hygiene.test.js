import { describe, expect, it } from "vitest";
import ignore from "../../.gitleaksignore?raw";

// Each file holds only a test value or a PEM template: the stripe and AWS test strings, the e2e/test KEYSTORE_KEY,
// and signing.js's "BEGIN OPENSSH PRIVATE KEY" armour around a key generated at runtime.
const FIXTURES = {
  "worker/test/deploy.test.js": "stripe-access-token",
  "e2e/wrangler.jsonc": "generic-api-key",
  "worker/vitest.config.js": "generic-api-key",
  "worker/src/signing.js": "private-key",
  "runner/internal/verify/scan_test.go": "aws-access-token",
};

describe("repo hygiene", () => {
  it("gitleaksignore lists only fixture fingerprints", () => {
    const lines = ignore.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(lines).toHaveLength(11);
    for (const line of lines) {
      const m = line.match(/^([0-9a-f]{40}):(.+):([a-z-]+):(\d+)$/);
      expect(m, line).not.toBeNull();
      expect(FIXTURES[m[2]], line).toBe(m[3]);
    }
    expect(new Set(lines.map((l) => l.split(":")[1]))).toEqual(new Set(Object.keys(FIXTURES)));
  });
});
