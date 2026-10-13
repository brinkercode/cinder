import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { SLOT_MS } from "../src/tick.js";

// Its own instance: other tests' requests arm the shared "global" one's alarm.
const dispatch = () => env.DISPATCH_DO.get(env.DISPATCH_DO.idFromName("tick-test"));

afterEach(() => vi.unstubAllGlobals());

it("a 10-minute slot's tick runs once, whether the cron or DispatchDO's alarm takes it first", async () => {
  const slot = Math.floor(Date.parse("2026-10-13T16:20:00Z") / SLOT_MS) * SLOT_MS;
  await runInDurableObject(dispatch(), async (i) => {
    expect(await i.takeSlot(slot + 1_000)).toBe(true); // the cron
    expect(await i.takeSlot(slot + 30_000)).toBe(false); // the alarm, same slot
    expect(await i.ctx.storage.getAlarm()).toBe(slot + SLOT_MS + 30_000);
    expect(await i.takeSlot(slot + SLOT_MS + 30_000)).toBe(true); // no cron next slot: the alarm runs it
  });
});

it("DispatchDO's alarm runs the tick when the cron doesn't fire: a silent orphan worker token is pruned", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 })); // the tick's other jobs call out
  await env.DB.prepare("INSERT INTO worker_pools (id, name, size, min_count, max_count, kinds, created_at) VALUES ('tick-p', 'tick-pool', 'lite', 0, 0, '[\"index\"]', ?)")
    .bind(new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO runner_tokens (runner_id, name, kinds, token_hash, created_at) VALUES ('tick-orphan', 'tick-pool-0420aaf9', '[]', 'h', ?)")
    .bind(new Date(Date.now() - 16 * 60 * 1000).toISOString()).run();
  await runInDurableObject(dispatch(), async (i) => {
    await i.ctx.storage.delete("slot");
    await i.alarm();
  });
  expect(await env.DB.prepare("SELECT 1 FROM runner_tokens WHERE runner_id = 'tick-orphan'").first()).toBeNull();
});
