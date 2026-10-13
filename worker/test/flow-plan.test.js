import { describe, expect, it } from "vitest";
import { flowYaml, parseFlow, planFlow, validateFlow } from "../src/api/contract.js";

const plan = (text) => {
  const f = parseFlow(text);
  expect(validateFlow(f)).toEqual({ ok: true, errors: [] });
  return planFlow(f).stages;
};

// Six stages, 15 jobs: a two-step build job, a 2-leg node matrix and a 3-shard e2e job among them.
const SEED = `name: release
on: [push, manual]
stages:
  check: { needs: [build] }
  test: { needs: [check] }
steps:
  install: { stage: build, job: build, run: "npm ci", needs: [] }
  compile: { stage: build, job: build, run: "npm run build", needs: [install] }
  image: { stage: build, run: "docker build .", runs-on: [linux, docker], needs: [] }
  lint: { stage: check, run: "npm run lint", needs: [compile] }
  typecheck: { stage: check, run: "npm run typecheck", needs: [compile] }
  audit: { stage: check, run: "npm audit", needs: [compile] }
  unit: { stage: test, run: "npm test", matrix: { node: [20, 22] }, junit: [reports/junit.xml], needs: [lint] }
  e2e: { stage: test, run: "npm run e2e", shard: 3, artifacts: [playwright-report], needs: [lint] }
  package: { stage: package, run: "npm pack", artifacts: [dist], needs: [unit, e2e] }
  deploy-staging: { stage: staging, deploy: staging, target: "Cloudflare", needs: [package] }
  smoke: { stage: staging, run: "npm run smoke", needs: [deploy-staging] }
  approve: { stage: release, approval: "production owners", needs: [smoke] }
  deploy-prod: { stage: release, deploy: production, target: "Cloudflare", needs: [approve] }
`;

describe("flow plan", () => {
  it("steps sharing stage and job plan as one job in file order", () => {
    const [build] = plan(`name: ci
on: [manual]
steps:
  install: { stage: build, job: node, run: "npm ci", needs: [] }
  docs: { stage: build, run: "make docs", needs: [] }
  test: { stage: build, job: node, run: "npm test", needs: [install] }
`);
    expect(build.jobs).toEqual([
      { key: "build/node", name: "node", runs_on: [], steps: ["install", "test"] },
      { key: "build/docs", name: "docs", runs_on: [], steps: ["docs"] },
    ]);
  });

  it("matrix {node:[20,22]} plans legs node 20 and node 22, and shard 3 plans 1/3, 2/3 and 3/3", () => {
    const [test] = plan(`name: ci
on: [manual]
steps:
  unit: { stage: test, run: "npm test", matrix: { node: [20, 22] }, needs: [] }
  e2e: { stage: test, run: "npm run e2e", shard: 3, needs: [] }
`);
    expect(test.jobs.map((j) => [j.key, j.leg])).toEqual([
      ["test/unit/node 20", "node 20"], ["test/unit/node 22", "node 22"],
      ["test/e2e/1/3", "1/3"], ["test/e2e/2/3", "2/3"], ["test/e2e/3/3", "3/3"],
    ]);
  });

  it("a flow with no job keys plans one one-step job per step, as today", () => {
    expect(plan(`name: release
on: [manual]
steps:
  lint: { stage: build, run: "npm run lint", needs: [] }
  ship: { stage: deploy, deploy: production, needs: [test] }
  test: { stage: build, run: "npm test", needs: [lint] }
`)).toEqual([
      { id: "build", needs: [], jobs: [
        { key: "build/lint", name: "lint", runs_on: [], steps: ["lint"] },
        { key: "build/test", name: "test", runs_on: [], steps: ["test"] },
      ] },
      { id: "deploy", needs: [], jobs: [{ key: "deploy/ship", name: "ship", runs_on: [], steps: ["ship"] }] },
    ]);
  });

  it("validateFlow rejects a duplicate job name in a stage, more than 32 legs and a stage cycle", () => {
    const errors = (text) => validateFlow(parseFlow(`name: ci\non: [manual]\n${text}`)).errors;
    expect(errors(`steps:
  a: { stage: build, job: b, run: "x", needs: [] }
  b: { stage: build, run: "y", needs: [] }
`)).toEqual([expect.stringMatching(/^steps\.b\.job: .*unique in its stage/)]);
    expect(errors(`steps:
  a: { stage: build, run: "x", matrix: { os: [linux, mac, win] }, shard: 11, needs: [] }
`)).toEqual(["steps.a: matrix × shard gives more than 32 legs"]);
    expect(errors(`stages:
  build: { needs: [test] }
  test: { needs: [build] }
steps:
  a: { stage: build, run: "x", needs: [] }
  b: { stage: test, run: "y", needs: [] }
`)).toEqual(["stages: dependency cycle through build, test"]);
  });

  it("flowYaml → parseFlow round-trips job, matrix, shard, runs-on, junit, artifacts and stages", () => {
    const f = parseFlow(SEED);
    const again = parseFlow(flowYaml(f));
    expect(again).toEqual(f);
    expect(again.stages).toEqual({ check: { needs: ["build"] }, test: { needs: ["check"] } });
    expect(again.steps.find((s) => s.name === "unit")).toMatchObject({ matrix: { node: ["20", "22"] }, junit: ["reports/junit.xml"] });
    expect(again.steps.find((s) => s.name === "e2e")).toMatchObject({ shard: "3", artifacts: ["playwright-report"] });
    expect(again.steps.find((s) => s.name === "image")).toMatchObject({ "runs-on": ["linux", "docker"] });
    expect(again.steps.find((s) => s.name === "compile")).toMatchObject({ job: "build" });
  });

  it("a job without runs-on takes the flow's default runs-on, and a bad concurrency or default runs-on is rejected", () => {
    const [build] = plan("name: ci\non: [manual]\nconcurrency: queue\nruns-on: [gpu]\nsteps:\n  a: { stage: build, run: \"x\", needs: [] }\n  b: { stage: build, run: \"y\", runs-on: [arm64], needs: [] }\n");
    expect(build.jobs.map((j) => j.runs_on)).toEqual([["gpu"], ["arm64"]]);
    expect(validateFlow({ ...parseFlow("name: ci\non: [manual]\nsteps:\n  a: { stage: build, run: \"x\", needs: [] }\n"), concurrency: "later", "runs-on": ["no spaces"] }).errors)
      .toEqual(["concurrency: one of cancel, queue, parallel", "runs-on: a list of labels matching /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/"]);
  });

  it("the six-stage seed flow plans 15 jobs including a 2-leg matrix and 3 shards", () => {
    const stages = plan(SEED);
    expect(stages.map((s) => s.id)).toEqual(["build", "check", "test", "package", "staging", "release"]);
    const jobs = stages.flatMap((s) => s.jobs);
    expect(jobs).toHaveLength(15);
    expect(jobs.filter((j) => j.name === "unit").map((j) => j.leg)).toEqual(["node 20", "node 22"]);
    expect(jobs.filter((j) => j.name === "e2e").map((j) => j.leg)).toEqual(["1/3", "2/3", "3/3"]);
    expect(jobs.find((j) => j.name === "build").steps).toEqual(["install", "compile"]);
    expect(jobs.find((j) => j.name === "image").runs_on).toEqual(["linux", "docker"]);
  });
});
