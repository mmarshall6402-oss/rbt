# ---- Certificates & DNS ----
resource "aws_acm_certificate" "site" {
  provider          = aws.us_east_1 # CloudFront certificates must live in us-east-1
  domain_name       = var.domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "origin" {
  domain_name       = "origin.${var.domain}"
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for o in concat(tolist(aws_acm_certificate.site.domain_validation_options), tolist(aws_acm_certificate.origin.domain_validation_options)) :
    o.domain_name => o
  }
  zone_id         = var.hosted_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [aws_route53_record.cert_validation[var.domain].fqdn]
}

resource "aws_acm_certificate_validation" "origin" {
  certificate_arn         = aws_acm_certificate.origin.arn
  validation_record_fqdns = [aws_route53_record.cert_validation["origin.${var.domain}"].fqdn]
}

resource "aws_route53_record" "origin" {
  zone_id = var.hosted_zone_id
  name    = "origin.${var.domain}"
  type    = "A"
  alias {
    name                   = aws_lb.api.dns_name
    zone_id                = aws_lb.api.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "site" {
  for_each = toset(["A", "AAAA"])
  zone_id  = var.hosted_zone_id
  name     = var.domain
  type     = each.value
  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---- Static site bucket (private; CloudFront reads it via Origin Access Control) ----
resource "aws_s3_bucket" "web" {
  #checkov:skip=CKV_AWS_18:build output only; edge requests are logged by WAF
  #checkov:skip=CKV_AWS_21:build output is reproducible from git; each deploy replaces it
  #checkov:skip=CKV_AWS_144:build output is reproducible from git
  #checkov:skip=CKV_AWS_145:public static assets; SSE-S3 avoids KMS calls on every CloudFront read
  #checkov:skip=CKV2_AWS_61:old hashed assets are kept on purpose for clients mid-update
  #checkov:skip=CKV2_AWS_62:no consumers for object events
  bucket_prefix = "${local.prefix}-web-"
  force_destroy = true # build output only, no records
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.prefix}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Principal = { Service = "cloudfront.amazonaws.com" }, Action = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.main.arn } }
    }]
  })
}

# SPA routing: /app, /supervise/123 → index.html. Files (with a dot) and /api pass through.
resource "aws_cloudfront_function" "spa" {
  name    = "${local.prefix}-spa"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var r = event.request;
      if (!r.uri.startsWith('/api/') && r.uri.lastIndexOf('.') <= r.uri.lastIndexOf('/')) r.uri = '/index.html';
      return r;
    }
  JS
}

locals {
  region      = data.aws_region.current.region
  auth_domain = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${local.region}.amazoncognito.com"
  # Shared with the local preview server so browser tests run under the same policy (apps/web/security-headers.json).
  headers = jsondecode(file("${path.module}/../../../../apps/web/security-headers.json"))
  csp = replace(replace(join("; ", local.headers.csp),
    "{connect}", "https://cognito-idp.${local.region}.amazonaws.com ${local.auth_domain} https://*.ingest.us.sentry.io https://*.ingest.sentry.io"),
  "{auth}", local.auth_domain)
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${local.prefix}-security"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_security_policy {
      content_security_policy = local.csp
      override                = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = local.headers.referrerPolicy
      override        = true
    }
  }
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.headers.permissionsPolicy
      override = true
    }
  }
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "main" {
  #checkov:skip=CKV_AWS_86:edge requests are logged by WAF logging (aws-waf-logs-*)
  #checkov:skip=CKV_AWS_374:trainees work outside the US too
  #checkov:skip=CKV_AWS_310:single API origin; ECS spreads tasks across two AZs
  #checkov:skip=CKV2_AWS_47:AWSManagedRulesKnownBadInputsRuleSet (includes Log4JRCE) is attached to the web ACL
  enabled             = true
  is_ipv6_enabled     = true
  aliases             = [var.domain]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.main.arn

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }
  origin {
    origin_id   = "api"
    domain_name = "origin.${var.domain}"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_secret.result
    }
  }

  default_cache_behavior {
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id # never cache health data
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# ---- WAF: managed protections + rate limits (invite codes are the brute-force target) ----
resource "aws_wafv2_web_acl" "main" {
  provider = aws.us_east_1
  name     = local.prefix
  scope    = "CLOUDFRONT"
  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
        # Stripe events can exceed this group's 8 KB body limit; that endpoint verifies Stripe's signature instead.
        scope_down_statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = "/api/stripe/webhook"
                positional_constraint = "EXACTLY"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-common"
      sampled_requests_enabled   = false # samples would capture request content
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "known-bad-inputs"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "invite-code-guessing"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 20 # per 5 minutes per IP
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/supervisions"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "invite-code-guessing"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "per-ip-rate"
    priority = 4
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "per-ip-rate"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.prefix
    sampled_requests_enabled   = false
  }
}

# WAF logs: CloudFront-scope logs live in us-east-1, and the log group name must start with aws-waf-logs-.
resource "aws_cloudwatch_log_group" "waf" {
  #checkov:skip=CKV_AWS_158:WAF logs carry no bodies and redact credentials; encrypted at rest by default
  provider          = aws.us_east_1
  name              = "aws-waf-logs-${local.prefix}"
  retention_in_days = 365
}

resource "aws_wafv2_web_acl_logging_configuration" "main" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.main.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
}
