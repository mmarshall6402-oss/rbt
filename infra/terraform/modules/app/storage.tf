# Signed monthly forms. Object Lock keeps each version for 7 years (BACB retention), even from us.
resource "aws_s3_bucket" "records" {
  #checkov:skip=CKV_AWS_144:cross-region replication is a disaster-recovery follow-up (doubles storage cost)
  #checkov:skip=CKV2_AWS_62:no consumers for object events yet
  bucket_prefix       = "${local.prefix}-records-"
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "records" {
  bucket = aws_s3_bucket.records.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "records" {
  bucket     = aws_s3_bucket.records.id
  depends_on = [aws_s3_bucket_versioning.records]
  rule {
    default_retention {
      mode = local.prod ? "COMPLIANCE" : "GOVERNANCE"
      days = var.pdf_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "records" {
  bucket = aws_s3_bucket.records.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "records" {
  bucket                  = aws_s3_bucket.records.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "records" {
  bucket = aws_s3_bucket.records.id
  rule {
    id     = "archive"
    status = "Enabled"
    filter {}
    transition {
      days          = 365
      storage_class = "GLACIER_IR"
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Every read and write of a signed record is logged (HIPAA access audit).
resource "aws_s3_bucket_logging" "records" {
  bucket        = aws_s3_bucket.records.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-records/"
}

# ---- Access logs (ALB + records bucket). ALB log delivery requires SSE-S3, not KMS. ----
data "aws_elb_service_account" "main" {}

resource "aws_s3_bucket" "logs" {
  #checkov:skip=CKV_AWS_145:ALB access log delivery only supports SSE-S3
  #checkov:skip=CKV_AWS_18:this is the log destination bucket
  #checkov:skip=CKV_AWS_144:logs are not replicated cross-region
  #checkov:skip=CKV2_AWS_62:no consumers for log-object events
  bucket_prefix = "${local.prefix}-logs-"
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 400
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "AlbLogs", Effect = "Allow", Principal = { AWS = data.aws_elb_service_account.main.arn }, Action = "s3:PutObject", Resource = "${aws_s3_bucket.logs.arn}/alb/*" },
      {
        Sid       = "S3AccessLogs", Effect = "Allow", Principal = { Service = "logging.s3.amazonaws.com" }, Action = "s3:PutObject", Resource = "${aws_s3_bucket.logs.arn}/s3-records/*"
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
      {
        Sid       = "TLSOnly", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

resource "aws_s3_bucket_policy" "records" {
  bucket = aws_s3_bucket.records.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TLSOnly", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.records.arn, "${aws_s3_bucket.records.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Sentry DSN: set the value in Secrets Manager by hand; empty means error tracking stays off.
resource "aws_secretsmanager_secret" "sentry_dsn" {
  #checkov:skip=CKV2_AWS_57:a Sentry DSN is a public ingest key, not a rotatable credential
  name       = "${local.prefix}/sentry-dsn"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "sentry_dsn" {
  secret_id     = aws_secretsmanager_secret.sentry_dsn.id
  secret_string = " "
  lifecycle {
    ignore_changes = [secret_string]
  }
}
