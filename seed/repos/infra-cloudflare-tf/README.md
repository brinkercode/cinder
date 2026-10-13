# infra-cloudflare-tf

A Terraform module that declares web-store on Cloudflare: the Worker script with its static assets bound as `ASSETS`
and a D1 database `web-store` bound as `DB`. `aws/` declares an S3 bucket that mirrors web-store's assets.

```hcl
module "store" {
  source      = "./infra-cloudflare-tf"
  account_id  = var.account_id
  script_path = "../web-store/dist/index.js"
  assets_dir  = "../web-store/public"
}
```

## Toolchain

Terraform 1.13.3, the `cloudflare/cloudflare` provider `~> 5.10` and, in `aws/`, `hashicorp/aws` `~> 6.0`.

## Commands

```sh
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform test   # plans against a mocked provider: no credentials, no API calls
```

## Flows

Both flows only plan; nothing here is applied. `terraform.tfvars` holds plan-only placeholders.

- `deploy` (push, manual): stage `plan` runs `terraform plan -refresh=false` with no credentials and makes no API
  call. No flow plans `aws/`: its plan needs AWS credentials.
- `destroy` (manual): `terraform plan -destroy`.

## Open work

- Routing: no route or custom domain; the Worker is reachable only on workers.dev (TODO in `main.tf`).
