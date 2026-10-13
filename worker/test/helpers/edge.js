import { env } from "cloudflare:workers";

// The edge for live tests: the browser sends no token and Access identifies the person, here the owner.
// A request that already carries a token (seed's client, a runner) keeps it.
export function signedIn(url, init) {
  const req = new Request(new URL(url, "http://cinder.test"), init);
  if (!req.headers.has("Authorization")) req.headers.set("Authorization", `Bearer ${env.OWNER_TOKEN}`);
  return req;
}
