export interface Product {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
}

export const products: Product[] = [
  { id: "mug", name: "Enamel mug", priceCents: 1400, stock: 12 },
  { id: "tee", name: "Cotton tee", priceCents: 2500, stock: 5 },
  { id: "cap", name: "Canvas cap", priceCents: 1900, stock: 0 },
];

export const productById = (id: string) => products.find((p) => p.id === id);
