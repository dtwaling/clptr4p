#!/usr/bin/env bash
# clptr4p review-queue digest (cron watchdog entry point).
#
# Runs auto-triage and prints the digest: terminal-close and parked counts plus
# any proposals that need human eyes. EMPTY output on an idle queue, so a
# no_agent cron job delivers nothing on quiet days. Approval stays human-only;
# expiry and ungranted proposals are parked for later human action.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../vault"
set -a; . ./.env; set +a
DENO="${CLPTR4P_DENO:-$HOME/.deno/bin/deno}"
"$SCRIPT_DIR/curator_prepass.sh"
exec "$DENO" run --allow-net=127.0.0.1:5433 \
  --allow-env --allow-read=.,capture triage.ts --format digest
