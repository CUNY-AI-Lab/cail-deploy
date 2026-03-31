#!/usr/bin/env bash

set -euo pipefail

KALE_BASE_URL="${KALE_BASE_URL:-https://cuny.qzz.io/kale}"
KALE_RUNTIME_URL="${KALE_RUNTIME_URL:-https://runtime.cuny.qzz.io/.well-known/kale-runtime.json}"
KALE_DEPLOY_SERVICE_HEALTH_URL="${KALE_DEPLOY_SERVICE_HEALTH_URL:-https://cail-deploy-service.ailab-452.workers.dev/healthz}"
KALE_GATEWAY_HEALTH_URL="${KALE_GATEWAY_HEALTH_URL:-https://cail-gateway.ailab-452.workers.dev/healthz}"
KALE_SMOKE_URL="${KALE_SMOKE_URL:-}"
KALE_RUNNER_HOST="${KALE_RUNNER_HOST:-}"
KALE_RUNNER_SSH_KEY="${KALE_RUNNER_SSH_KEY:-}"
KALE_RUNNER_SSH_USER="${KALE_RUNNER_SSH_USER:-ec2-user}"
KALE_RUNNER_INSTANCE_ID="${KALE_RUNNER_INSTANCE_ID:-}"
AWS_PROFILE="${AWS_PROFILE:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
KALE_HEALTHCHECK_USER_AGENT="${KALE_HEALTHCHECK_USER_AGENT:-Mozilla/5.0 (compatible; KaleHealthcheck/1.0; +https://github.com/CUNY-AI-Lab/cail-deploy)}"

pass() {
  printf 'OK   %s\n' "$1"
}

warn() {
  printf 'WARN %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

fetch_body() {
  local url="$1"
  curl \
    --silent \
    --show-error \
    --fail \
    --location \
    --max-time 20 \
    --retry 2 \
    --retry-delay 2 \
    --retry-all-errors \
    --user-agent "$KALE_HEALTHCHECK_USER_AGENT" \
    --header 'Accept: text/html,application/json;q=0.9,*/*;q=0.8' \
    "$url"
}

check_contains() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local max_attempts="${4:-1}"
  local body attempt

  for (( attempt=1; attempt<=max_attempts; attempt++ )); do
    body="$(fetch_body "$url" 2>/dev/null)" || {
      if [ "$attempt" -lt "$max_attempts" ]; then sleep 3; continue; fi
      fail "$label: request failed for $url"
    }
    if printf '%s' "$body" | grep -Fq "$expected"; then
      pass "$label"
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then sleep 3; fi
  done

  fail "$label: response from $url did not contain $expected"
}

check_runner_over_ssh() {
  local ssh_cmd
  ssh_cmd=(
    ssh
    -o StrictHostKeyChecking=no
    -o ConnectTimeout=10
    -i "$KALE_RUNNER_SSH_KEY"
    "${KALE_RUNNER_SSH_USER}@${KALE_RUNNER_HOST}"
    "curl -fsS http://127.0.0.1:8080/readyz"
  )

  local body
  body="$("${ssh_cmd[@]}")" || fail "Runner SSH health check failed"
  printf '%s' "$body" | grep -Fq '"ok":true' || fail "Runner SSH health check did not return ok"
  pass "Runner readyz over SSH"
}

check_runner_instance_state() {
  local output
  output="$(aws ec2 describe-instances \
    ${AWS_PROFILE:+--profile "$AWS_PROFILE"} \
    --region "$AWS_REGION" \
    --instance-ids "$KALE_RUNNER_INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text)" || fail "Runner EC2 state lookup failed"

  [ "$output" = "running" ] || fail "Runner EC2 instance state is $output"
  pass "Runner EC2 instance state"
}

check_contains "Public front door" "$KALE_BASE_URL" "Kale Deploy" 3
check_contains "Public healthz" "${KALE_BASE_URL%/}/healthz" '"ok":true'
check_contains "Runtime manifest" "$KALE_RUNTIME_URL" '"agent_api"'
check_contains "Direct deploy-service healthz" "$KALE_DEPLOY_SERVICE_HEALTH_URL" '"ok":true'
check_contains "Direct gateway healthz" "$KALE_GATEWAY_HEALTH_URL" '"ok":true'

if [ -n "$KALE_SMOKE_URL" ]; then
  check_contains "Smoke project" "$KALE_SMOKE_URL" '"ok":true'
else
  warn "Skipping smoke project check because KALE_SMOKE_URL is not set"
fi

if [ -n "$KALE_RUNNER_INSTANCE_ID" ]; then
  check_runner_instance_state
else
  warn "Skipping EC2 instance-state check because KALE_RUNNER_INSTANCE_ID is not set"
fi

if [ -n "$KALE_RUNNER_HOST" ] && [ -n "$KALE_RUNNER_SSH_KEY" ]; then
  check_runner_over_ssh
else
  warn "Skipping runner SSH health check because KALE_RUNNER_HOST or KALE_RUNNER_SSH_KEY is not set"
fi

pass "Kale Deploy health check completed"
