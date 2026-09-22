output "llm_compare_url" {
  description = "Public HTTPS URL of the deployed LLM Compare Cloud Run application."
  value       = module.serverless.service_url
}

output "admin_username" {
  description = "Break-glass administrator username for immediate sign-in at /login."
  value       = "admin"
}

output "admin_bootstrap_password" {
  description = "Auto-generated break-glass administrator password (also stored in Secret Manager as ADMIN_BOOTSTRAP_PASSWORD)."
  value       = module.security.admin_bootstrap_password
  sensitive   = true
}
