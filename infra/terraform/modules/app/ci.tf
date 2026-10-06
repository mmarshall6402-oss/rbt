# GitHub Actions deploys with short-lived OIDC credentials: no AWS keys stored anywhere.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

resource "aws_iam_role" "deploy" {
  name = "${local.prefix}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Federated = local.oidc_arn }, Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        # Only jobs bound to this GitHub environment (prod requires a human approval in GitHub).
        StringLike = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:environment:${var.env == "prod" ? "production" : "staging"}" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "EcrAuth", Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      {
        Sid    = "EcrPush", Effect = "Allow", Resource = aws_ecr_repository.api.arn
        Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"]
      },
      { Sid = "EcrKms", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = aws_kms_key.main.arn },
      { Sid = "EcsRead", Effect = "Allow", Action = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:DescribeServices", "ecs:DescribeTasks", "ecs:ListTasks"], Resource = "*" },
      { Sid = "EcsDeploy", Effect = "Allow", Action = ["ecs:UpdateService", "ecs:RunTask"], Resource = "*", Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } } },
      { Sid = "PassRoles", Effect = "Allow", Action = "iam:PassRole", Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn] },
      { Sid = "Web", Effect = "Allow", Action = ["s3:ListBucket", "s3:PutObject", "s3:DeleteObject"], Resource = [aws_s3_bucket.web.arn, "${aws_s3_bucket.web.arn}/*"] },
      { Sid = "Cdn", Effect = "Allow", Action = "cloudfront:CreateInvalidation", Resource = aws_cloudfront_distribution.main.arn },
      { Sid = "Logs", Effect = "Allow", Action = ["logs:GetLogEvents", "logs:FilterLogEvents"], Resource = "${aws_cloudwatch_log_group.api.arn}:*" },
      # Migration rehearsal: restore a temporary point-in-time clone, migrate it, delete it.
      { Sid = "RdsDescribe", Effect = "Allow", Action = ["rds:DescribeDBInstances"], Resource = "*" },
      {
        Sid = "RdsClone", Effect = "Allow", Action = ["rds:RestoreDBInstanceToPointInTime", "rds:AddTagsToResource"]
        Resource = [aws_db_instance.main.arn, "arn:aws:rds:${local.region}:${data.aws_caller_identity.current.account_id}:db:${local.prefix}-migtest-*",
          "arn:aws:rds:${local.region}:${data.aws_caller_identity.current.account_id}:subgrp:${aws_db_subnet_group.main.name}",
        "arn:aws:rds:${local.region}:${data.aws_caller_identity.current.account_id}:pg:${aws_db_parameter_group.main.name}"]
      },
      { Sid = "RdsCloneDelete", Effect = "Allow", Action = "rds:DeleteDBInstance", Resource = "arn:aws:rds:${local.region}:${data.aws_caller_identity.current.account_id}:db:${local.prefix}-migtest-*" },
    ]
  })
}
