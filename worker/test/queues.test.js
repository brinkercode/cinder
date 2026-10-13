import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";

const config = JSON.parse(raw.replace(/(^|\s)\/\/.*$/gm, ""));

describe("wrangler queues", () => {
  it("a config test: both consumers have a dead_letter_queue", () => {
    const dlq = Object.fromEntries(config.queues.consumers.map((c) => [c.queue, c.dead_letter_queue]));
    expect(dlq).toEqual({ "cinder-events": "cinder-events-dlq", "cinder-webhooks": "cinder-webhooks-dlq" });
  });
});
