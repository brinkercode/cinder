# Plans against a mocked provider: no Cloudflare credentials or API calls.
mock_provider "cloudflare" {}

variables {
  account_id  = "0123456789abcdef0123456789abcdef"
  script_path = "tests/fixture.js"
  assets_dir  = "tests/public"
}

run "plans_worker_assets_and_d1" {
  command = plan

  assert {
    condition     = cloudflare_workers_script.edge.script_name == "web-store"
    error_message = "the Worker is named web-store"
  }
  assert {
    condition     = cloudflare_d1_database.db.name == "web-store" && cloudflare_workers_script.edge.assets.directory == "tests/public"
    error_message = "the D1 database is web-store and the Worker uploads the assets directory"
  }
  assert {
    condition     = [for b in cloudflare_workers_script.edge.bindings : "${b.type}:${b.name}"] == ["d1:DB", "assets:ASSETS"]
    error_message = "the Worker binds D1 as DB and its static assets as ASSETS"
  }
}

run "rejects_an_invalid_name" {
  command = plan
  variables {
    name = "Edge_Hono"
  }
  expect_failures = [var.name]
}
