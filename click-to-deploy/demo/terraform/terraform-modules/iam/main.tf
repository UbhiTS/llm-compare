variable "project_id" {
  type        = string
  description = "Target GCP project ID."
}

variable "project_number" {
  type        = string
  default     = ""
  description = "Target GCP project number (used to grant Cloud Build permissions to the default Compute Engine service account)."
}

variable "service_name" {
  type        = string
  default     = "llm-compare"
  description = "Base name for the runtime service account."
}

locals {
  runtime_roles = [
    "roles/aiplatform.user",
    "roles/secretmanager.secretAccessor",
    "roles/storage.admin",
    "roles/artifactregistry.writer",
    "roles/logging.logWriter",
    "roles/cloudbuild.builds.builder"
  ]

  compute_sa_roles = [
    "roles/storage.admin",
    "roles/artifactregistry.writer",
    "roles/logging.logWriter",
    "roles/cloudbuild.builds.builder"
  ]
}

resource "google_service_account" "runtime_sa" {
  project      = var.project_id
  account_id   = "${var.service_name}-run"
  display_name = "LLM Compare Cloud Run & Cloud Build Service Account"
}

resource "google_project_iam_member" "runtime_sa_bindings" {
  for_each = toset(local.runtime_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime_sa.email}"
}

resource "google_project_iam_member" "compute_sa_bindings" {
  for_each = var.project_number != "" ? toset(local.compute_sa_roles) : toset([])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${var.project_number}-compute@developer.gserviceaccount.com"
}

output "runtime_sa_email" {
  value      = google_service_account.runtime_sa.email
  depends_on = [google_project_iam_member.runtime_sa_bindings, google_project_iam_member.compute_sa_bindings]
}

