variable "project_id" {
  type        = string
  description = "Target GCP project ID."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "GCS bucket location."
}

variable "runtime_sa_email" {
  type        = string
  description = "Runtime Service Account email granted objectAdmin on the appdata bucket."
}

resource "google_storage_bucket" "appdata" {
  project                     = var.project_id
  name                        = "${var.project_id}-appdata"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
}

resource "google_storage_bucket_iam_member" "appdata_admin" {
  bucket = google_storage_bucket.appdata.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${var.runtime_sa_email}"
}

output "bucket_name" {
  value = google_storage_bucket.appdata.name
}
