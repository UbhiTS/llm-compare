variable "project_id" {
  type        = string
  description = "Target GCP project ID."
}

variable "project_number" {
  type        = string
  default     = ""
  description = "Target GCP project number."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Cloud Run and Artifact Registry region."
}

variable "service_name" {
  type        = string
  default     = "llm-compare"
  description = "Cloud Run service name."
}

variable "runtime_sa_email" {
  type        = string
  description = "Runtime service account email."
}

variable "appdata_bucket" {
  type        = string
  description = "GCS bucket mounted at /data for durable run history."
}

variable "admin_email" {
  type        = string
  default     = "admin@example.com"
  description = "Admin user email (e.g. var.gcp_account_name)."
}

variable "admin_secret_id" {
  type        = string
  description = "Secret Manager secret ID for ADMIN_BOOTSTRAP_PASSWORD."
}

variable "agent_key_secret_id" {
  type        = string
  description = "Secret Manager secret ID for AGENT_PLATFORM_API_KEY."
}

locals {
  image_uri    = "${var.region}-docker.pkg.dev/${var.project_id}/${var.service_name}/${var.service_name}:latest"
  email_domain = length(split("@", var.admin_email)) > 1 ? split("@", var.admin_email)[1] : "google.com"
}

resource "google_artifact_registry_repository" "repo" {
  project       = var.project_id
  location      = var.region
  repository_id = var.service_name
  description   = "Container repository for LLM Compare"
  format        = "DOCKER"
}

resource "null_resource" "build_image" {
  depends_on = [google_artifact_registry_repository.repo]

  triggers = {
    image_uri = local.image_uri
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      SRC_DIR="../../../demo/UbhiTS/llm-compare/main"
      if [ ! -f "$SRC_DIR/Dockerfile" ]; then
        SRC_DIR=$(mktemp -d /tmp/llm-compare-src-XXXXXX)
        git clone --depth 1 https://github.com/UbhiTS/llm-compare.git "$SRC_DIR"
      fi

      # Ensure IAM bindings on default Compute SA and runtime SA have propagated before Cloud Build checks storage.objects.get
      echo "Waiting 15s for GCP IAM policy propagation..."
      sleep 15

      ATTEMPT=1
      MAX_ATTEMPTS=4
      until [ $ATTEMPT -gt $MAX_ATTEMPTS ]; do
        echo "Submitting Cloud Build (attempt $ATTEMPT of $MAX_ATTEMPTS)..."
        if gcloud builds submit "$SRC_DIR" \
          --tag="${local.image_uri}" \
          --project="${var.project_id}" \
          --gcs-source-staging-dir="gs://${var.appdata_bucket}/cloudbuild/source" \
          --gcs-log-dir="gs://${var.appdata_bucket}/cloudbuild/logs" \
          --service-account="projects/${var.project_id}/serviceAccounts/${var.runtime_sa_email}" \
          --quiet; then
          echo "Cloud Build succeeded on attempt $ATTEMPT."
          break
        fi
        if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
          echo "Cloud Build failed after $MAX_ATTEMPTS attempts."
          exit 1
        fi
        echo "Cloud Build encountered transient IAM/storage error; retrying in 20s..."
        sleep 20
        ATTEMPT=$((ATTEMPT + 1))
      done
    EOT
  }
}

resource "google_cloud_run_v2_service" "llm_compare" {
  provider            = google-beta
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = var.runtime_sa_email
    timeout         = "3600s"

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    volumes {
      name = "appdata"
      gcs {
        bucket    = var.appdata_bucket
        read_only = false
      }
    }

    containers {
      image = local.image_uri

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      volume_mounts {
        name       = "appdata"
        mount_path = "/data"
      }

      env {
        name  = "HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "PYTHON_CMD"
        value = "python3"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "COOKIE_SECURE"
        value = "1"
      }
      env {
        name  = "TRUST_PROXY"
        value = "1"
      }
      env {
        name  = "CLAUDE_EFFORT"
        value = "high"
      }
      env {
        name  = "ALLOWED_EMAIL_DOMAINS"
        value = "google.com,${local.email_domain}"
      }
      env {
        name  = "ADMIN_EMAILS"
        value = var.admin_email
      }
      env {
        name  = "MAX_RUNS_PER_DAY"
        value = "20"
      }
      env {
        name  = "MAX_SINGLE_RUNS_PER_DAY"
        value = "20"
      }
      env {
        name  = "APP_DATA_DIR"
        value = "/data"
      }
      env {
        name  = "AUTH_DATA_DIR"
        value = "/data/auth"
      }

      env {
        name = "ADMIN_BOOTSTRAP_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = var.admin_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AGENT_PLATFORM_API_KEY"
        value_source {
          secret_key_ref {
            secret  = var.agent_key_secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [null_resource.build_image]
}

resource "google_cloud_run_v2_service_iam_member" "allow_unauth" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.llm_compare.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "service_url" {
  value = google_cloud_run_v2_service.llm_compare.uri
}
