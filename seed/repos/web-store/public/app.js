// Fills the product list and the cart from the Worker's API.
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const item = (text) => Object.assign(document.createElement("li"), { textContent: text });

async function showCart(cart) {
  const list = document.getElementById("cart");
  if (!list) return;
  const { lines, totalCents } = cart ?? (await (await fetch("/api/cart")).json());
  list.replaceChildren(...lines.map((l) => item(`${l.qty} × ${l.product.name} — ${money(l.totalCents)}`)));
  document.getElementById("total").textContent = lines.length ? `Total: ${money(totalCents)}` : "Your cart is empty.";
}

async function showProducts() {
  const list = document.getElementById("products");
  if (!list) return;
  const products = await (await fetch("/api/products")).json();
  list.replaceChildren(...products.map((p) => {
    const li = item(`${p.name} — ${money(p.priceCents)} `);
    if (!p.stock) {
      li.append(Object.assign(document.createElement("em"), { textContent: "Sold out" }));
      return li;
    }
    const add = Object.assign(document.createElement("button"), { textContent: "Add to cart" });
    add.onclick = () => fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id }) });
    li.append(add);
    return li;
  }));
}

showProducts();
showCart();
