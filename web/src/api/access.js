import { validateServiceToken } from "../../../worker/src/api/contract.js";
import tokens from "../../../worker/src/api/fixtures/service-tokens.json";
import { checked, fetchJson, fixtures } from "../client.js";

export const serviceTokens = async () => checked("/api/service-tokens", fixtures() ? tokens : await fetchJson("/api/service-tokens"), validateServiceToken);
