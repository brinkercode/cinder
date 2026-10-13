// Builds and tests every seed repo with its own toolchain (`make check-seed`); a repo whose toolchain is absent is skipped.
// The service repos build in place; the web repos install, test and build from a clean copy
// (need npm and the registry; minutes per repo, so they are not part of make check).
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { parseFlow, planFlow, validateFlow } from "../worker/src/api/shapes/flow.js";
import { DELIBERATE } from "./activity.mjs";
import { CODE_EDIT, PEOPLE_EDITS } from "./seed.mjs";

const REPOS = [
  { name: "svc-orders-go", probe: "go version", run: "go vet ./... && go build -o /dev/null . && go test ./..." },
];

const has = (cmd) => {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

for (const { name, probe, run } of REPOS) {
  const skip = !has(probe) && `toolchain absent: \`${probe}\` failed`;
  test(`seed repo ${name} builds and its tests pass`, { skip, timeout: 900_000 }, () => {
    execSync(run, { cwd: new URL(`./repos/${name}/`, import.meta.url), stdio: "inherit" });
  });
}

const repos = new URL("./repos/", import.meta.url).pathname;
const built = new Set(["node_modules", "dist", ".next", ".astro"]);
// Without NODE_TEST_CONTEXT, a repo's own `node --test` runs its files instead of skipping them as nested.
const { NODE_TEST_CONTEXT, ...env } = { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1" };
const npm = has("npm --version");

test("seed repo web-store builds and its tests pass", { skip: !npm && "npm is not on PATH", timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-web-store-"));
  try {
    cpSync(join(repos, "web-store"), dir, { recursive: true, filter: (src) => !built.has(basename(src)) });
    for (const args of [["ci", "--no-audit", "--no-fund"], ["test"], ["run", "build"]]) {
      execFileSync("npm", args, { cwd: dir, stdio: "inherit", env });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the seed repo's ci flow plans 6 stages and 14 jobs and its integration job fails", { skip: !has("go version") && "go is not on PATH" }, () => {
  const dir = new URL("./repos/svc-orders-go/", import.meta.url);
  const def = parseFlow(readFileSync(new URL(".cinder/flows/ci.yml", dir), "utf8"));
  assert.deepEqual(validateFlow(def).errors, []);
  const { stages } = planFlow(def);
  assert.deepEqual(stages.map((s) => [s.id, s.jobs.length]), [["build", 3], ["test", 5], ["integration", 1], ["package", 1], ["staging", 2], ["release", 2]]);
  assert.deepEqual(stages[1].jobs.map((j) => j.leg), ["round 1", "round 2", "1/3", "2/3", "3/3"]);
  const integration = def.steps.find((s) => s.name === "integration");
  assert.throws(() => execSync(integration.run, { cwd: dir, stdio: "pipe" }), (e) => /--- FAIL: TestIntegration_PatchMovesOrderToPaid/.test(e.stdout));
});

const flowsOf = (name) => readdirSync(join(repos, name, ".cinder/flows")).sort().map((f) => [f.slice(0, -4), parseFlow(readFileSync(join(repos, name, ".cinder/flows", f), "utf8"))]);
// A step that deploys, applies or pushes, or a wrangler call that is not a dry run, creates or changes a resource.
const CREATES = /terraform\s+(-chdir=\S+\s+)?(apply|destroy)|auto-approve|(docker|buildah|podman|git) push|wrangler(?![^&;|]*--dry-run)|kubectl/;
const creating = (def) => def.steps.filter((s) => s.deploy || s.approval || CREATES.test(s.run)).map((s) => s.name);

test("every seed repo has a change, a push, a cron and a manual flow, each dry-run", () => {
  for (const name of readdirSync(repos)) {
    const flows = flowsOf(name);
    for (const trigger of ["change", "push", "cron", "manual"]) {
      // The manual one is manual-only; the others can also be started by hand, as the seed does.
      const found = flows.filter(([, def]) => (trigger === "manual" ? def.on.join() === "manual" : def.on.includes(trigger)));
      assert.ok(found.length, `${name} has no ${trigger} flow`);
      for (const [flow, def] of found) {
        assert.deepEqual(validateFlow(def).errors, [], `${name}/${flow}`);
        assert.ok(def.on.includes("manual"), `${name}/${flow} can't be started by hand`);
        assert.deepEqual(creating(def), [], `${name}/${flow}`);
      }
    }
  }
});

test("no seeded flow has a deploy step that creates a resource", () => {
  // Every seeded flow, by repo; a new one is checked here before it is seeded.
  assert.deepEqual(Object.fromEntries(readdirSync(repos).map((name) => [name, flowsOf(name).map(([flow]) => flow)])), {
    "infra-cloudflare-tf": ["check", "daily", "deploy", "destroy"],
    "svc-orders-go": ["check", "ci", "daily", "deploy"],
    "web-store": ["build", "ci", "daily", "deploy"],
  });
  for (const name of readdirSync(repos)) for (const [flow, def] of flowsOf(name)) assert.deepEqual(creating(def), [], `${name}/${flow}`);
});

test("web-store's install step is reproducible offline from its lockfile", () => {
  const dir = join(repos, "web-store");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  // The lockfile pins what package.json asks for, each package with its tarball and integrity, so npm ci needs no registry metadata.
  assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
  for (const [path, p] of Object.entries(lock.packages)) if (path) assert.ok(p.resolved && p.integrity, path);
  // Every install, in the verify check and each flow, takes cached tarballs first and makes no audit or funding call.
  const check = readFileSync(join(dir, ".cinder.yml"), "utf8").match(/^check: (.+)$/m)[1];
  const installs = [check, ...flowsOf("web-store").flatMap(([, def]) => def.steps.map((s) => s.run))].flatMap((run) => run.match(/npm (ci|install)\b[^&;|]*/g) ?? []);
  assert.equal(installs.length, 5);
  for (const cmd of installs) assert.equal(cmd.trim(), "npm ci --prefer-offline --no-audit --no-fund");
});

// The tool each repo's flows run, as the pool's image bakes it.
const TOOLCHAIN = { "infra-cloudflare-tf": "terraform", "svc-orders-go": "go", "web-store": "npm" };
// What a dry run has: no Cloudflare or AWS credential in the environment.
const dry = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLOUDFLARE|AWS)_/.test(k)));

test("each seeded flow's steps run with the repo's own toolchain and no deploy credential", { timeout: 1_800_000 }, async (t) => {
  for (const name of readdirSync(repos)) {
    const tool = TOOLCHAIN[name];
    await t.test(name, { skip: !has(`command -v ${tool}`) && `${tool} is not on PATH` }, () => {
      const flows = flowsOf(name);
      // Each step's command, once: the steps it runs, and whether it is the deliberate failure.
      const steps = (defs) => {
        const byRun = new Map();
        for (const [flow, def] of defs) {
          assert.deepEqual(def.secrets, [], `${name}/${flow}`);
          for (const s of def.steps) {
            assert.ok(s.run && !s.secrets?.length, `${name}/${flow}/${s.name} needs a credential or runs no command`);
            const deliberate = name === DELIBERATE.repo && flow === DELIBERATE.flow && s.name === DELIBERATE.step;
            byRun.set(s.run, { id: `${name}/${flow}/${s.name}`, deliberate: deliberate || byRun.get(s.run)?.deliberate });
          }
        }
        return byRun;
      };
      const dir = mkdtempSync(join(tmpdir(), `seed-flows-${name}-`));
      // Every step runs in a git checkout, as on a runner.
      const run = (byRun) => {
        for (const [cmd, { id, deliberate }] of byRun) {
          const go = () => execFileSync("sh", ["-c", cmd], { cwd: dir, stdio: "pipe", env: dry });
          if (deliberate) assert.throws(go, id);
          else assert.doesNotThrow(go, id);
        }
      };
      try {
        cpSync(join(repos, name), dir, { recursive: true, filter: (src) => !built.has(basename(src)) });
        execSync("git init -q && git add -A && git -c user.name=seed -c user.email=seed@example.com commit -qm seed", { cwd: dir, stdio: "ignore" });
        run(steps(flows));
        // The seed's edits each open a change, which runs the change flows on the edited file.
        const [path, edits = []] = PEOPLE_EDITS[name] ?? [];
        const changeFlows = steps(flows.filter(([, def]) => def.on.includes("change")));
        for (const [, find, replace] of [...edits.slice(0, 3), ...(name === "svc-orders-go" ? [CODE_EDIT] : [])]) {
          const file = join(dir, path);
          const base = readFileSync(file, "utf8");
          assert.ok(base.includes(find), `${name}: ${find}`);
          writeFileSync(file, base.replace(find, replace));
          run(changeFlows);
          writeFileSync(file, base);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
