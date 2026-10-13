// The strict flow schema (readFlow) and where an invalid flow is refused or fails loudly.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { readFlow, validateChangeCheck } from "../src/api/shapes.js";
import { newChange } from "../src/changes.js";
import { enqueueFlows } from "../src/flows.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { SEED_SOURCES } from "./fakes/seed.js";

const PATH = ".cinder/flows/ci.yml";
// Three problems: a scalar on (line 2), and on line 4 a misspelt need, so the step has no needs.
const BROKEN = `name: ci
on: push
steps:
  test: { stage: build, run: "npm test", need: [] }
`;
const texts = (text) => readFlow(text, PATH).errors.map((e) => e.text);

async function repoWith(name, files) {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake };
  const call = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`,
    { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), e);
  const repo = await (await call("POST", "/api/repos", { name })).json();
  Object.assign(fake.repos.get(name), { commits: [{ sha: "s1" }], files });
  return { e, fake, call, repo };
}

it("a flow with an unknown step key need fails validation naming steps.<s>.need with its line and did you mean needs", () => {
  expect(texts(BROKEN)).toContain(`${PATH}:4: steps.test.need: unknown key; did you mean needs?`);
  expect(texts("name: ci\non: [manual]\nstpes:\n  a: { stage: build, run: \"x\", needs: [] }\n")).toContain(`${PATH}:3: stpes: unknown key; did you mean steps?`);
});

it("a flow with on: push (scalar), a step without needs, or a duplicate key is invalid", () => {
  const ok = "name: ci\non: [manual]\nsteps:\n  a: { stage: build, run: \"x\", needs: [] }\n";
  expect(texts(ok)).toEqual([]);
  expect(texts(ok.replace("[manual]", "manual"))).toEqual([`${PATH}:2: on: expected a non-empty list from push, change, cron, manual`]);
  expect(texts(ok.replace(", needs: []", ""))).toEqual([`${PATH}:4: steps.a.needs: required, a list of other steps of this flow ([] for none)`]);
  expect(texts(`${ok}on: [push]\n`)).toEqual([`${PATH}:5: duplicate key on`]);
  expect(texts(ok.replace("needs: []", "needs: [], stage: test"))).toEqual([`${PATH}:4: duplicate key stage`]);
  expect(texts(ok.replace("  a:", "\ta:"))).toEqual([`${PATH}:4: tab used for indentation`]);
  expect(texts(ok.replace("name: ci", "name: release"))).toEqual([`${PATH}:1: name: must equal the file name ci`]);
});

it("pushing an invalid flow on a change creates a failed run with a Validate flow log and an error annotation per problem, and the change's checks show it failed", async () => {
  const { e, fake, call, repo } = await repoWith("schema-change", {});
  const change = await newChange(e, repo.name, repo.id, "x", "main", []);
  const head = "c".repeat(40);
  fake.repos.get(change.fork).files[PATH] = BROKEN;
  await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, ?)").bind(change.id, head).run();
  await enqueueFlows(e, repo, change.fork, head, "change", head, { change_id: change.id, ref: "x" });

  const id = `change-${repo.id}-ci-${head}`;
  const tree = await (await call("GET", `/api/repos/${repo.name}/flow-runs/${id}`)).json();
  expect([tree.status, tree.stages.map((s) => s.jobs.map((j) => [j.name, j.status]))]).toEqual(["failed", [[["Validate flow", "failed"]]]]);
  const problems = texts(BROKEN);
  expect(problems.length).toBe(3);
  const log = await (await call("GET", `/api/repos/${repo.name}/flow-runs/${id}/jobs/${encodeURIComponent("validate/Validate flow")}/log.txt`)).text();
  expect(log.trim().split("\n").map((l) => l.slice(l.indexOf(" ") + 1))).toEqual(problems);
  const notes = await (await call("GET", `/api/repos/${repo.name}/flow-runs/${id}/annotations`)).json();
  expect(notes.map((a) => [a.level, a.file, a.file_line, a.message])).toEqual(problems.map((p) => ["error", PATH, Number(p.split(":")[1]), p]));
  expect((await call("POST", `/api/repos/${repo.name}/flow-runs/${id}/rerun`, { scope: "all" })).status).toBe(409);

  const checks = await (await call("GET", `/api/changes/${change.id}/checks`)).json();
  expect(checks.filter((c) => c.kind === "flow")).toEqual([{ kind: "flow", name: "ci", status: "fail", sha: head, duration_ms: null, log_url: null }]);
  for (const c of checks) expect(validateChangeCheck(c).errors).toEqual([]);
});

it("a manual run and a designer save of an invalid flow answer 400 with every error", async () => {
  const bad = BROKEN.replace("on: push", "on: [manual]");
  const { call, repo } = await repoWith("schema-refuse", { [PATH]: bad });
  const all = texts(bad);
  expect(all.length).toBe(2);

  const run = await call("POST", `/api/repos/${repo.name}/flows/ci/runs`);
  expect([run.status, (await run.json()).error]).toEqual([400, { code: "invalid_flow", message: all.join("; ") }]);
  const save = await call("POST", `/api/repos/${repo.name}/commits`, { branch: "main", base_sha: "a".repeat(40), message: "Flows: save ci", changes: [{ path: PATH, content: bad }] });
  expect([save.status, (await save.json()).error]).toEqual([400, { code: "invalid_flow", message: all.join("; ") }]);
  const edit = await call("POST", `/api/repos/${repo.name}/changes/edit`, { target: "main", path: PATH, base_sha: "a".repeat(40), content: bad, intent: "Edit ci" });
  expect([edit.status, (await edit.json()).error]).toEqual([400, { code: "invalid_flow", message: all.join("; ") }]);
});

it("every seeded flow validates", () => {
  const flows = Object.entries(SEED_SOURCES).flatMap(([repo, files]) => Object.entries(files).filter(([p]) => p.startsWith(".cinder/flows/")).map(([p, text]) => [`${repo}/${p}`, p, text]));
  expect(flows.length).toBeGreaterThan(10);
  for (const [where, path, text] of flows) expect(readFlow(text, path).errors, where).toEqual([]);
});
