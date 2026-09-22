# ---------------------------------------------------------------------------
# Root Module Orchestrator — LLM Compare (Demo #2165)
# Single-Project Click-to-Deploy Configuration
# ---------------------------------------------------------------------------

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Default Google Cloud region for Cloud Run, Artifact Registry, and GCS."
}

module "iam" {
  source     = "./terraform-modules/iam"
  project_id = var.project_id
}

module "gcs" {
  source           = "./terraform-modules/gcs"
  project_id       = var.project_id
  region           = var.region
  runtime_sa_email = module.iam.runtime_sa_email
}

module "security" {
  source     = "./terraform-modules/security"
  project_id = var.project_id
}

module "serverless" {
  source              = "./terraform-modules/serverless"
  project_id          = var.project_id
  region              = var.region
  runtime_sa_email    = module.iam.runtime_sa_email
  appdata_bucket      = module.gcs.bucket_name
  admin_email         = var.gcp_account_name
  admin_secret_id     = module.security.admin_secret_id
  agent_key_secret_id = module.security.agent_key_secret_id

  depends_on = [
    module.iam,
    module.gcs,
    module.security
  ]
}
