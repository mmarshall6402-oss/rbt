variable "name" {
  type    = string
  default = "fieldtrack"
}
variable "env" {
  type        = string
  description = "staging or prod"
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}
variable "domain" {
  type        = string
  description = "Public hostname for the app, e.g. app.example.com"
}
variable "hosted_zone_id" {
  type        = string
  description = "Route 53 hosted zone that contains var.domain"
}
variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}
variable "db_multi_az" {
  type    = bool
  default = false
}
variable "db_backup_retention_days" {
  type        = number
  default     = 14
  description = "Point-in-time recovery window: restore to any second within this many days"
  validation {
    condition     = var.db_backup_retention_days >= 7
    error_message = "Keep at least 7 days of point-in-time recovery."
  }
}
variable "api_cpu" {
  type    = number
  default = 256
}
variable "api_memory" {
  type    = number
  default = 512
}
variable "api_min_count" {
  type    = number
  default = 1
}
variable "api_max_count" {
  type    = number
  default = 4
}
variable "alarm_email" {
  type        = string
  description = "Gets alarms and budget alerts"
}
variable "monthly_budget_usd" {
  type    = number
  default = 100
}
variable "github_repo" {
  type        = string
  description = "owner/repo allowed to deploy via OIDC"
}
variable "create_github_oidc_provider" {
  type        = bool
  default     = false
  description = "The GitHub OIDC provider is one per AWS account: create it in exactly one environment"
}
variable "pdf_retention_days" {
  type        = number
  default     = 2557
  description = "Object-lock retention for signed forms (BACB: keep 7 years)"
}

variable "mfa_required" {
  description = "Require an authenticator-app second factor for every sign-in (production: true)"
  type        = bool
  default     = true
}
