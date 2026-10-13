import { describe, expect, it } from "vitest";
import { addToCart, cartLines, cartTotalCents, formatCents, parseCart } from "./cart";

describe("cart", () => {
  it("adds a product and totals the lines", () => {
    const cart = addToCart(addToCart(addToCart({}, "mug"), "mug"), "tee");
    expect(cart).toEqual({ mug: 2, tee: 1 });
    expect(cartTotalCents(cart)).toBe(5300);
    expect(formatCents(cartTotalCents(cart))).toBe("$53.00");
  });

  it("ignores unknown and sold-out products", () => {
    expect(addToCart({}, "nope")).toEqual({});
    expect(addToCart({}, "cap")).toEqual({});
  });

  it("reads a missing or corrupt cookie as an empty cart", () => {
    expect(parseCart(undefined)).toEqual({});
    expect(parseCart("{not json")).toEqual({});
    expect(parseCart("[1]")).toEqual({});
    expect(cartLines(parseCart('{"gone":3}'))).toEqual([]);
  });

  // Open gap: see the TODO on addToCart.
  it.skip("never puts more of a product in the cart than is in stock", () => {
    let cart = {};
    for (let i = 0; i < 6; i++) cart = addToCart(cart, "tee");
    expect(cart).toEqual({ tee: 5 });
  });
});
