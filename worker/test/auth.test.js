import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, init) => exports.default.fetch(`http://cinder.test${path}`, init);

async function registerRunner(name = "lab-1") {
  const res = await call("/api/runners", { method: "POST", headers: OWNER, body: JSON.stringify({ name, kinds: ["develop"] }) });
  expect(res.status).toBe(201);
  return res.json();
}

describe("auth", () => {
  it("no token → 401", async () => {
    for (const path of ["/api/runners", "/api/work/claim"]) {
      const res = await call(path, { method: "POST" });
      expect(res.status, path).toBe(401);
      expect((await res.json()).error.code).toBe("unauthorized");
    }
  });

  it("runner token on an owner route → 403", async () => {
    const { token } = await registerRunner();
    const res = await call("/api/runners", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  it("owner token on /api/work/claim → 403", async () => {
    const res = await call("/api/work/claim", { method: "POST", headers: OWNER });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toEqual({ code: "forbidden", message: "this route needs the runner token" });
  });

  it("D1 never holds the plaintext runner token", async () => {
    const { id, token } = await registerRunner("lab-2");
    const row = await env.DB.prepare("SELECT * FROM runner_tokens WHERE runner_id = ?").bind(id).first();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    expect(row.token_hash).toBe([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    expect(JSON.stringify(row)).not.toContain(token);
    // The runner token passes runner auth: the queue has no develop job, so the claim is empty.
    expect((await call("/api/work/claim", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
  });
});
