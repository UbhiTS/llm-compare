# Deploying LLM Compare to Google Cloud Run

This app ships as a **container** and deploys to **Cloud Run** via a **GitHub Actions**
pipeline that authenticates to Google Cloud **keylessly** (Workload Identity Federation —
no JSON keys). Org users sign in with **Google (OIDC)**, restricted to your Workspace
domain, and each user is capped at a configurable number of comparison runs per day.

```
GitHub push ─▶ GitHub Actions ──(WIF, keyless)──▶ build image ─▶ Artifact Registry
                                                              └─▶ deploy ─▶ Cloud Run
Cloud Run service (1 warm instance)
  • Google sign-in (domain-restricted)         • Vertex/Claude via the runtime service
  • per-user 20/day run limit (configurable)     account (ADC) — no gcloud, no reauth
  • secrets from Secret Manager
```

Everything is parameterized — nothing project-specific is hard-coded in the image.

> ### One-command provisioning
> **`scripts/gcp-setup.sh`** provisions everything below in one idempotent command
> (safe to re-run): the project (default **`llm-compare`**) + billing link, APIs
> (run, artifactregistry, storage, iam, sts, secretmanager, aiplatform), Artifact
> Registry (`containers`), a **GCS bucket for durable run history**, the runtime SA
> (`${SERVICE}-run@…` — Vertex AI User + Secret accessor + bucket object admin) and
> deployer SA (`${SERVICE}-deployer@…` — Artifact Registry writer + Run admin + act-as),
> Workload Identity Federation, and the four Secret Manager secrets
> (`AGENT_PLATFORM_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_SECRET`,
> `ADMIN_BOOTSTRAP_PASSWORD`). Fill in
> `GITHUB_OWNER`/`GITHUB_REPO` and your billing/org IDs at the top, run it, then do the
> OAuth client (Step 6). The steps below are the manual equivalent / reference.

---

## Prerequisites

- A Google Cloud **project** with billing enabled, and the `gcloud` CLI installed & logged in.
- A **GitHub** account and the `gh` CLI (or use the web UI).
- A **Google Workspace domain** you control (e.g. `example.com`) — this is what org
  sign-in is restricted to. ⚠️ Do **not** use `google.com` as the allowed domain unless you
  really intend to let every Google employee in.

## Step 0 — pick your parameters (used by the commands below)

```bash
export PROJECT_ID="llm-compare"                # globally unique — add a suffix if taken
export REGION="us-central1"                    # any Cloud Run region
export SERVICE="llm-compare"                    # Cloud Run service name
export AR_REPO="containers"                     # Artifact Registry repo name
export DATA_BUCKET="${PROJECT_ID}-appdata"     # GCS bucket for durable run history
export GITHUB_OWNER="your-github-user-or-org"
export GITHUB_REPO="llm-compare"
export ALLOWED_DOMAINS="example.com"          # comma-separated Workspace domain(s)
export ADMIN_EMAILS="you@example.com"         # comma-separated emails granted admin
export MAX_RUNS="20"                            # per-user comparisons per day
```

## Step 1 — put the code on GitHub

```bash
cd llm-compare
git init && git add -A && git commit -m "LLM Compare"
gh repo create "$GITHUB_OWNER/$GITHUB_REPO" --private --source=. --push
```

`.gitignore` already excludes `.env` and `.auth/`, so no secrets or local users are pushed.

## Step 2 — enable the Google Cloud APIs

```bash
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com storage.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com \
  secretmanager.googleapis.com aiplatform.googleapis.com \
  --project "$PROJECT_ID"
```

## Step 3 — Artifact Registry (stores the container image)

```bash
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker --location="$REGION" \
  --description="App containers" --project "$PROJECT_ID"
```

## Step 4 — runtime service account (the app's identity on Cloud Run)

This SA gives the app access to **Vertex AI (Claude)** via ADC — the durable fix for the
`gcloud auth login` reauth problem — and to read secrets.

```bash
gcloud iam service-accounts create "${SERVICE}-run" \
  --display-name="LLM Compare runtime" --project "$PROJECT_ID"
export RUNTIME_SA="${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role="roles/aiplatform.user"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role="roles/secretmanager.secretAccessor"
```

> The GCP project must have the Anthropic Claude models enabled in Vertex Model Garden.

## Step 4b — durable data bucket (per-user run history)

Run history is written to a **GCS bucket** mounted into the container at `/data`, so it
survives Cloud Run restarts (the filesystem is otherwise ephemeral). Create the bucket and
let the runtime SA read/write it:

```bash
export DATA_BUCKET="${PROJECT_ID}-appdata"
gcloud storage buckets create "gs://$DATA_BUCKET" \
  --project "$PROJECT_ID" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://$DATA_BUCKET" \
  --member="serviceAccount:$RUNTIME_SA" --role="roles/storage.objectAdmin"
```

## Step 5 — secrets in Secret Manager

