#!/usr/bin/env bash
# Advisory curator queue pre-pass. Fail-open by design: annotations are optional
# and human review remains available whenever the curator is unavailable.
set -euo pipefail
cd "$(dirname "$0")/../vault"
set -a; . ./.env; set +a
DENO="${CLPTR4P_DENO:-$HOME/.deno/bin/deno}"
exec "$DENO" run --allow-net=127.0.0.1:5433,openrouter.ai \
  --allow-env --allow-read=.,capture,"$HOME"/.hermes/config.yaml \
  ../scripts/curator_prepass.ts
