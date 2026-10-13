import { applyD1Migrations } from "cloudflare:test";

// TEST_MIGRATIONS is read from migrations/ in vitest.config.js (Node side) and bound into the test Worker.
export function applyMigrations(env) {
  return applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}
