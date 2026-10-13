terraform {
  # terraform init -backend-config=backend.hcl   (see backend.hcl.example)
  backend "s3" {}
}

variable "region" {
  type    = string
  default = "us-east-1"
}
variable "domain" { type = string }
variable "hosted_zone_id" { type = string }
variable "alarm_email" { type = string }

provider "aws" {
  region = var.region
  default_tags {
    tags = { app = "fieldtrack", env = "prod", managed_by = "terraform" }
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { app = "fieldtrack", env = "prod", managed_by = "terraform" }
  }
}

module "app" {
  source    = "../../modules/app"
  providers = { aws = aws, aws.us_east_1 = aws.us_east_1 }

  env                         = "prod"
  domain                      = var.domain
  hosted_zone_id              = var.hosted_zone_id
  alarm_email                 = var.alarm_email
  github_repo                 = "mmarshall6402-oss/rbt"
  create_github_oidc_provider = true
  vpc_cidr                    = "10.20.0.0/16"
  db_instance_class           = "db.t4g.small"
  db_multi_az                 = true
  db_backup_retention_days    = 35
  api_min_count               = 2
  monthly_budget_usd          = 150
}

output "app" { value = module.app }
