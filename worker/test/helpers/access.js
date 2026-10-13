import { env } from "cloudflare:workers";
import { vi } from "vitest";

const TEAM = "cinder-helper.cloudflareaccess.com";
// The worker env with Access on; a person signs in with as(email).
export const ACCESS = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud-cinder", OWNERS: "boss@example.com" };
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const part = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const keys = crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);

// Serves the test key at the team's certs URL; any other fetch goes through. Restored by vi.restoreAllMocks.
export function serveCerts() {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) return real(url, init);
    return Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", (await keys).publicKey)), kid: "k1", alg: "RS256" }] });
  });
}

// The headers of a request signed in through Access as email, with any extra claims (groups).
export async function as(email, claims = {}) {
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part({ aud: ["aud-cinder"], iss: `https://${TEAM}`, email, exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await keys).privateKey, new TextEncoder().encode(body));
  return { "Cf-Access-Jwt-Assertion": `${body}.${b64url(sig)}` };
}
