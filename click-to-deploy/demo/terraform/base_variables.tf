########################################################################
# MANDATORY: Variables which are required in each Click-To-Deploy Demos#
# Their values are being passed from the build cloudbuild.yaml file     #
# during terraform apply.                                              #
########################################################################

variable "project_id" {
  type        = string
  description = "The unique, user-assigned ID of the Google Cloud project where the demo resources will be deployed."
}

variable "project_name" {
  type        = string
  description = "The display name of the Google Cloud project hosting the demo deployment."
}

variable "project_number" {
  type        = string
  description = "The unique, numerical identifier of the Google Cloud project where the demo is deployed."
}

variable "gcp_account_name" {
  type        = string
  description = "The Admin Identity/user principal where the demo is being deployed into. (e.g., admin@<ldap>.altostrat.com). Use this when configuring user-specific IAM permissions or resource ownership."
}

variable "deployment_service_account_name" {
  type        = string
  description = "The backend Click-to-Deploy Service Account identity managed by Cloud Build that possesses the required IAM permissions to provision and manage the Terraform resources."
}

variable "org_id" {
  type        = string
  description = "The Google Cloud Organization ID under which the demo project has been created."
}

variable "data_location" {
  type        = string
  description = "The URI/path of the Click-to-Deploy central bucket containing mandatory demo artifacts, source data, or configuration files requested for the deployment pipeline."
}

variable "secret_stored_project" {
  type        = string
  description = "The specific Google Cloud project ID where centralized secrets (like API keys or service credentials) are hosted and accessed from via Secret Manager."
}
