// atlas-monorepo's generator (seed/large.mjs), from its output alone. Runs in the Worker's vitest project.
import { expect, it } from "vitest";
import { LARGE, largeCommits, seedLarge } from "./large.mjs";

const bytes = (files) => Object.values(files).reduce((n, text) => n + new TextEncoder().encode(text).length, 0);
const digest = async (commits) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(commits))));

it("the large repo's history is at least ten times its head", () => {
  const commits = largeCommits();
  const head = Object.assign({}, ...commits.map((c) => c.files));
  const history = commits.reduce((n, c) => n + bytes(c.files), 0);
  expect(Object.keys(head).length).toBeGreaterThanOrEqual(1000);
  expect(commits.length).toBeGreaterThanOrEqual(30);
  expect(history).toBeGreaterThanOrEqual(10 * bytes(head));
});

it("the large repo generator makes the same repo every run", async () => {
  expect(await digest(largeCommits())).toEqual(await digest(largeCommits()));
});

// seedLarge against a repo whose main already holds the first `n` commits; returns the commit messages it sends.
async function resume(n) {
  const all = largeCommits();
  const log = all.slice(0, n).reverse().map((c, i) => ({ sha: `s${i}`, message: c.message }));
  const sent = [];
  await seedLarge(async (method) => (method === "GET" ? log : null), async ({ commits }) => sent.push(...commits.map((c) => c.message)));
  return { all, sent };
}

it("the large repo is left as it is once it has every commit", async () => {
  const { all, sent } = await resume(largeCommits().length);
  expect(all.length).toBeGreaterThan(0);
  expect(sent).toEqual([]);
});

it("a large repo seeded part way resumes after its newest commit", async () => {
  const { all, sent } = await resume(5);
  expect(sent).toEqual(all.slice(5).map((c) => c.message));
  expect((await resume(0)).sent).toEqual(all.map((c) => c.message));
});
