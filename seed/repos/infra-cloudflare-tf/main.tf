resource "cloudflare_d1_database" "db" {
  account_id = var.account_id
  name       = var.name
}

resource "cloudflare_workers_script" "edge" {
  account_id         = var.account_id
  script_name        = var.name
  content            = file(var.script_path)
  main_module        = "index.js"
  compatibility_date = var.compatibility_date
  assets             = { directory = var.assets_dir }
  bindings = [
    { type = "d1", name = "DB", id = cloudflare_d1_database.db.id },
    { type = "assets", name = "ASSETS" },
  ]
}

# TODO: no route or custom domain yet; the Worker is reachable only on its workers.dev subdomain.
