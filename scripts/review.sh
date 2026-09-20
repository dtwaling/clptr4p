#!/usr/bin/env bash
# One-command human review of the clptr4p proposal queue.
#
#   scripts/review.sh list
#   scripts/review.sh show <proposal-id>
#   scripts/review.sh approve <proposal-id>
#   scripts/review.sh reject <proposal-id> --reason "text"
#
# Sources vault/.env itself; override the reviewer identity via
# REVIEWER_PRINCIPAL. Run vault/triage.ts first to auto-close the
# dead weight (expired / ungranted / duplicate).
set -euo pipefail
cd "$(dirname "$0")/../vault"
set -a; . ./.env; set +a
export REVIEWER_PRINCIPAL="${REVIEWER_PRINCIPAL:-urn:user:dtdubs}"
exec /home/dtdubs/.deno/bin/deno run --allow-net=127.0.0.1:5433,openrouter.ai \
  --allow-env --allow-read=.,capture,/home/dtdubs/.hermes/.env review.ts "$@"
