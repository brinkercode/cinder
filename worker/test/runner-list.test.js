import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { validatePerson, validateRunner } from "../src/api/contract.js";
import worker from "../src/index.js";
import { hex, sha256 } from "../src/router.js";

const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(new Request(`http://cinder.test${path}`,
  { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), env);
const register = async (name) => (await call("/api/runners", { name, kinds: ["develop"] })).json();
const runners = async () => (await call("/api/workers")).json();

describe("runners list", () => {
  it("a runner that hasn't sent a heartbeat for 2 minutes shows as offline", async () => {
    const { id, token } = await register("lab-offline");
    // An empty kinds list claims nothing but still counts as a heartbeat.
    expect((await call("/api/work/claim", { kinds: [], slots_free: 3 }, token)).status).toBe(204);
    const fresh = (await runners()).find((r) => r.id === id);
    expect(validateRunner(fresh)).toEqual({ ok: true, errors: [] });
    expect(fresh).toMatchObject({ name: "lab-offline", kinds: ["develop"], slots: 3, online: true, claims: [] });

    await env.DB.prepare("UPDATE runner_heartbeats SET last_heartbeat_at = ? WHERE runner_id = ?").bind(new Date(Date.now() - 120000).toISOString(), id).run();
    expect((await runners()).find((r) => r.id === id).online).toBe(false);
  });

  it("the tokens view never includes a secret value", async () => {
    const { id, token } = await register("lab-secret");
    const res = await call("/api/workers");
    const text = await res.text();
    const row = JSON.parse(text).find((r) => r.id === id);
    expect(row).toMatchObject({ name: "lab-secret", kinds: ["develop"] });
    expect(Date.parse(row.created_at)).not.toBeNaN();
    expect(text).not.toContain(token);
    expect(text).not.toContain(hex(await sha256(token)));
    expect(text).not.toContain("token");
  });

  it("GET /api/people lists people with their role", async () => {
    await env.DB.prepare("INSERT INTO people (email, created_at) VALUES ('ann@x.test', ?) ON CONFLICT DO NOTHING").bind(new Date().toISOString()).run();
    const ann = (await (await call("/api/people")).json()).find((p) => p.email === "ann@x.test");
    expect(validatePerson(ann)).toEqual({ ok: true, errors: [] });
    expect(ann.owner).toBe(false);
  });
});
