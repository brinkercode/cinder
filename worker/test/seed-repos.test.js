// The seed repos' own files: what they build, bind and deploy.
import { expect, it } from "vitest";
import { parseFlow, validateFlow } from "../src/api/shapes.js";
import { SEED_SOURCES } from "./fakes/seed.js";

const store = SEED_SOURCES["web-store"];
const flows = Object.entries(store).filter(([path]) => path.startsWith(".cinder/flows/"));

it("web-store has a wrangler.jsonc with static assets and a D1 binding and no Next.js files", () => {
  const config = JSON.parse(store["wrangler.jsonc"].replace(/^\s*\/\/.*$/gm, ""));
  expect(config).toMatchObject({ name: "web-store", main: "src/index.ts", assets: { directory: "public", binding: "ASSETS" } });
  expect(config.compatibility_date).toMatch(/^\d{4}-\d\d-\d\d$/);
  expect(config.d1_databases).toEqual([expect.objectContaining({ binding: "DB", database_name: "web-store", migrations_dir: "migrations" })]);
  expect(store["src/index.ts"]).toBeDefined();
  expect(Object.keys(store).filter((p) => p.startsWith("public/")).sort()).toEqual(["public/app.js", "public/cart.html", "public/checkout.html", "public/index.html"]);
  expect(store["migrations/0001_products.sql"]).toMatch(/CREATE TABLE products[\s\S]*INSERT INTO products/);
  expect(Object.keys(store).filter((p) => /^app\/|^next\.config|^Dockerfile$|^\.dockerignore$|\.tsx$/.test(p))).toEqual([]);
  const { dependencies = {}, devDependencies } = JSON.parse(store["package.json"]);
  expect(Object.keys({ ...dependencies, ...devDependencies }).sort()).toEqual(["lodash", "typescript", "vitest", "wrangler"]);
  expect(store[".cinder.yml"]).not.toMatch(/worker:/);
});

it("web-store's flows have no deploy step and need no secret", () => {
  expect(flows.map(([path]) => path).sort()).toEqual([".cinder/flows/build.yml", ".cinder/flows/ci.yml", ".cinder/flows/daily.yml", ".cinder/flows/deploy.yml"]);
  for (const [path, text] of flows) {
    const flow = parseFlow(text);
    expect(validateFlow(flow).errors, path).toEqual([]);
    expect(flow.secrets, path).toEqual([]);
    expect(flow.steps.filter((s) => s.deploy || s.secrets || s.approval).map((s) => s.name), path).toEqual([]);
  }
});

it("web-store's deploy flow runs wrangler deploy --dry-run", () => {
  const { steps } = parseFlow(store[".cinder/flows/deploy.yml"]);
  expect(steps.map((s) => [s.name, s.run || s.uses])).toEqual([
    ["install", "npm ci --prefer-offline --no-audit --no-fund"], ["test", "npm test"], ["build", "npx wrangler deploy --dry-run --outdir dist"],
  ]);
});

const orders = SEED_SOURCES["svc-orders-go"];

it("svc-orders-go's deploy flow builds the binary and pushes nothing, with no secret", () => {
  const text = orders[".cinder/flows/deploy.yml"];
  const flow = parseFlow(text);
  expect(validateFlow(flow).errors).toEqual([]);
  expect(flow.secrets).toEqual([]);
  expect(flow.steps.map((s) => [s.name, s.run])).toEqual([
    ["test", "go vet ./... && go test -v ./..."], ["build", "CGO_ENABLED=0 go build -o bin/svc-orders-go ."],
  ]);
  expect(flow.steps.filter((s) => s.deploy || s.secrets || s.approval)).toEqual([]);
  expect(text).not.toMatch(/(docker|buildah|podman) push|kubectl|ghcr\.io/);
});

