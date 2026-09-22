# Click-to-Deploy — LLM Compare (Demo #2165)

<p align="center">
  <a href="https://ssh.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2FUbhiTS%2Fllm-compare.git&cloudshell_tutorial=DEPLOYMENT.md">
    <img src="https://gstatic.com/cloudssh/images/open-btn.svg" alt="Open in Google Cloud Shell" height="36">
  </a>
  &nbsp;&nbsp;
  <a href="https://youtu.be/mrylqpgjiVI">
    <img src="https://img.shields.io/badge/%E2%96%B6_Watch_Demo_Walkthrough-YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch Demo Walkthrough" height="36">
  </a>
</p>

This directory contains **both** the official **go/demos (Cloud Demo Platform) Terraform Click-to-Deploy** configuration and a **1-command interactive quickstart script** so any Googler or customer can deploy **LLM Compare** into their Argolis (`*.altostrat.com`) or Google Cloud environment in ~90 seconds.

---

## Option 1: 1-Command Deploy in Cloud Shell / Terminal (Fastest for Argolis & GCP)

Run this single command in **Google Cloud Shell** or on your local laptop (logged into `gcloud` as your Argolis `admin@<ldap>.altostrat.com` or GCP project owner):

```bash
curl -sSL https://raw.githubusercontent.com/UbhiTS/llm-compare/main/click-to-deploy/quickstart-deploy.sh | bash
```

### What it does automatically:
1. **Enables required APIs**: Cloud Run, Vertex AI (`aiplatform`), Artifact Registry, Cloud Build, Cloud Storage, and Secret Manager.
2. **Argolis Org Policy Override**: Automatically relaxes `constraints/iam.allowedPolicyMemberDomains` on your project so Cloud Run public HTTPS ingress works out-of-the-box.
3. **Runtime Identity & Storage**: Creates the `llm-compare-run` Service Account (`roles/aiplatform.user` + `roles/secretmanager.secretAccessor` + `roles/storage.objectAdmin`) and durable GCS bucket (`<project>-appdata`) mounted at `/data`.
4. **Instant Break-Glass Admin Login**: Generates a strong 16-character `admin` password in Secret Manager (`ADMIN_BOOTSTRAP_PASSWORD`) and prints it in your terminal along with the live `https://llm-compare-*.run.app` URL so you can sign in immediately—even before configuring Google OAuth SSO.

---

## Option 2: Automated `go/demos` Click-to-Deploy (Terraform)

When launched from **[go/demos (`https://demospace.corp.goog/demos/2165`)](https://demospace.corp.goog/demos/2165)**, the Cloud Demo Platform executes the hermetic single-project Terraform pipeline in this directory:

```text
click-to-deploy/
├── README.md                              # Deployment guide (this file)
├── quickstart-deploy.sh                   # 1-command interactive deploy script
├── tools.md                               # CDP runtime & tool dependency manifest
├── org_policy/
│   ├── project_config.json                # Enables Cloud Run, Vertex AI, Secret Manager + iam.allowedPolicyMemberDomains
│   └── project_resource.tf                # IMMUTABLE: CDP Org Policy & API enforcement
└── demo/
    └── terraform/
        ├── base_variables.tf              # IMMUTABLE: 8 standard CDP input variables
        ├── versions.tf                    # Provider version constraints (google >= 6.0, random, null)
        ├── main.tf                        # Root module orchestrator
        ├── outputs.tf                     # Outputs live Cloud Run URL & break-glass admin credentials
        └── terraform-modules/
            ├── iam/                       # Runtime SA (Vertex AI User + Secret Accessor)
            ├── gcs/                       # Durable GCS bucket (<project_id>-appdata)
            ├── security/                  # Secret Manager + auto-generated ADMIN_BOOTSTRAP_PASSWORD
            └── serverless/                # Artifact Registry + Cloud Build + Cloud Run v2 service
```

### Running the Terraform Manually

```bash
cd click-to-deploy/demo/terraform
terraform init
terraform apply \
  -var="project_id=$(gcloud config get-value project)" \
  -var="project_name=$(gcloud config get-value project)" \
  -var="project_number=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')" \
  -var="gcp_account_name=$(gcloud config get-value account)" \
  -var="deployment_service_account_name=manual" \
  -var="org_id=0" \
  -var="data_location=gs://none" \
  -var="secret_stored_project=$(gcloud config get-value project)"
```

Retrieve your live URL and generated admin password after `terraform apply`:

```bash
terraform output llm_compare_url
terraform output -raw admin_bootstrap_password ; echo
```
