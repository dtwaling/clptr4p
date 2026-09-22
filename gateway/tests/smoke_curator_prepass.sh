#!/usr/bin/env bash
# Curator advisory pre-pass smoke: deterministic annotation and fail-open paths.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?source vault/.env first}"
: "${CURATOR_DATABASE_URL:?source vault/.env first}"

DENO="${CLPTR4P_DENO:-$HOME/.deno/bin/deno}"
RUN_ID="smoke-curator-$(date -u +%s)"
SUBJECT="vault://subjects/$RUN_ID"
TMP="${TMPDIR:-/tmp}/$RUN_ID"
mkdir -p "$TMP"

cleanup() {
  printf "DELETE FROM proposals WHERE subject_ref = '%s';\n" "$SUBJECT" > "$TMP/cleanup.sql"
  "$DENO" run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts < "$TMP/cleanup.sql" > /dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

printf '%s\n' 'auxiliary:' '  curator:' '    provider: mock' '    model: smoke' '    base_url: ""' '    api_key: ""' '    timeout: 1' > "$TMP/config.yaml"
proposal_json() {
  jq -cn --arg id "urn:cl:proposal:$RUN_ID-$1" --arg sub "$SUBJECT" '{
    operation: "add_or_contradict", submitted_by: "urn:agent:smoke",
    proposed_claims: [{predicate: "hermes.setup", object: {value: "curator-smoke", datatype: "string"}, confidence: 0.9}]
  }'
}
insert_proposal() {
  local name="$1"
  local json
  json=$(proposal_json "$name")
  printf "INSERT INTO proposals (id, subject_ref, status, proposal_json) VALUES ('urn:cl:proposal:%s-%s', '%s', 'pending_validation', '%s'::jsonb);\n" \
    "$RUN_ID" "$name" "$SUBJECT" "$json" > "$TMP/insert-$name.sql"
  "$DENO" run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts < "$TMP/insert-$name.sql" > /dev/null
}
notes_of() {
  printf "SELECT proposal_json->'curator_notes' AS notes FROM proposals WHERE id = 'urn:cl:proposal:%s-%s';\n" "$RUN_ID" "$1" > "$TMP/notes-$1.sql"
  "$DENO" run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts < "$TMP/notes-$1.sql"
}
run_prepass() {
  CLPTR4P_CURATOR_CONFIG="$TMP/config.yaml" CLPTR4P_CURATOR_MOCK_RESPONSE='{"recommended_tier":"core"}' \
    CURATOR_DATABASE_URL="$CURATOR_DATABASE_URL" "$DENO" run --allow-net=127.0.0.1:5433 --allow-env --allow-read="$TMP",../vault/capture ../scripts/curator_prepass.ts
}

echo "--- 1. Mocked curator annotates a pending proposal ---"
insert_proposal success
OUT=$(run_prepass)
echo "$OUT" | grep -q "annotated urn:cl:proposal:$RUN_ID-success" || { echo "FAIL: success annotation missing: $OUT"; exit 1; }
NOTES=$(notes_of success)
echo "$NOTES" | jq -e '.[0].notes.recommended_tier == "core" and (.[] | .notes | has("replaces_claims") and has("net_budget_impact") and has("demotion_candidates"))' > /dev/null || {
  echo "FAIL: expected curator notes missing: $NOTES"; exit 1;
}
echo "  annotation persisted"

echo "--- 2. Missing curator config fails open ---"
insert_proposal unavailable
OUT=$(CLPTR4P_CURATOR_CONFIG="$TMP/missing-config.yaml" CLPTR4P_CURATOR_MOCK_RESPONSE='{"recommended_tier":"core"}' \
  CURATOR_DATABASE_URL="$CURATOR_DATABASE_URL" "$DENO" run --allow-net=127.0.0.1:5433 --allow-env --allow-read="$TMP",../vault/capture ../scripts/curator_prepass.ts 2>&1)
echo "$OUT" | grep -q "curator pre-pass unavailable" || { echo "FAIL: config failure was not reported: $OUT"; exit 1; }
NOTES=$(notes_of unavailable)
echo "$NOTES" | jq -e '.[0].notes == null' > /dev/null || { echo "FAIL: unavailable curator changed proposal: $NOTES"; exit 1; }
echo "  fail-open preserved queue row"

echo "CURATOR PREPASS SMOKE OK"
