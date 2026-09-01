#!/usr/bin/env bash
set -Eeuo pipefail

case "${SSH_ORIGINAL_COMMAND:-probe}" in
  deploy)
    exec /opt/cmhub-api-test/deploy/ubuntu/deploy-test-api.sh
    ;;
  probe)
    pm2 describe cmhub-cloud-api-test >/dev/null
    curl --fail --silent --show-error http://127.0.0.1:8080/healthz
    ;;
  *)
    echo "Only probe and deploy are permitted." >&2
    exit 64
    ;;
esac
