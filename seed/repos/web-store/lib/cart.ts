import { productById } from "./products";

// The cart is a map of product id → quantity, kept in the "cart" cookie as JSON.
export type Cart = Record<string, number>;

export function parseCart(raw: string | undefined): Cart {
  try {
    const cart = JSON.parse(raw ?? "{}");
    return cart && typeof cart === "object" && !Array.isArray(cart) ? cart : {};
  } catch {
    return {};
  }
}

// Unknown and sold-out products are ignored.
// TODO: quantities above stock are accepted; cap them at the product's stock.
export function addToCart(cart: Cart, id: string): Cart {
  const product = productById(id);
  if (!product || product.stock === 0) return cart;
  return { ...cart, [id]: (cart[id] ?? 0) + 1 };
}

export function cartLines(cart: Cart) {
  return Object.entries(cart).flatMap(([id, qty]) => {
    const product = productById(id);
    return product && qty > 0 ? [{ product, qty, totalCents: product.priceCents * qty }] : [];
  });
}

export const cartTotalCents = (cart: Cart) => cartLines(cart).reduce((sum, l) => sum + l.totalCents, 0);

export const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;
