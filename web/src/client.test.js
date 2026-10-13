import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen, reconnecting } from "./client.js";

let sockets;
let tickets;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_FIXTURES", "");
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("location", { protocol: "https:", host: "cinder.test" });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("console", { ...console, error: () => {} });
  sockets = [];
  tickets = 0;
  vi.stubGlobal("fetch", async () => Response.json({ ticket: `t${++tickets}` }));
  vi.stubGlobal("WebSocket", class { constructor(url) { this.url = url; sockets.push(this); } close() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("live socket", () => {
  it("a dropped socket reconnects and refetches", async () => {
    const onEvent = vi.fn();
    const stop = listen("acme/app", onEvent);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].onopen();
    expect(onEvent).not.toHaveBeenCalled();
    sockets[0].onclose();
    expect(reconnecting()).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[1].url).toBe("wss://cinder.test/api/repos/acme%2Fapp/live?ticket=t2");
    sockets[1].onopen();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(reconnecting()).toBe(false);
    stop();
  });

  it("treats a 204 live ticket as live-off and opens no socket", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const stop = listen("app", () => {});
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(0);
    expect(reconnecting()).toBe(false);
    stop();
  });

  it("listen revalidates every 15 s while live-ticket answers 204", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const onEvent = vi.fn();
    const stop = listen("app", onEvent);
    await vi.advanceTimersByTimeAsync(14999);
    expect(onEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith();
    document.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(30000);
    expect(onEvent).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    await vi.advanceTimersByTimeAsync(15000);
    expect(onEvent).toHaveBeenCalledTimes(2);
    stop();
  });

  it("listen stops the revalidate timer when stopped", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const onEvent = vi.fn();
    const stop = listen("app", onEvent);
    await vi.advanceTimersByTimeAsync(15000);
    expect(onEvent).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("backoff caps at 30s", async () => {
    const stop = listen("app", () => {});
    await vi.advanceTimersByTimeAsync(0);
    const waits = [];
    for (let i = 0; i < 7; i++) {
      sockets.at(-1).onclose();
      const n = sockets.length;
      let t = 0;
      while (sockets.length === n) { await vi.advanceTimersByTimeAsync(1000); t += 1000; }
      waits.push(t);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    stop();
    await Promise.resolve(); // the last listener's socket closes once the current task ends
    expect(reconnecting()).toBe(false);
  });
});

describe("owner token", () => {
  it("a stored owner token is never sent: Access identifies the person", async () => {
    vi.stubGlobal("sessionStorage", { getItem: (k) => (k === "cinder.owner_token" ? "owner-secret" : null), removeItem: () => {} });
    const inits = [];
    vi.stubGlobal("fetch", async (url, init) => {
      inits.push(init ?? {});
      return url === "/api/live-ticket" ? Response.json({ ticket: "t" }) : Response.json([]);
    });
    const { list, listen, postJson } = await import("./client.js");
    await list("/api/repos");
    await postJson("/api/changes/c1/takeover", {});
    const stop = listen("acme/app", () => {});
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(inits).toHaveLength(3);
    for (const init of inits) expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });
});

describe("shared GETs", () => {
  it("two callers fetching one URL at once send one request", async () => {
    const seen = [];
    vi.stubGlobal("fetch", async (url) => { seen.push(url); return Response.json([{ n: 1 }]); });
    const { fetchJson } = await import("./client.js");
    const [a, b] = await Promise.all([fetchJson("/api/repos"), fetchJson("/api/repos")]);
    expect(seen).toEqual(["/api/repos"]);
    expect(a).toEqual([{ n: 1 }]);
    a[0].n = 2;
    expect(b).toEqual([{ n: 1 }]);
    expect(await fetchJson("/api/repos")).toEqual([{ n: 1 }]);
    expect(seen).toHaveLength(1);
  });

  it("a live event invalidates the cached response for its URL", async () => {
    const seen = [];
    vi.stubGlobal("fetch", async (url) => {
      seen.push(url);
      return url === "/api/live-ticket" ? Response.json({ ticket: "t" }) : Response.json({ v: seen.length });
    });
    const { fetchJson, listen } = await import("./client.js");
    const path = "/api/repos/app/branches";
    const onEvent = vi.fn();
    const stops = [listen("app", onEvent), listen("app", onEvent)];
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.filter((u) => u === "/api/live-ticket")).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    const first = await fetchJson(path);
    expect(await fetchJson(path)).toEqual(first);
    sockets[0].onmessage({ data: "{}" });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(await fetchJson(path)).not.toEqual(first);
    expect(seen.filter((u) => u === path)).toHaveLength(2);
    stops.forEach((stop) => stop());
  });

  it("a failed GET is not kept", async () => {
    let fail = true;
    vi.stubGlobal("fetch", async () => (fail ? new Response(null, { status: 503 }) : Response.json([])));
    const { fetchJson } = await import("./client.js");
    await expect(fetchJson("/api/repos")).rejects.toThrow("HTTP 503");
    fail = false;
    expect(await fetchJson("/api/repos")).toEqual([]);
  });
});
