// A discount code takes a percentage off the cart subtotal.
export function applyDiscount(subtotalCents: number, code?: { percent: number }): number {
  return code ? Math.round(subtotalCents * (1 - code.percent / 100)) : subtotalCents;
}