The Gemini/Agent-Platform key, OpenAI key, OAuth client secret, and a **break-glass admin
password** live in Secret Manager. The OpenAI key is loaded by the app's shared-key manager;
the other three are injected at deploy time.

```bash
printf '%s' "YOUR_AGENT_PLATFORM_API_KEY" | \
  gcloud secrets create AGENT_PLATFORM_API_KEY --data-file=- --project "$PROJECT_ID"
printf '%s' "YOUR_OPENAI_API_KEY" | \
  gcloud secrets create OPENAI_API_KEY --data-file=- --project "$PROJECT_ID"
printf '%s' "YOUR_GOOGLE_OAUTH_CLIENT_SECRET" | \
  gcloud secrets create GOOGLE_CLIENT_SECRET --data-file=- --project "$PROJECT_ID"
printf '%s' "A-STRONG-BREAKGLASS-ADMIN-PASSWORD" | \
  gcloud secrets create ADMIN_BOOTSTRAP_PASSWORD --data-file=- --project "$PROJECT_ID"
```

(You'll get the OAuth client secret in Step 6. Re-run with `gcloud secrets versions add`
to update a value later.) **`ADMIN_BOOTSTRAP_PASSWORD`** re-creates a durable
`admin` / username+password login on every startup — your way in if Google sign-in is ever
down or your account is locked out. It survives the ephemeral filesystem; keep it strong.

## Step 6 — "Sign in with Google" OAuth client

OAuth clients are created in the console (**Google Auth Platform**):

1. **Google Auth Platform ▸ Branding**:
   - Fill in **App name** (`LLM Compare`), **User support email**, and **Developer contact information**.
   - **Leave App logo BLANK** (uploading a logo triggers manual Google Brand Verification; leaving it empty allows instant publishing to **In production** with zero review because only `openid email profile` scopes are used).
   - Under **App domain**, set:
     - Home page: `https://YOUR-APP-URL/login`
     - Privacy policy: `https://YOUR-APP-URL/privacy` (served automatically by `server.js`)
     - Terms of service: `https://YOUR-APP-URL/terms` (served automatically by `server.js`)
   - Under **Authorized domains**, add your top-level registrable domain(s) (e.g. `ubhims.com` and `run.app`).
2. **Google Auth Platform ▸ Audience**:
   - If using **Internal**, only accounts in the same GCP Workspace organization can sign in.
   - If hosting in **Argolis** (`*.altostrat.com`) while allowing `@google.com` Googlers to sign in without a 100-user test list, set User Type to **External** and click **Publish App** (`In production`). The server strictly enforces `ALLOWED_EMAIL_DOMAINS` (`claims.hd === email_domain`) in [`src/googleAuth.js`](src/googleAuth.js).
3. **Google Auth Platform ▸ Clients ▸ Create client** → Application type **Web application**:
   - Under **Authorized redirect URIs**, add your callback URL(s) (multiple origins are supported simultaneously because `redirectUri(req)` resolves the incoming `Host` dynamically):
     - `https://YOUR-CUSTOM-DOMAIN/auth/google/callback`
     - `https://YOUR-CLOUD-RUN-URL.run.app/auth/google/callback`
4. Copy the **Client ID** and **Client secret**. Put the secret in Secret Manager (Step 5), and keep the Client ID for Step 8.

## Step 7 — deployer service account + Workload Identity Federation (keyless CI)

Lets GitHub Actions authenticate to GCP with **no stored keys**.

```bash
# Deployer SA (impersonated by GitHub Actions)
gcloud iam service-accounts create "${SERVICE}-deployer" \
  --display-name="LLM Compare GitHub deployer" --project "$PROJECT_ID"
export DEPLOY_SA="${SERVICE}-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

# What the deployer may do: push images, deploy Cloud Run, act as the runtime SA
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOY_SA" --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOY_SA" --role="roles/run.admin"
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role="roles/iam.serviceAccountUser" --project "$PROJECT_ID"

# Workload Identity pool + GitHub OIDC provider (restricted to your GitHub org)
gcloud iam workload-identity-pools create github-pool \
  --location=global --project "$PROJECT_ID" --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global --workload-identity-pool=github-pool --project "$PROJECT_ID" \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner == '${GITHUB_OWNER}'"

# Let ONLY this repo impersonate the deployer SA
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --project "$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_OWNER}/${GITHUB_REPO}"

# The value to store as the WIF_PROVIDER GitHub secret:
echo "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
```

## Step 8 — set GitHub repository Variables & Secrets

