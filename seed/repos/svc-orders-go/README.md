# svc-orders-go

Orders API on Go's standard library: create, list, get and delete orders held in memory. Totals are in cents.

Toolchain: **Go 1.25** (`go.mod`). No dependencies.

```sh
go test ./...          # tests
go run .               # serves :8080 (PORT overrides)
docker build -t svc-orders-go .
```

| Route | |
|---|---|
| `GET /healthz` | `ok` |
| `GET /orders` | every order |
| `POST /orders` | `{"customer","items":[{"sku","quantity","price"}]}` → 201 with `id`, `total`, `status: open` |
| `GET /orders/{id}` | one order, 404 when missing |
| `DELETE /orders/{id}` | 204, 404 when missing |

## Deploy

The deploy flow (`.cinder/flows/deploy.yml`) runs the tests, then builds the static binary the `Dockerfile` ships as a dry run: nothing is pushed and no secret is needed. The suggested target is Cloudflare Containers, the image behind a Worker.

## Open gaps

- `PATCH /orders/{id}` to move status open → paid → shipped is missing (`TestUpdateStatus_MovesOpenToShipped` is skipped).
- `GET /orders` has no pagination.
