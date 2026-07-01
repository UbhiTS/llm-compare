#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-shot provisioning for LLM Compare on Google Cloud.
# Idempotent — safe to re-run. Creates: the project + billing link, APIs,
# Artifact Registry, a GCS bucket for durable run history, the runtime + deployer
# service accounts and their IAM, Workload Identity Federation (keyless
# GitHub → GCP), and the Secret Manager secrets. Then prints the GitHub
# variables/secrets to set.
#
# Fill in the two GitHub values, then run:  bash scripts/gcp-setup.sh
# (Requires: gcloud logged in with project-create + billing rights; and, for the
#  last section, the gh CLI logged in.)
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- parameters (override by exporting before running) --------------------
PROJECT_ID="${PROJECT_ID:-llm-compare}"      # globally unique — add a suffix if taken (e.g. llm-compare-acme)
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-llm-compare}"
AR_REPO="${AR_REPO:-containers}"
DATA_BUCKET="${DATA_BUCKET:-${PROJECT_ID}-appdata}"   # GCS bucket for durable per-user run history
BILLING_ACCOUNT="${BILLING_ACCOUNT:-XXXXXX-XXXXXX-XXXXXX}"    # yours: gcloud billing accounts list
ORG_ID="${ORG_ID:-YOUR_ORG_ID}"                              # yours: gcloud organizations list

# You MUST set these (your GitHub repo that holds this code):
GITHUB_OWNER="${GITHUB_OWNER:-YOUR_GITHUB_USER_OR_ORG}"
GITHUB_REPO="${GITHUB_REPO:-llm-compare}"

# App config (become Cloud Run env / GitHub variables):
ALLOWED_EMAIL_DOMAINS="${ALLOWED_EMAIL_DOMAINS:-your-workspace-domain.com}"   # a domain you control, NOT google.com
ADMIN_EMAILS="${ADMIN_EMAILS:-you@your-workspace-domain.com}"
MAX_RUNS_PER_DAY="${MAX_RUNS_PER_DAY:-20}"

RUNTIME_SA="${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="${SERVICE}-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }

if [ "$BILLING_ACCOUNT" = "XXXXXX-XXXXXX-XXXXXX" ] || [ "$ORG_ID" = "YOUR_ORG_ID" ]; then
  echo "!! Set BILLING_ACCOUNT and ORG_ID at the top of this script first" \
       "(list them with: gcloud billing accounts list / gcloud organizations list)." ; exit 1
fi

say "Project ${PROJECT_ID}"
exists gcloud projects describe "$PROJECT_ID" \
  || gcloud projects create "$PROJECT_ID" --organization="$ORG_ID" --name="llm-compare"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" >/dev/null

say "APIs"
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com storage.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com \
  secretmanager.googleapis.com aiplatform.googleapis.com --project "$PROJECT_ID"

say "Artifact Registry"
exists gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project "$PROJECT_ID" \
  || gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" --project "$PROJECT_ID"

say "Runtime service account (Vertex + secrets + data bucket)"
exists gcloud iam service-accounts describe "$RUNTIME_SA" --project "$PROJECT_ID" \
  || gcloud iam service-accounts create "${SERVICE}-run" --display-name="LLM Compare runtime" --project "$PROJECT_ID"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUNTIME_SA" --role="roles/aiplatform.user" --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUNTIME_SA" --role="roles/secretmanager.secretAccessor" --condition=None >/dev/null

say "Durable data bucket (per-user run history survives restarts)"
exists gcloud storage buckets describe "gs://${DATA_BUCKET}" \
  || gcloud storage buckets create "gs://${DATA_BUCKET}" --project "$PROJECT_ID" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://${DATA_BUCKET}" \
  --member="serviceAccount:$RUNTIME_SA" --role="roles/storage.objectAdmin" >/dev/null