it("svc-orders-go's .cinder.yml names no Google Cloud target and no Worker config", () => {
  const manifest = orders[".cinder.yml"];
  expect(manifest).not.toMatch(/Google Cloud|worker:|wrangler|environments:/);
  expect(manifest).toMatch(/integration: \[main\]/);
  expect(manifest).toMatch(/route: \[orders\.go\]/);
  expect(orders.Dockerfile).toBeDefined();
});

const infra = SEED_SOURCES["infra-cloudflare-tf"];
const infraFlows = Object.entries(infra).filter(([path]) => path.startsWith(".cinder/flows/"));

it("infra-cloudflare-tf declares web-store's Worker, assets and D1 and no R2 bucket", () => {
  const tf = infra["main.tf"];
  expect(tf).toMatch(/resource "cloudflare_d1_database" "db"/);
  expect(tf).toMatch(/assets\s+= \{ directory = var\.assets_dir \}/);
  expect(tf).toMatch(/\{ type = "d1", name = "DB", id = cloudflare_d1_database\.db\.id \}/);
  expect(tf).toMatch(/\{ type = "assets", name = "ASSETS" \}/);
  expect(infra["variables.tf"]).toMatch(/default\s+= "web-store"/);
  expect(Object.values(infra).join("\n")).not.toMatch(/r2_bucket|svc-edge-hono/);
  expect(infra["tests/plan.tftest.hcl"]).toMatch(/\["d1:DB", "assets:ASSETS"\]/);
  expect(infra["aws/main.tf"]).toMatch(/resource "aws_s3_bucket" "assets"[\s\S]*bucket = "web-store-assets"/);
  expect(infra[".cinder.yml"]).not.toMatch(/worker:|terraform apply/);
});

it("infra-cloudflare-tf's deploy flow plans Cloudflare with no secret", () => {
  const flow = parseFlow(infra[".cinder/flows/deploy.yml"]);
  expect(validateFlow(flow).errors).toEqual([]);
  expect(flow.secrets).toEqual([]);
  expect(Object.keys(flow.env)).toEqual([]);
  expect(flow.steps.map((s) => [s.name, s.stage, s.run, s.secrets])).toEqual([
    ["plan", "plan", "terraform init -backend=false -input=false && terraform plan -refresh=false -input=false -lock=false", undefined],
  ]);
});

it("infra-cloudflare-tf has a manual destroy flow that only plans the destroy", () => {
  const flow = parseFlow(infra[".cinder/flows/destroy.yml"]);
  expect(validateFlow(flow).errors).toEqual([]);
  expect(flow.on).toEqual(["manual"]);
  expect(flow.secrets).toEqual([]);
  expect(flow.steps.map((s) => [s.name, s.run, s.secrets])).toEqual([["plan-destroy", "terraform plan -destroy -refresh=false -input=false -lock=false", undefined]]);
});

it("no infra-cloudflare-tf flow runs terraform apply", () => {
  expect(infraFlows.map(([path]) => path).sort()).toEqual([".cinder/flows/check.yml", ".cinder/flows/daily.yml", ".cinder/flows/deploy.yml", ".cinder/flows/destroy.yml"]);
  for (const [path, text] of infraFlows) {
    expect(text, path).not.toMatch(/terraform\s+(-chdir=\S+\s+)?(apply|destroy)|auto-approve|CLOUDFLARE_API_TOKEN/);
    expect(parseFlow(text).steps.filter((s) => s.deploy || s.approval).map((s) => s.name), path).toEqual([]);
  }
});

it("no seed repo flow has a deploy step, an apply or a push", () => {
  for (const [repo, files] of Object.entries(SEED_SOURCES)) {
    for (const [path, text] of Object.entries(files).filter(([p]) => p.startsWith(".cinder/flows/"))) {
      expect(text, `${repo}/${path}`).not.toMatch(/terraform\s+(-chdir=\S+\s+)?apply|auto-approve|(docker|buildah|podman|git) push|wrangler deploy(?! --dry-run)|kubectl/);
      expect(parseFlow(text).steps.filter((s) => s.deploy || s.approval).map((s) => s.name), `${repo}/${path}`).toEqual([]);
    }
  }
});
