// A fake Cloudflare API for the keystore and model keys: one Secrets Store store, the cinder-secrets Worker's settings,
// and AI Gateway provider configs (each needs its secret in the store first, as the real API does). Values stay in here,
// as they stay in Cloudflare. `env` is what a test spreads into the Worker's env: the API token and account, plus a
// SECRETS service binding stub that reads every secrets_store_secret binding the last settings PATCH declared, as
// cinder-secrets sees them once that version deploys. `bound` lists those binding names.
// `used` starts the store with that many other secrets; `deny` lists path prefixes ("/secrets_store", "/ai-gateway")
// the token has no permission for, answered 403.
const API = "https://api.cloudflare.com/client/v4/accounts/acct";

export function fakeCloudflare({ used = 0, deny = [] } = {}) {
  const secrets = new Map([...Array(used)].map((_, i) => [`other-${i}`, { name: `other_${i}`, value: "", created: new Date().toISOString() }]));
  const configs = new Map();
  const requests = [];
  let bindings = [{ type: "d1", name: "DB" }];
  const ok = (result, extra) => Response.json({ success: true, result, ...extra });
  const missing = () => Response.json({ success: false }, { status: 404 });

  async function fetch(input, init = {}) {
    const req = new Request(input, init);
    const path = req.url.slice(API.length);
    const method = req.method;
    requests.push({ method, url: req.url, headers: Object.fromEntries(req.headers), body: req.headers.get("content-type") === "application/json" ? await req.clone().text() : "" });
    if (deny.some((p) => path.startsWith(p))) return Response.json({ success: false }, { status: 403 });
    let m;
    if (method === "GET" && path === "/secrets_store/quota") return ok({ secrets: { quota: 100, usage: secrets.size } });
    if (method === "GET" && path === "/secrets_store/stores") return ok([{ id: "store1", name: "cinder" }]);
    if (method === "GET" && path.startsWith("/secrets_store/stores/store1/secrets")) return ok([...secrets].slice(0, Number(new URL(req.url).searchParams.get("per_page") ?? 20)).map(([id, s]) => ({ id, name: s.name, created: s.created })), { result_info: { total_count: secrets.size } });
    if (method === "POST" && path === "/secrets_store/stores/store1/secrets") {
      const made = await req.json();
      // As the real API: a name is unique in its store.
      const taken = made.find(({ name }) => [...secrets.values()].some((s) => s.name === name));
      if (taken) return Response.json({ success: false, errors: [{ code: 1002, message: `secret ${taken.name} already exists` }] }, { status: 409 });
      return ok(made.map(({ name, value, scopes }) => {
        const id = crypto.randomUUID();
        secrets.set(id, { name, value, scopes, created: new Date().toISOString() });
        return { id, name };
      }));
    }
    if ((m = path.match(/^\/secrets_store\/stores\/store1\/secrets\/([\w-]+)$/))) {
      if (!secrets.has(m[1])) return missing();
      if (method === "PATCH") secrets.get(m[1]).value = (await req.json()).value;
      if (method === "DELETE") secrets.delete(m[1]);
      return ok({ id: m[1] });
    }
    if (method === "GET" && path.startsWith("/ai/models/search?")) return ok([{ name: "@cf/qwen/qwen2.5-coder-32b-instruct" }, { name: "@cf/openai/gpt-oss-120b" },
      { name: "@cf/meta/llama-4-scout-17b-16e-instruct" }]);
    if (path === "/workers/scripts/cinder-secrets/settings" && method === "GET") return ok({ bindings });
    if (path === "/workers/scripts/cinder-secrets/settings" && method === "PATCH") {
      ({ bindings } = JSON.parse(await (await req.formData()).get("settings").text()));
      return ok({ bindings });
    }
    if ((m = path.match(/^\/ai-gateway\/gateways\/cinder\/provider_configs(?:\/([\w-]+))?(?:\?.*)?$/))) {
      if (method === "POST") {
        const config = await req.json();
        // As the real API: the config's key is the ai_gateway-scoped secret {gateway}_{provider_slug}_{alias}.
        const name = `cinder_${config.provider_slug}_${config.alias}`;
        if (![...secrets.values()].some((s) => s.name === name && s.scopes?.includes("ai_gateway"))) {
          return Response.json({ success: false, errors: [{ code: 7001, message: `Secret ${name} was not found. Create the secret in Secrets Store` }] }, { status: 400 });
        }
        // As the real API: one config per alias and provider (code 7001 "... already exists").
        if ([...configs.values()].some((c) => c.alias === config.alias && c.provider_slug === config.provider_slug)) {
          return Response.json({ success: false, errors: [{ code: 7001, message: `Provider config with provider slug ${config.provider_slug} already exists` }] }, { status: 400 });
        }
        const id = crypto.randomUUID();
        configs.set(id, config);
        return ok({ id });
      }
      if (method === "GET" && !m[1]) return ok([...configs].map(([id, c]) => ({ id, ...c })), { result_info: { total_pages: 1 } });
      if (method === "DELETE") return configs.delete(m[1]) ? ok({ id: m[1] }) : missing();
    }
    return missing();
  }

  return {
    fetch, secrets, configs, requests,
    // Hands Cloudflare API calls to the fake and everything else to `other`.
    through: (other) => (input, init) => (String(input?.url ?? input).startsWith(API) ? fetch(input, init) : other(input, init)),
    get bound() {
      return bindings.filter((b) => b.type === "secrets_store_secret").map((b) => b.name);
    },
    get env() {
      const bound = bindings.filter((b) => b.type === "secrets_store_secret");
      const SECRETS = {
        read: async (name) => {
          const b = bound.find((x) => x.name === name);
          return b ? [...secrets.values()].find((s) => s.name === b.secret_name)?.value : null;
        },
      };
      return { CF_DEPLOY_TOKEN: "cf-test-token", CF_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "cinder", SECRETS };
    },
  };
}
