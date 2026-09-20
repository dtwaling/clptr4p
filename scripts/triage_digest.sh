#!/usr/bin/env bash
# clptr4p review-queue digest (cron watchdog entry point).
#
# Runs auto-triage and prints the digest: closed counts plus any proposals
# that need human eyes. EMPTY output on an idle queue, so a no_agent cron job
# delivers nothing on quiet days. Approval stays human-only by design;
# this script can only ever reject.
set -euo pipefail
cd "$(dirname "$0")/../vault"
set -a; . ./.env; set +a
DENO="${CLPTR4P_DENO:-$HOME/.deno/bin/deno}"
exec "$DENO" run --allow-net=127.0.0.1:5433 \
  --allow-env --allow-read=.,capture triage.ts --format digest
