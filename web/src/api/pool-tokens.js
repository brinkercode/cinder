import poolTokensFixture from "../../../worker/src/api/fixtures/pool-tokens.json";
import { validatePoolToken } from "../../../worker/src/api/contract.js";
import { checked, fetchJson, fixtures } from "../client.js";

// GET /api/workers/byo-pools/:id/tokens → PoolToken[]: the pool's issued tokens, newest first.
export async function poolTokens(id) {
  const path = `/api/workers/byo-pools/${encodeURIComponent(id)}/tokens`;
  return checked(path, fixtures() ? poolTokensFixture : await fetchJson(path), validatePoolToken);
}