```bash
# Variables (non-secret)
gh variable set GCP_PROJECT_ID          -b "$PROJECT_ID"           -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set GCP_REGION              -b "$REGION"               -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set ARTIFACT_REPO           -b "$AR_REPO"              -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set CLOUD_RUN_SERVICE       -b "$SERVICE"              -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set RUNTIME_SERVICE_ACCOUNT -b "$RUNTIME_SA"           -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set ALLOWED_EMAIL_DOMAINS   -b "$ALLOWED_DOMAINS"      -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set ADMIN_EMAILS            -b "$ADMIN_EMAILS"         -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set MAX_RUNS_PER_DAY        -b "$MAX_RUNS"             -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set APP_DATA_BUCKET         -b "$DATA_BUCKET"          -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set GOOGLE_CLIENT_ID        -b "YOUR_OAUTH_CLIENT_ID"  -R "$GITHUB_OWNER/$GITHUB_REPO"
gh variable set OAUTH_REDIRECT_BASE     -b "https://YOUR-APP-URL"  -R "$GITHUB_OWNER/$GITHUB_REPO"

# Secrets
gh secret set WIF_PROVIDER          -b "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider" -R "$GITHUB_OWNER/$GITHUB_REPO"
gh secret set DEPLOY_SERVICE_ACCOUNT -b "$DEPLOY_SA" -R "$GITHUB_OWNER/$GITHUB_REPO"
```

> `OAUTH_REDIRECT_BASE` must match the redirect URI on the OAuth client (Step 6). On the
> first deploy you can leave it as the eventual custom domain, or set it to the Cloud Run URL
> after Step 9 and re-run the workflow.

## Step 9 — deploy

Push to `main` (or run the workflow manually):

```bash
git push origin main
# or: gh workflow run "Deploy to Cloud Run" -R "$GITHUB_OWNER/$GITHUB_REPO"
```

The workflow prints the service URL at the end. If you deployed before finalizing the OAuth
redirect URI, add `https://<that-url>/auth/google/callback` to the OAuth client (Step 6),
set `OAUTH_REDIRECT_BASE` to `https://<that-url>` (Step 8), and re-run the workflow.

### Optional — custom domain

Map a domain (e.g. `your-app.example.com`) to the service, then use it for both
`OAUTH_REDIRECT_BASE` and the OAuth redirect URI:

```bash
gcloud beta run domain-mappings create --service "$SERVICE" \
  --domain your-app.example.com --region "$REGION" --project "$PROJECT_ID"
```

---

## Local development

Run the container locally (no Google sign-in needed — falls back to the username/password
admin, and Claude uses your `gcloud` login):

```bash
docker build -t llm-compare .
docker run --rm -p 8080:8080 \
  -e AGENT_PLATFORM_API_KEY="..." \
  -e OPENAI_API_KEY="..." \
  -e GCP_PROJECT_ID="$PROJECT_ID" \
  llm-compare
# open http://localhost:8080  (first visit prints a setup code in the container logs)
```

Or without Docker: `npm start` (see `README.md` / `.env.example`).

---

## Parameter reference

| Where | Name | Purpose |
|---|---|---|
| GH var | `GCP_PROJECT_ID`, `GCP_REGION`, `ARTIFACT_REPO`, `CLOUD_RUN_SERVICE` | deploy target |
| GH var | `RUNTIME_SERVICE_ACCOUNT` | the app's Cloud Run identity (Vertex + secrets) |
| GH var | `ALLOWED_EMAIL_DOMAINS` | org domain(s) allowed to sign in |
| GH var | `ADMIN_EMAILS` | emails granted the admin role (exempt from the daily limit) |
| GH var | `MAX_RUNS_PER_DAY` | per-user comparison-run cap (0 = unlimited) |
| GH var | `APP_DATA_BUCKET` | GCS bucket mounted at `/data` for durable run history |
| GH var | `GOOGLE_CLIENT_ID`, `OAUTH_REDIRECT_BASE` | Google sign-in config |
| GH secret | `WIF_PROVIDER`, `DEPLOY_SERVICE_ACCOUNT` | keyless CI auth |
| Secret Mgr | `AGENT_PLATFORM_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_SECRET`, `ADMIN_BOOTSTRAP_PASSWORD` | runtime secrets (provider keys, OAuth secret, break-glass admin) |

All are also documented in `.env.example` for non-container runs.

## Notes & caveats

- **Single warm instance** (`--min/--max-instances=1`) keeps sessions and the per-user daily
  counter consistent (they live in memory). Scaling wider would need shared storage
  (Firestore/Redis) for sessions + counters — fine to add later; unnecessary for a demo.
- **User accounts persist**: the container's own filesystem is ephemeral, so `AUTH_DATA_DIR`
  is pointed at `/data/auth` on the mounted GCS bucket (same volume as run history).
  Username/password accounts therefore survive restarts and deploys. If you ever unset that
  variable it falls back to the image's `/tmp/auth`, where accounts are wiped on every
  restart. Sessions are still in memory, so everyone is logged out by a redeploy.
- **`/api/execute`** runs LLM-generated Python inside the container; it's isolated per
  instance and ephemeral, but it is still executing model output. Set `ENABLE_CODE_EXEC=0`
  to disable if you don't want it.
- **Cost**: one small always-on instance is a few dollars/month; Vertex/Gemini usage is
  billed per token as normal.
