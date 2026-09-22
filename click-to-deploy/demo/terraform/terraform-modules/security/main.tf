variable "project_id" {
  type        = string
  description = "Target GCP project ID."
}

resource "random_password" "admin_bootstrap_password" {
  length  = 16
  special = false
}

resource "google_secret_manager_secret" "admin_bootstrap_password" {
  project   = var.project_id
  secret_id = "ADMIN_BOOTSTRAP_PASSWORD"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "admin_bootstrap_password_v1" {
  secret      = google_secret_manager_secret.admin_bootstrap_password.id
  secret_data = random_password.admin_bootstrap_password.result
}

resource "google_secret_manager_secret" "agent_platform_api_key" {
  project   = var.project_id
  secret_id = "AGENT_PLATFORM_API_KEY"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "agent_platform_api_key_v1" {
  secret      = google_secret_manager_secret.agent_platform_api_key.id
  secret_data = "CONFIGURE_IN_SECRET_MANAGER_OR_UI_SETTINGS"
}

output "admin_bootstrap_password" {
  value     = random_password.admin_bootstrap_password.result
  sensitive = true
}

output "admin_secret_id" {
  value = google_secret_manager_secret.admin_bootstrap_password.secret_id
}

output "agent_key_secret_id" {
  value = google_secret_manager_secret.agent_platform_api_key.secret_id
}
