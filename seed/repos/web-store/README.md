# web-store

A small storefront on Cloudflare Workers: static product, cart and checkout pages, products read from D1 at
`GET /api/products`, and a cart kept in an HTTP-only cookie (`GET`/`POST /api/cart`). The checkout page is still a stub.

## Toolchain

Node 22.23.3 and npm 10.9.9. Dependency versions are pinned exactly in `package.json`.

## Commands

```sh
npm install
npm run build   # wrangler deploy --dry-run --outdir dist
npm test        # vitest over lib/
```

## Deploy

A Worker with static assets (`public/`) and one D1 database (`DB`, schema in `migrations/`), configured in
`wrangler.jsonc`. The deploy flow proves the bundle with `wrangler deploy --dry-run`; the D1 database id is filled in when
infra-cloudflare-tf is applied.

## Open work

- Stock limits: `addToCart` lets a cart exceed a product's stock; its test is skipped.
- Checkout: no order endpoint (`POST /api/orders`) and no payment step.
