import { defineConfig, devices } from "@playwright/test";
import { client } from "../seed/seed.mjs";

// make e2e-live sets E2E_BASE_URL: the run goes against that deploy as is, with no local Worker and no seed.
const { E2E_BASE_URL: baseURL, CINDER_TOKEN, CINDER_ACCESS_CLIENT_ID: accessId, CINDER_ACCESS_CLIENT_SECRET: accessSecret } = process.env;
export const OWNER_TOKEN = CINDER_TOKEN;
// The seed's API client against the same Worker, past Access when a service token is set.
export const api = client({ url: baseURL, token: OWNER_TOKEN, accessId, accessSecret });

// Browsers come from PLAYWRIGHT_BROWSERS_PATH (baked into the cinder-arc image); never `playwright install` in CI.
export default defineConfig({
  testDir: ".",
  testIgnore: "git-fsck.test.js", // node --test, run by make check-ts
  retries: 0,
  workers: 1, // every spec shares one seeded deploy: one spec's changes would shift another's counts
  outputDir: "test-results/live",
  use: {
    baseURL, trace: "retain-on-failure",
    extraHTTPHeaders: accessId && accessSecret ? { "CF-Access-Client-Id": accessId, "CF-Access-Client-Secret": accessSecret } : {},
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
});
