#!/usr/bin/env bash
# ECS helpers for the deploy workflow. Requires aws CLI + jq and env vars set from Terraform outputs.
set -euo pipefail

# register_revision FAMILY IMAGE -> new task definition ARN using IMAGE
register_revision() {
  aws ecs describe-task-definition --task-definition "$1" --query taskDefinition \
    | jq --arg img "$2" '.containerDefinitions[0].image = $img
        | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, requiresCompatibilities, cpu, memory, runtimePlatform}' \
    > /tmp/taskdef.json
  aws ecs register-task-definition --cli-input-json file:///tmp/taskdef.json --query taskDefinition.taskDefinitionArn --output text
}

# run_migrations IMAGE [DB_HOST] -> runs dist/migrate.js as a one-off task; fails if it exits non-zero
run_migrations() {
  local arn overrides task code
  arn=$(register_revision "$MIGRATE_TASK_FAMILY" "$1")
  overrides='{}'
  if [ -n "${2:-}" ]; then
    overrides=$(jq -nc --arg host "$2" '{containerOverrides: [{name: "migrate", environment: [{name: "DB_HOST", value: $host}]}]}')
  fi
  task=$(aws ecs run-task --cluster "$ECS_CLUSTER" --task-definition "$arn" --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$TASK_SUBNETS],securityGroups=[$TASK_SECURITY_GROUP],assignPublicIp=ENABLED}" \
    --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
  echo "Migration task: $task"
  aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$task"
  aws logs filter-log-events --log-group-name "/ecs/$ECS_CLUSTER/api" --log-stream-name-prefix "migrate/migrate/${task##*/}" \
    --query 'events[].message' --output text || true
  code=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
  [ "$code" = "0" ] || { echo "::error::Migrations failed (exit $code)"; return 1; }
}

# deploy_api IMAGE -> rolls the service to IMAGE and waits until stable (circuit breaker rolls back failures)
deploy_api() {
  local arn
  arn=$(register_revision "$API_TASK_FAMILY" "$1")
  aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --task-definition "$arn" > /dev/null
  aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"
  # The daily reminders schedule runs the latest revision of its family.
  register_revision "$REMINDERS_TASK_FAMILY" "$1" > /dev/null
}

# rehearse_migrations IMAGE -> restores a point-in-time clone of the live database, migrates it, deletes it
rehearse_migrations() {
  local clone="${ECS_CLUSTER}-migtest-${GITHUB_RUN_ID:-local}" host status=0
  echo "Restoring $DB_INSTANCE_ID to $clone (latest restorable time)..."
  aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "$DB_INSTANCE_ID" \
    --target-db-instance-identifier "$clone" --use-latest-restorable-time \
    --db-subnet-group-name "$DB_SUBNET_GROUP" --vpc-security-group-ids "$DB_SECURITY_GROUP" \
    --db-parameter-group-name "$DB_PARAMETER_GROUP" --no-multi-az --no-publicly-accessible \
    --no-deletion-protection --tags Key=purpose,Value=migration-rehearsal > /dev/null
  if aws rds wait db-instance-available --db-instance-identifier "$clone" \
     && host=$(aws rds describe-db-instances --db-instance-identifier "$clone" --query 'DBInstances[0].Endpoint.Address' --output text); then
    run_migrations "$1" "$host" || status=$?
  else
    status=1
  fi
  # Always delete the clone: it is a full copy of production data.
  aws rds delete-db-instance --db-instance-identifier "$clone" --skip-final-snapshot --delete-automated-backups > /dev/null \
    || echo "::warning::Could not delete $clone. Delete it by hand."
  return "$status"
}

# publish_web DIST_DIR -> hashed assets cached forever; entry files always revalidated
publish_web() {
  aws s3 sync "$1/assets" "s3://$WEB_BUCKET/assets" --cache-control "public,max-age=31536000,immutable"
  aws s3 sync "$1" "s3://$WEB_BUCKET" --exclude "assets/*" --cache-control "no-cache" --delete
  aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
    --paths "/" "/index.html" "/sw.js" "/registerSW.js" "/manifest.webmanifest" "/theme.js" > /dev/null
}

"$@"
