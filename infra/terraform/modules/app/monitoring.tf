resource "aws_sns_topic" "alarms" {
  name              = "${local.prefix}-alarms"
  kms_master_key_id = aws_kms_key.main.id
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarms = {
    api-5xx = {
      namespace = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 5, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.api.arn_suffix }, desc = "API returned 5xx errors"
    }
    api-unhealthy = {
      namespace = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", threshold = 0, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.api.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }, desc = "An API task is failing health checks"
    }
    api-latency = {
      namespace = "AWS/ApplicationELB", metric = "TargetResponseTime", stat = "p95", threshold = 2, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.api.arn_suffix }, desc = "API p95 latency above 2s"
    }
    db-cpu = {
      namespace = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80, op = "GreaterThanThreshold"
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database CPU above 80%"
    }
    db-storage = {
      namespace = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", threshold = 2147483648, op = "LessThanThreshold"
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database has under 2 GB free"
    }
    db-connections = {
      namespace = "AWS/RDS", metric = "DatabaseConnections", stat = "Maximum", threshold = 60, op = "GreaterThanThreshold"
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database connections near the limit"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "main" {
  for_each            = local.alarms
  alarm_name          = "${local.prefix}-${each.key}"
  alarm_description   = each.value.desc
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dims
  statistic           = contains(["p95"], each.value.stat) ? null : each.value.stat
  extended_statistic  = contains(["p95"], each.value.stat) ? each.value.stat : null
  period              = 300
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_budgets_budget" "monthly" {
  name         = "${local.prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:env$%s", var.env)] # activate the "env" cost-allocation tag in Billing
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alarm_email]
  }
}
