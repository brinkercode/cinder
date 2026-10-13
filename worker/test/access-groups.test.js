import { env } from "cloudflare:workers";
import { expect, it, onTestFinished, vi } from "vitest";
import { validateGroup } from "../src/api/contract.js";
import worker from "../src/index.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, headers, method = "GET", body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers, body }), ACCESS);
const mapEng = () => call("/api/groups/eng", { ...OWNER, "Content-Type": "application/json" }, "PUT", JSON.stringify({ source: "Access group", role: "developer", repos: [] }));

it("a person in the mapped eng group gets the developer role without an invite", async () => {
  serveCerts();
  onTestFinished(() => vi.restoreAllMocks());
  const dev = await as("dev@groups.test", { groups: ["eng"] });
  expect((await call("/api/repos", dev)).status).toBe(403);
  expect((await mapEng()).status).toBe(200);
  expect((await call("/api/repos", dev)).status).toBe(200);
  // Access identities carry groups as {id, name}; another group's member gets nothing.
  expect((await call("/api/repos", await as("idp@groups.test", { groups: [{ id: "g1", name: "eng" }] }))).status).toBe(200);
  expect((await call("/api/repos", await as("ops@groups.test", { groups: ["ops"] }))).status).toBe(403);
  // developer reads and writes repos but doesn't manage people.
  expect((await call("/api/groups/eng", dev, "DELETE")).status).toBe(403);
});

it("removing the mapping removes the role on the next request", async () => {
  serveCerts();
  onTestFinished(() => vi.restoreAllMocks());
  const dev = await as("dev2@groups.test", { groups: ["eng"] });
  await mapEng();
  expect((await call("/api/repos", dev)).status).toBe(200);
  expect((await call("/api/groups/eng", OWNER, "DELETE")).status).toBe(204);
  expect((await call("/api/repos", dev)).status).toBe(403);
});

it("mappings apply at the next sign-in", async () => {
  serveCerts();
  onTestFinished(() => vi.restoreAllMocks());
  const before = await as("ops@next.test", { groups: ["support"] });
  expect((await call("/api/repos", before)).status).toBe(403);
  const mapped = await call("/api/groups", { ...OWNER, "Content-Type": "application/json" }, "POST", JSON.stringify({ name: "support", source: "IdP group", role: "viewer", repos: [] }));
  expect([mapped.status, validateGroup(await mapped.json()).ok]).toEqual([200, true]);
  expect((await call("/api/repos", await as("ops@next.test", { groups: ["support"] }))).status).toBe(200);
  expect((await call("/api/groups", { ...OWNER, "Content-Type": "application/json" }, "POST", JSON.stringify({ source: "IdP group", role: "viewer", repos: [] }))).status).toBe(400);
});

it("a group from a second IdP of the same type grants no role", async () => {
  serveCerts();
  onTestFinished(() => vi.restoreAllMocks());
  const put = await call("/api/groups/saml-eng", { ...OWNER, "Content-Type": "application/json" }, "PUT", JSON.stringify({ source: "IdP group (idp-a)", role: "developer", repos: [] }));
  expect(put.status).toBe(200);
  expect((await call("/api/repos", await as("a@saml.test", { idp: { id: "idp-a", type: "saml" }, groups: ["saml-eng"] }))).status).toBe(200);
  expect((await call("/api/repos", await as("b@saml.test", { idp: { id: "idp-b", type: "saml" }, groups: ["saml-eng"] }))).status).toBe(403);
});
