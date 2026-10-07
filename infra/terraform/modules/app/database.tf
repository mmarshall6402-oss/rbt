resource "aws_db_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = local.prefix
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1" # reject unencrypted connections
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.prefix}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "main" {
  #checkov:skip=CKV_AWS_157:Multi-AZ is set per environment (on in prod) via var.db_multi_az
  identifier     = local.prefix
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class
  db_name        = "fieldtrack"
  username       = "fieldtrack_admin"

  # Password generated and rotated by RDS in Secrets Manager; never in Terraform state or env files.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.main.arn
  # The API signs in as fieldtrack_api with short-lived IAM tokens (db/migrations/007); only migrations use the owner.
  iam_database_authentication_enabled = true

  allocated_storage     = 20
  max_allocated_storage = 200
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.main.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  # Point-in-time recovery: continuous backups let us restore to any second in the window
  # (e.g. 2:13 PM, one minute before a bad migration at 2:14 PM).
  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "07:00-07:30"
  maintenance_window       = "sun:08:00-sun:09:00"
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.prefix}-final"

  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.main.arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  apply_immediately                     = false
}
