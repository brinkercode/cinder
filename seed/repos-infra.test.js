// Each infrastructure and library seed repo passes the check its .cinder.yml declares (validate, lint and test) from a
// clean copy. Run: node --test seed/repos-infra.test.js (needs the registries; not part of make check).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import { parseYaml } from "../worker/src/yaml.js";

const repos = new URL("./repos/", import.meta.url).pathname;
const built = new Set(["node_modules", "dist", ".terraform", ".venv"]);
const env = { ...process.env, CI: "1" };
const onPath = (tool) => { try { execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }); return true; } catch { return false; } };

describe("each seed infra and library repo runs its validate, lint and test commands and they pass", () => {
  for (const name of ["infra-cloudflare-tf"]) {
    const { check } = parseYaml(readFileSync(join(repos, name, ".cinder.yml"), "utf8"));
    const tool = check.split(" ")[0];
    test(`seed repo ${name} passes its .cinder.yml check from a clean checkout`, { skip: !onPath(tool) && `${tool} is not on PATH`, timeout: 600_000 }, () => {
      const dir = mkdtempSync(join(tmpdir(), `seed-${name}-`));
      try {
        cpSync(join(repos, name), dir, { recursive: true, filter: (src) => !built.has(basename(src)) });
        execFileSync("sh", ["-c", check], { cwd: dir, stdio: "inherit", env });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test("infra-cloudflare-tf plans and plans the destroy with no credentials", { skip: !onPath("terraform") && "terraform is not on PATH", timeout: 600_000 }, () => {
  const name = "infra-cloudflare-tf";
  const steps = (flow) => parseYaml(readFileSync(join(repos, name, ".cinder/flows", flow), "utf8")).steps;
  const plan = steps("deploy.yml").plan.run;
  const destroy = steps("destroy.yml")["plan-destroy"].run;
  const bare = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLOUDFLARE|AWS)_/.test(k)));
  // Once init has the providers, a dead proxy fails any API call a plan would make.
  const offline = { ...bare, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "" };
  const dir = mkdtempSync(join(tmpdir(), `seed-${name}-`));
  try {
    cpSync(join(repos, name), dir, { recursive: true, filter: (src) => !built.has(basename(src)) });
    execFileSync("sh", ["-c", plan], { cwd: dir, stdio: "inherit", env: bare });
    for (const run of [plan.split(" && ").at(-1), destroy]) execFileSync("sh", ["-c", run], { cwd: dir, stdio: "inherit", env: offline });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
