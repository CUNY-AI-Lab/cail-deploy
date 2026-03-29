#!/usr/bin/env bash

set -euo pipefail

KALE_RUNNER_HOST="${KALE_RUNNER_HOST:-}"
KALE_RUNNER_SSH_KEY="${KALE_RUNNER_SSH_KEY:-}"
KALE_RUNNER_SSH_USER="${KALE_RUNNER_SSH_USER:-ec2-user}"
KALE_RUNNER_CACHE_VOLUME="${KALE_RUNNER_CACHE_VOLUME:-cail-build-runner-cache}"
KALE_RUNNER_DISPATCHER_CONTAINER="${KALE_RUNNER_DISPATCHER_CONTAINER:-cail-build-runner}"

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'OK   %s\n' "$1"
}

warn() {
  printf 'WARN %s\n' "$1"
}

[ -n "$KALE_RUNNER_HOST" ] || fail "Set KALE_RUNNER_HOST before pruning the runner cache."
[ -n "$KALE_RUNNER_SSH_KEY" ] || fail "Set KALE_RUNNER_SSH_KEY before pruning the runner cache."

ssh_cmd=(
  ssh
  -o StrictHostKeyChecking=no
  -o ConnectTimeout=10
  -i "$KALE_RUNNER_SSH_KEY"
  "${KALE_RUNNER_SSH_USER}@${KALE_RUNNER_HOST}"
)

running_containers="$("${ssh_cmd[@]}" "docker ps --format '{{.Names}}'")" || fail "Could not list runner host containers."
active_workers="$(printf '%s\n' "$running_containers" | grep -v "^${KALE_RUNNER_DISPATCHER_CONTAINER}\$" | sed '/^$/d' || true)"

if [ -n "$active_workers" ]; then
  fail "Disposable build containers are still running: ${active_workers//$'\n'/, }. Wait for active builds to finish first."
fi

if ! "${ssh_cmd[@]}" "docker volume inspect '$KALE_RUNNER_CACHE_VOLUME' >/dev/null 2>&1"; then
  warn "Runner cache volume $KALE_RUNNER_CACHE_VOLUME does not exist. Nothing to prune."
  exit 0
fi

pass "No active disposable build containers are running"
"${ssh_cmd[@]}" "docker volume rm '$KALE_RUNNER_CACHE_VOLUME' >/dev/null" || fail "Could not remove runner cache volume $KALE_RUNNER_CACHE_VOLUME."
pass "Removed runner cache volume $KALE_RUNNER_CACHE_VOLUME"
warn "The next build will warm a fresh package cache and may take a bit longer."
