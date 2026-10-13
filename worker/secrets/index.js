// cinder-secrets: holds one secrets_store_secret binding per keystore and webhook secret (KS_*), which keystore.js
// rebind() PATCHes onto this Worker. It has no Durable Objects or containers, so a settings roll resets nothing
// stateful. Reachable only through cinder's SECRETS service binding: no route, no workers.dev URL.
import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  // Cloudflare refuses a Worker with no event handler (code 10068); nothing routes here, so any fetch is a 404.
  fetch() {
    return new Response(null, { status: 404 });
  }

  // read("KS_…") → the secret's value, or null while this version doesn't bind it yet.
  async read(name) {
    return name.startsWith("KS_") && this.env[name] ? this.env[name].get() : null;
  }
}
