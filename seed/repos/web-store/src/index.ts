import { addToCart, cartLines, cartTotalCents, parseCart, type Cart } from "../lib/cart";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: { prepare(sql: string): { all(): Promise<{ results: unknown[] }> } };
}

const readCart = (request: Request): Cart => {
  const raw = /(?:^|;\s*)cart=([^;]*)/.exec(request.headers.get("Cookie") ?? "")?.[1];
  try {
    return parseCart(raw && decodeURIComponent(raw));
  } catch {
    return {};
  }
};

const cartBody = (cart: Cart) => ({ lines: cartLines(cart), totalCents: cartTotalCents(cart) });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") return new Response("ok");
    if (pathname === "/api/products" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, name, price_cents AS priceCents, stock FROM products ORDER BY name").all();
      return Response.json(results);
    }
    if (pathname === "/api/cart" && request.method === "GET") return Response.json(cartBody(readCart(request)));
    if (pathname === "/api/cart" && request.method === "POST") {
      const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
      const cart = addToCart(readCart(request), String(id));
      return Response.json(cartBody(cart), {
        headers: { "Set-Cookie": `cart=${encodeURIComponent(JSON.stringify(cart))}; HttpOnly; SameSite=Lax; Path=/` },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
