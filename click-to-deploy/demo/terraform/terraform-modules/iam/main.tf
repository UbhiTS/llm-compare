variable "project_id" {
  type        = string
  description = "Target GCP project ID."
}

variable "service_name" {
  type        = string
  default     = "llm-compare"
  description = "Base name for the runtime service account."
}

resource "google_service_account" "runtime_sa" {
  project      = var.project_id
  account_id   = "${var.service_name}-run"
  display_name = "LLM Compare Cloud Run Runtime Service Account"
}

resource "google_project_iam_member" "vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime_sa.email}"
}

resource "google_project_iam_member" "secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.runtime_sa.email}"
}

output "runtime_sa_email" {
  value = google_service_account.runtime_sa.email
}
