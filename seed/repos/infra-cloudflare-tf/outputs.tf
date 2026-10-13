output "worker_name" {
  value = cloudflare_workers_script.edge.script_name
}

output "d1_database_id" {
  value = cloudflare_d1_database.db.id
}
