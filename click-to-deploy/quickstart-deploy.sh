#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# LLM Compare — 1-Command Quickstart Deploy for Argolis & Google Cloud
#
# Deploys the complete LLM Compare application into your active Google Cloud
# or Argolis project in ~90 seconds:
#   1. Enables required APIs (Cloud Run, Vertex AI, Cloud Build, Storage, Secret Manager)
#   2. Relaxes iam.allowedPolicyMemberDomains on the project (for Argolis public Cloud Run)
#   3. Creates the runtime Service Account (Vertex AI User + Secret Accessor + Storage Admin)
#   4. Creates the durable GCS bucket (<project>-appdata) for per-user run history
#   5. Generates a break-glass admin password in Secret Manager
#   6. Builds & deploys the Cloud Run service from source and prints your live URL + login
#
# Usage:
#   bash click-to-deploy/quickstart-deploy.sh
#   # or with custom project/region:
#   PROJECT_ID=my-argolis-project REGION=us-central1 bash click-to-deploy/quickstart-deploy.sh
# ---------------------------------------------------------------------------
set -euo pipefail

bold() { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  read -r -p "Enter target GCP / Argolis Project ID: " PROJECT_ID
fi
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-llm-compare}"
ACCOUNT_EMAIL="$(gcloud config get-value account 2>/dev/null || echo 'admin@example.com')"
EMAIL_DOMAIN="${ACCOUNT_EMAIL#*@}"
DATA_BUCKET="${PROJECT_ID}-appdata"
RUNTIME_SA="${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com"

bold "== Deploying LLM Compare to project '${PROJECT_ID}' (${REGION}) as ${ACCOUNT_EMAIL} =="

bold "1/6 Enabling Google Cloud APIs..."
gcloud services enable \
  orgpolicy.googleapis.com serviceusage.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com \
  compute.googleapis.com logging.googleapis.com \
  --project "$PROJECT_ID" --quiet
ok "APIs enabled"

bold "2/6 Checking Argolis Organization Policy (iam.allowedPolicyMemberDomains)..."
if gcloud org-policies set-policy /dev/stdin --project="$PROJECT_ID" >/dev/null 2>&1 <<EOF
name: projects/${PROJECT_ID}/policies/iam.allowedPolicyMemberDomains
spec:
  rules:
  - allowAll: true
EOF
then
  ok "Updated iam.allowedPolicyMemberDomains on project ${PROJECT_ID} to allow Cloud Run public ingress"
else
  warn "Skipped org-policy override (no orgpolicy.policyAdmin role or already permitted)"
fi

bold "3/6 Provisioning runtime & Cloud Build Service Accounts (${RUNTIME_SA})..."
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || true)"
if ! gcloud iam service-accounts describe "$RUNTIME_SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SERVICE}-run" \
    --display-name="LLM Compare Cloud Run Runtime" --project "$PROJECT_ID" --quiet
fi
for ROLE in roles/aiplatform.user roles/secretmanager.secretAccessor roles/storage.admin roles/artifactregistry.writer roles/logging.logWriter roles/cloudbuild.builds.builder; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" --role="$ROLE" --condition=None --quiet >/dev/null
  if [ -n "$PROJECT_NUMBER" ]; then
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role="$ROLE" --condition=None --quiet >/dev/null || true
  fi
done
ok "Runtime & Cloud Build Service Accounts ready"

bold "4/6 Provisioning durable GCS bucket (gs://${DATA_BUCKET})..."
if ! gcloud storage buckets describe "gs://${DATA_BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${DATA_BUCKET}" \
    --project "$PROJECT_ID" --location="$REGION" --uniform-bucket-level-access --quiet
fi
gcloud storage buckets add-iam-policy-binding "gs://${DATA_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/storage.objectAdmin" --quiet >/dev/null
ok "GCS bucket gs://${DATA_BUCKET} ready"

bold "5/6 Configuring Secret Manager secrets..."
ADMIN_PASS="${ADMIN_BOOTSTRAP_PASSWORD:-$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16 || openssl rand -hex 8)}"
if ! gcloud secrets describe ADMIN_BOOTSTRAP_PASSWORD --project "$PROJECT_ID" >/dev/null 2>&1; then
  printf '%s' "$ADMIN_PASS" | gcloud secrets create ADMIN_BOOTSTRAP_PASSWORD --data-file=- --project "$PROJECT_ID" --quiet
else
  printf '%s' "$ADMIN_PASS" | gcloud secrets versions add ADMIN_BOOTSTRAP_PASSWORD --data-file=- --project "$PROJECT_ID" --quiet
fi

if ! gcloud secrets describe AGENT_PLATFORM_API_KEY --project "$PROJECT_ID" >/dev/null 2>&1; then
  printf '%s' "${AGENT_PLATFORM_API_KEY:-CONFIGURE_IN_UI_OR_SECRET_MANAGER}" | \
    gcloud secrets create AGENT_PLATFORM_API_KEY --data-file=- --project "$PROJECT_ID" --quiet
fi
ok "Secrets configured in Secret Manager"

bold "6/6 Building & deploying Cloud Run service (${SERVICE})..."
SRC_DIR="$(pwd)"
if [ ! -f "${SRC_DIR}/Dockerfile" ]; then
  if [ -f "${SRC_DIR}/demo/UbhiTS/llm-compare/main/Dockerfile" ]; then
    SRC_DIR="${SRC_DIR}/demo/UbhiTS/llm-compare/main"
  else
    SRC_DIR="$(mktemp -d /tmp/llm-compare-deploy-XXXXXX)"
    git clone --depth 1 https://github.com/UbhiTS/llm-compare.git "$SRC_DIR"
  fi
fi

gcloud run deploy "$SERVICE" \
  --source "$SRC_DIR" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated \
  --min-instances=1 --max-instances=1 \
  --cpu=1 --memory=1Gi --timeout=3600 \
  --set-env-vars="^@@^HOST=0.0.0.0@@PYTHON_CMD=python3@@GCP_PROJECT_ID=${PROJECT_ID}@@COOKIE_SECURE=1@@TRUST_PROXY=1@@CLAUDE_EFFORT=high@@ALLOWED_EMAIL_DOMAINS=google.com,${EMAIL_DOMAIN}@@ADMIN_EMAILS=${ACCOUNT_EMAIL}@@MAX_RUNS_PER_DAY=20@@MAX_SINGLE_RUNS_PER_DAY=20@@APP_DATA_DIR=/data@@AUTH_DATA_DIR=/data/auth" \
  --set-secrets="ADMIN_BOOTSTRAP_PASSWORD=ADMIN_BOOTSTRAP_PASSWORD:latest,AGENT_PLATFORM_API_KEY=AGENT_PLATFORM_API_KEY:latest" \
  --add-volume="name=appdata,type=cloud-storage,bucket=${DATA_BUCKET}" \
  --add-volume-mount="volume=appdata,mount-path=/data" \
  --quiet

SERVICE_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"

printf '\n====================================================================\n'
ok "LLM Compare deployed successfully!"
printf '  🌐 Live URL       : %s\n' "$SERVICE_URL"
printf '  👤 Admin Username : admin\n'
printf '  🔑 Admin Password : %s\n' "$ADMIN_PASS"
printf '====================================================================\n'
printf 'Tip: Sign in with admin / %s, then add your Gemini / OpenAI keys\n' "$ADMIN_PASS"
printf 'in the top-right Settings (🔑) drawer or enable Google SSO via DEPLOYMENT.md.\n'
