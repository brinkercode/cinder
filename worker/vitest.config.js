import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
// Writes seed/bundle.json, which src/admin.js imports, as wrangler's build.command does before a deploy.
import "../seed/bundle.mjs";

// Miniflare keeps D1 and Durable Object SQLite under os.tmpdir() and fsyncs every write; on a disk shared with other
// deliveries one fsync can stall for tens of seconds and time a random test out. tmpfs makes fsync free.
if (existsSync("/dev/shm")) process.env.TMPDIR = "/dev/shm";

// react-icons/pi is one 5.6 MB module, over the workerd pool's WebSocket message limit (1009 "Message is too large")
// when live tests render web/src; serve only the icons web/src names.
const web = new URL("../web/src/", import.meta.url);
const piUsedOnly = {
  name: "pi-used-only",
  load(id) {
    if (!id.endsWith("/react-icons/pi/index.mjs")) return;
    const used = new Set(readdirSync(web, { recursive: true }).filter((f) => f.endsWith(".jsx"))
      .flatMap((f) => readFileSync(new URL(f, web), "utf8").match(/\bPi[A-Z]\w*/g) ?? []));
    const [head, ...icons] = readFileSync(id, "utf8").split(/\n(?=export function )/);
    return [head, ...icons.filter((c) => used.has(c.match(/^export function (\w+)/)[1]))].join("\n");
  },
};

export default defineConfig({
  plugins: [piUsedOnly, cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: { OWNER_TOKEN: "test-owner-token", CINDER_ENV: "nonprod", TEST_MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname) },
      // A local Secrets Store secret (seeded in test/setup.js), as deploys bind LIVE_TICKET_KEY.
      secretsStoreSecrets: { LIVE_TICKET_KEY: { store_id: "test", secret_name: "live-ticket-key" } },
      // Tests patch the Artifacts fake onto live instances (i.env); workerd's 10 s idle eviction would drop it
      // whenever a loaded machine stalls a test, so keep them resident as the pool does its own runner object.
      durableObjects: {
        REPO_DO: { className: "RepoDO", useSQLite: true, unsafePreventEviction: true },
        CHANGE_DO: { className: "ChangeDO", useSQLite: true, unsafePreventEviction: true },
        DISPATCH_DO: { className: "DispatchDO", useSQLite: true, unsafePreventEviction: true },
      },
    },
  }))],
  // seed/seed.test.js drives the seed through this Worker, so it runs here.
  test: { include: ["**/*.test.js", "../seed/seed.test.js", "../seed/large.test.js"], setupFiles: ["./test/setup.js", "../web/src/test-setup.js"], globalSetup: ["./test/helpers/runners.js"], testTimeout: 30000, hookTimeout: 30000 },
});
