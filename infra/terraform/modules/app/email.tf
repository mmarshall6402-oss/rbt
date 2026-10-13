# ---- Email: SES domain identity (DKIM-signed) and the daily deadline-reminder job ----
# New SES accounts start in the sandbox; request production access once the domain verifies.
resource "aws_sesv2_email_identity" "main" {
  email_identity = var.domain
}

resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = var.hosted_zone_id
  name    = "${aws_sesv2_email_identity.main.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.main.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

locals {
  reminder_from = "Fieldtrack <reminders@${var.domain}>"
}

# Own task role: it may send email and nothing else (no records bucket).
resource "aws_iam_role" "reminders_task" {
  name               = "${local.prefix}-reminders-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "reminders_task" {
  role = aws_iam_role.reminders_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "ses:SendEmail", Resource = aws_sesv2_email_identity.main.arn,
      Condition = { StringEquals = { "ses:FromAddress" = "reminders@${var.domain}" } }
    }]
  })
}

# Runs as the owner login: it reads across users and records what it sent (reminders_sent).
resource "aws_ecs_task_definition" "reminders" {
  family                   = "${local.prefix}-reminders"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.reminders_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([merge(local.migrate_container, {
    name    = "reminders"
    command = ["node", "dist/reminders.js"]
    environment = concat(local.base_env, [
      { name = "REMINDER_FROM", value = local.reminder_from },
      { name = "APP_URL", value = "https://${var.domain}" },
    ])
    logConfiguration = merge(local.base_container.logConfiguration, {
      options = merge(local.base_container.logConfiguration.options, { awslogs-stream-prefix = "reminders" })
    })
  })])
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecs:RunTask", Resource = "${aws_ecs_task_definition.reminders.arn_without_revision}:*", Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } } },
      { Effect = "Allow", Action = "iam:PassRole", Resource = [aws_iam_role.execution.arn, aws_iam_role.reminders_task.arn] },
      { Effect = "Allow", Action = "kms:Decrypt", Resource = aws_kms_key.main.arn },
    ]
  })
}

# Every day at 14:00 UTC (morning across US time zones). The deploy pipeline registers each new image as the latest revision.
resource "aws_scheduler_schedule" "reminders" {
  name                         = "${local.prefix}-reminders"
  schedule_expression          = "cron(0 14 * * ? *)"
  schedule_expression_timezone = "UTC"
  kms_key_arn                  = aws_kms_key.main.arn
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.reminders.arn_without_revision
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.public[*].id
        security_groups  = [aws_security_group.api.id]
        assign_public_ip = true # outbound only, like the API (no NAT Gateway)
      }
    }
    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}
