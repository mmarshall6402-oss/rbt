locals {
  prefix = "${var.name}-${var.env}"
  azs    = slice(data.aws_availability_zones.available.names, 0, 2)
  prod   = var.env == "prod"
}

data "aws_availability_zones" "available" {
  #checkov:skip=CKV_AWS_394:only the first two zones are used (slice), so new zones never change placement
  state = "available"
}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

resource "aws_kms_key" "main" {
  description             = "${local.prefix}: database, logs, secrets, records"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Root", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
      {
        Sid       = "CloudWatchLogs", Effect = "Allow", Principal = { Service = "logs.${data.aws_region.current.region}.amazonaws.com" },
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"], Resource = "*"
        Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:*" } }
      },
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.main.key_id
}
