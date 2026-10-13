// In-memory stand-ins for the D1 and KV bindings, so tests never call Cloudflare.
export function fakeEnv(targets) {
  const rows = [];
  const kv = new Map();
  const DB = {
    rows,
    prepare: (sql) => ({
      bind: (...args) => ({
        sql,
        args,
        // Only the uptime query reads; it groups by url over rows newer than args[0].
        all: async () => {
          const by = Map.groupBy(rows.filter((r) => r.checked_at > args[0]), (r) => r.url);
          return { results: [...by].map(([url, rs]) => ({ url, uptime: rs.reduce((n, r) => n + r.ok, 0) / rs.length })) };
        },
      }),
    }),
    batch: async (stmts) => {
      for (const { args: [url, ok, status, ms, checked_at] } of stmts) rows.push({ url, ok, status, ms, checked_at });
    },
  };
  const CACHE = {
    put: async (k, v) => { kv.set(k, v); },
    get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
  };
  return { TARGETS: targets, DB, CACHE };
}
