import { describe, expect, it, vi } from "vitest";
import { READ_MS, createArtifacts } from "../src/artifacts.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

function setup() {
  const fake = fakeArtifacts({ now: () => 1_000_000 });
  return { fake, artifacts: createArtifacts(fake) };
}

describe("artifacts adapter", () => {
  it("the fake Artifacts log answers no commits for a full refs/ name, as the binding does", async () => {
    const fake = fakeArtifacts();
    await fake.create("fake-log");
    fake.repos.get("fake-log").commits = [{ sha: "s1" }];
    const repo = await fake.get("fake-log");
    expect(await repo.log({ ref: "main" })).toHaveLength(1);
    expect(await repo.log({ ref: "refs/heads/main" })).toEqual([]);
  });

  it("ttl 7201 throws", async () => {
    const { fake, artifacts } = setup();
    await artifacts.create("app");
    expect(() => artifacts.createToken("app", "write", 7201)).toThrow(/ttl/);
    expect(fake.calls.some((c) => c.method === "createToken")).toBe(false);
    const token = await artifacts.createToken("app", "write", 7200);
    expect(token).toMatchObject({ token: expect.stringMatching(/^fake-token-/), scope: "write", expiresAt: new Date(1_000_000 + 7200 * 1000).toISOString() });
  });

  it("missing scope throws", async () => {
    const { fake, artifacts } = setup();
    await artifacts.create("app");
    expect(() => artifacts.createToken("app", undefined, 60)).toThrow(/scope/);
    expect(() => artifacts.createToken("app", "", 60)).toThrow(/scope/);
    expect(fake.calls.some((c) => c.method === "createToken")).toBe(false);
  });

  it("fake fork returns a distinct remote and records the parent", async () => {
    const { fake, artifacts } = setup();
    const parent = await artifacts.create("app");
    const fork = await artifacts.fork("app", "app-change-1");
    expect(fork.remote).not.toBe(parent.remote);
    expect(fork.parent).toBe("app");
    expect(fake.calls).toContainEqual({ method: "fork", args: ["app", "app-change-1"] });
  });

  it("adapter get() of a missing repo returns null and rethrows other errors", async () => {
    const { fake, artifacts } = setup();
    expect(await artifacts.get("missing")).toBeNull();
    fake.get = async () => { throw new Error("artifacts unavailable"); };
    await expect(artifacts.get("app")).rejects.toThrow("artifacts unavailable");
  });

  // A binding whose log() stalls forever on its first `stalls` calls.
  const stalling = async (stalls) => {
    const { fake, artifacts } = setup();
    await artifacts.create("app");
    const get = fake.get.bind(fake);
    let n = 0;
    fake.get = async (name) => {
      const r = await get(name);
      return { ...r, log: (...a) => (n++ < stalls ? new Promise(() => {}) : r.log(...a)) };
    };
    return { artifacts, calls: () => n };
  };

  it("a read that stalls past its timeout is retried once and returns the second answer", async () => {
    vi.useFakeTimers();
    try {
      const { artifacts, calls } = await stalling(1);
      const answer = artifacts.log("app", "main");
      await vi.advanceTimersByTimeAsync(READ_MS);
      expect(await answer).toEqual([]);
      expect(calls()).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("a read that stalls twice fails with the existing error", async () => {
    vi.useFakeTimers();
    try {
      const { artifacts, calls } = await stalling(5);
      const answer = expect(artifacts.log("app", "main")).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(READ_MS * 2);
      await answer;
      expect(calls()).toBe(2);
    } finally { vi.useRealTimers(); }
  });
});
