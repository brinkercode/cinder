variable "account_id" {
  description = "Cloudflare account that owns the Worker and its D1 database."
  type        = string
}

variable "name" {
  description = "Name of the Worker and its D1 database."
  type        = string
  default     = "web-store"

  validation {
    condition     = can(regex("^[a-z0-9-]{1,40}$", var.name))
    error_message = "name must be 1-40 lowercase letters, digits or hyphens."
  }
}

variable "script_path" {
  description = "Path to web-store's bundled ES module."
  type        = string
}

variable "assets_dir" {
  description = "Directory of web-store's static assets (its public/)."
  type        = string
}

variable "compatibility_date" {
  type    = string
  default = "2026-10-01"
}
