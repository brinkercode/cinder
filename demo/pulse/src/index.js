const DAY_MS = 24 * 60 * 60 * 1000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The targets that were up at the previous check and are down now.
export function alerts(previous, latest) {
  const up = new Set(previous.filter((r) => r.ok).map((r) => r.url));
  return latest.filter((r) => !r.ok && up.has(r.url));
}

// One request per target; a network error or timeout counts as down with status 0.
export async function check(env, now = Date.now()) {
  const urls = (env.TARGETS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const latest = await Promise.all(urls.map(async (url) => {
    const start = Date.now();
    let status = 0;
    try {
      status = (await fetch(url, { signal: AbortSignal.timeout(10000) })).status;
    } catch { /* down */ }
    return { url, ok: status >= 200 && status < 400, status, ms: Date.now() - start };
  }));
  if (latest.length) {
    await env.DB.batch(latest.map((r) => env.DB.prepare("INSERT INTO results (url, ok, status, ms, checked_at) VALUES (?, ?, ?, ?, ?)")
      .bind(r.url, r.ok ? 1 : 0, r.status, r.ms, now)));
  }
  const previous = (await env.CACHE.get("latest", "json"))?.results ?? [];
  await env.CACHE.put("latest", JSON.stringify({ checked_at: now, results: latest, went_down: alerts(previous, latest).map((r) => r.url) }));
  return latest;
}

async function page(env) {
  const latest = (await env.CACHE.get("latest", "json")) ?? { results: [] };
  const { results: uptime } = await env.DB.prepare("SELECT url, AVG(ok) AS uptime FROM results WHERE checked_at > ? GROUP BY url")
    .bind(Date.now() - DAY_MS).all();
  const pct = Object.fromEntries(uptime.map((u) => [u.url, `${(u.uptime * 100).toFixed(2)}%`]));
  const rows = latest.results.map((r) => `<tr><td>${esc(r.url)}</td><td>${r.ok ? "up" : "down"}</td><td>${r.status}</td>`
    + `<td>${r.ms} ms</td><td>${pct[r.url] ?? "-"}</td></tr>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>pulse</title><h1>pulse</h1>
<table><tr><th>Endpoint</th><th>Status</th><th>Code</th><th>Time</th><th>Uptime 24h</th></tr>${rows || "<tr><td colspan=5>No checks yet</td></tr>"}</table>`;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") return new Response("ok");
    if (pathname !== "/") return new Response("not found", { status: 404 });
    return new Response(await page(env), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(check(env));
  },
};