say "Deployer service account (used by GitHub Actions)"
exists gcloud iam service-accounts describe "$DEPLOY_SA" --project "$PROJECT_ID" \
  || gcloud iam service-accounts create "${SERVICE}-deployer" --display-name="LLM Compare GitHub deployer" --project "$PROJECT_ID"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role="roles/artifactregistry.writer" --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role="roles/run.admin" --condition=None >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$DEPLOY_SA" --role="roles/iam.serviceAccountUser" --project "$PROJECT_ID" >/dev/null

say "Workload Identity Federation (keyless GitHub -> GCP)"
if [ "$GITHUB_OWNER" = "YOUR_GITHUB_USER_OR_ORG" ]; then
  echo "!! Set GITHUB_OWNER (and GITHUB_REPO) then re-run to finish WIF + GitHub config." ; exit 1
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
exists gcloud iam workload-identity-pools describe github-pool --location=global --project "$PROJECT_ID" \
  || gcloud iam workload-identity-pools create github-pool --location=global --project "$PROJECT_ID" --display-name="GitHub Actions"
exists gcloud iam workload-identity-pools providers describe github-provider --location=global --workload-identity-pool=github-pool --project "$PROJECT_ID" \
  || gcloud iam workload-identity-pools providers create-oidc github-provider \
       --location=global --workload-identity-pool=github-pool --project "$PROJECT_ID" \
       --display-name="GitHub OIDC" --issuer-uri="https://token.actions.githubusercontent.com" \
       --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
       --attribute-condition="assertion.repository_owner == '${GITHUB_OWNER}'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --project "$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_OWNER}/${GITHUB_REPO}" >/dev/null
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"

say "Secret Manager (values NOT stored in this script)"
ensure_secret() {
  local name="$1"; local prompt="$2"
  if ! exists gcloud secrets describe "$name" --project "$PROJECT_ID"; then
    read -r -s -p "$prompt: " val; echo
    printf '%s' "$val" | gcloud secrets create "$name" --data-file=- --project "$PROJECT_ID"
  else
    echo "  $name already exists (use 'gcloud secrets versions add' to rotate)."
  fi
}
ensure_secret AGENT_PLATFORM_API_KEY   "Enter your Agent Platform / Gemini API key"
ensure_secret GOOGLE_CLIENT_SECRET     "Enter your Google OAuth client secret"
ensure_secret ADMIN_BOOTSTRAP_PASSWORD "Enter a break-glass admin password (>= 10 chars)"

say "Set these GitHub repo Variables & Secrets (requires 'gh auth login')"
cat <<EOF
gh variable set GCP_PROJECT_ID          -b "${PROJECT_ID}"          -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set GCP_REGION              -b "${REGION}"              -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set ARTIFACT_REPO           -b "${AR_REPO}"             -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set CLOUD_RUN_SERVICE       -b "${SERVICE}"             -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set RUNTIME_SERVICE_ACCOUNT -b "${RUNTIME_SA}"          -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set ALLOWED_EMAIL_DOMAINS   -b "${ALLOWED_EMAIL_DOMAINS}" -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set ADMIN_EMAILS            -b "${ADMIN_EMAILS}"        -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set MAX_RUNS_PER_DAY        -b "${MAX_RUNS_PER_DAY}"    -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set APP_DATA_BUCKET         -b "${DATA_BUCKET}"         -R "${GITHUB_OWNER}/${GITHUB_REPO}"
# >> EDIT the next two first: GOOGLE_CLIENT_ID from your OAuth client (Step 6); OAUTH_REDIRECT_BASE = your deployed URL.
gh variable set GOOGLE_CLIENT_ID        -b "YOUR_OAUTH_CLIENT_ID"   -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh variable set OAUTH_REDIRECT_BASE     -b "https://YOUR-APP-URL"   -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh secret   set WIF_PROVIDER            -b "${WIF_PROVIDER}"        -R "${GITHUB_OWNER}/${GITHUB_REPO}"
gh secret   set DEPLOY_SERVICE_ACCOUNT  -b "${DEPLOY_SA}"           -R "${GITHUB_OWNER}/${GITHUB_REPO}"
EOF

say "Done. Next: create the OAuth client (DEPLOYMENT.md Step 6), set the two GOOGLE_* GitHub values above, then 'git push origin main' to deploy."
