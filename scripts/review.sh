#!/usr/bin/env bash
# One-command human review of the clptr4p proposal queue.
#
#   scripts/review.sh list
#   scripts/review.sh show <proposal-id>
#   scripts/review.sh approve <proposal-id> [--tier core|archive]
#   scripts/review.sh reject <proposal-id> --reason "text"
#   scripts/review.sh unpark <proposal-id>
#   scripts/review.sh reject-parked [--subject <ref>] --reason "text"
#
# Sources vault/.env itself; set REVIEWER_PRINCIPAL there or pass
# --reviewer <principal>. Run vault/triage.ts first to park expired or
# ungranted proposals and terminal-reject empty, malformed, or duplicate ones.
set -euo pipefail
cd "$(dirname "$0")/../vault"
set -a; . ./.env; set +a
DENO="${CLPTR4P_DENO:-$HOME/.deno/bin/deno}"
exec "$DENO" run --allow-net=127.0.0.1:5433,openrouter.ai \
  --allow-env --allow-read=.,capture,"$HOME"/.hermes/.env review.ts "$@"
