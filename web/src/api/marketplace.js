import { validateAccountChoice, validateAgent, validateCatalogEntry } from "../../../worker/src/api/contract.js";
import { checked, fetchJson, fixtures, postJson } from "../client.js";

// lazy: fixture mode serves an empty marketplace; add catalog and account fixtures when the demo needs them.
const list = async (path, validate) => checked(path, fixtures() ? [] : await fetchJson(path), validate);

// GET /api/marketplace → [CatalogEntry], with the accounts an install can go into and this instance's agents to publish.
export const marketplace = () => Promise.all([list("/api/marketplace", validateCatalogEntry), list("/api/accounts", validateAccountChoice), list("/api/agents", validateAgent)]);

// POST /api/agents/:name/install {template, account_id, version, channel} → 202 the queued release job.
export const install = (name, body) => postJson(`/api/agents/${encodeURIComponent(name)}/install`, body);

// POST /api/agents/:name/publish {version, description, visibility}.
export const publish = (name, body) => postJson(`/api/agents/${encodeURIComponent(name)}/publish`, body);
