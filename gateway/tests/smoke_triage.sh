#!/usr/bin/env bash
# Triage end-to-end against the REAL active policy (no policy swap needed --
# triage only reads it):
#   1. seed four proposals on a throwaway subject:
#        doa       -- predicate not granted by the active policy
#        expired   -- past expires_at
#        survivor  -- granted predicate, novel value
#   2. triage --dry-run: nothing changes, decisions previewed
#   3. triage: doa + expired auto-rejected, survivor kept
#   4. human review still works on the survivor (review.ts approve)
#   5. duplicate of the approved claim -> auto-rejected on the next triage run
#   6. partial duplicate (one new value) survives -- triage is conservative
#   7. triage never commits claims (count stays at the human-approved 1)
# Requires vault/.env sourced.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?source vault/.env first}"
: "${REVIEWER_DATABASE_URL:?source vault/.env first}"
: "${VAULT_DEK:?source vault/.env first}"

RUN_ID="smoke-triage-$(date -u +%s)"
SUBJECT="vault://subjects/$RUN_ID"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LATER=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
PAST=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)
GRANTED_PREDICATE="hermes.setup"   # granted by the real active policy
DENO=/home/dtdubs/.deno/bin/deno

cleanup() {
  cat <<SQL | $DENO run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /dev/null
DELETE FROM claim_sources WHERE claim_id IN (SELECT id FROM claims WHERE subject_ref = '$SUBJECT');
DELETE FROM claims WHERE subject_ref = '$SUBJECT';
DELETE FROM source_events WHERE subject_ref = '$SUBJECT';
DELETE FROM proposals WHERE subject_ref = '$SUBJECT';
SQL
}
trap cleanup EXIT

propose_json() { # $1 = name, $2 = predicate, $3 = value, $4 = expires_at, $5 = extra-claims JSON array
  local extra="${5:-[]}"
  jq -n -c --arg id "urn:cl:proposal:$RUN_ID-$1" --arg sub "$SUBJECT" --arg now "$NOW" \
    --arg pred "$2" --arg val "$3" --arg exp "$4" --argjson extra "$extra" '{
    spec_version: "context-layer/0.2-draft", type: "memory_update_proposal", id: $id, created_at: $now,
    issuer: {id: "urn:agent:test"}, subject_ref: $sub, operation: "add_or_contradict",
    proposed_claims: ([{predicate: $pred, object: {value: $val, datatype: "string"}, confidence: 0.9}] + $extra),
    provenance_refs: [], rationale: "smoke triage", submitted_by: "urn:agent:test",
    status: "pending_validation", approval_requirement: ["user_confirm"], expires_at: $exp
  }'
}

insert_proposal() { # $1 = name, rest -> propose_json args (predicate, value, expires_at, extra)
  local name="$1"; shift
  cat <<SQL | $DENO run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /dev/null
INSERT INTO proposals (id, subject_ref, status, proposal_json)
VALUES ('urn:cl:proposal:$RUN_ID-$name', '$SUBJECT', 'pending_validation', '$(propose_json "$name" "$@")'::jsonb);
SQL
}

triage() { # $@ -> triage.ts args
  REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" VAULT_DEK="$VAULT_DEK" \
    $DENO run --allow-net=127.0.0.1:5433 --allow-env --allow-read=.,../vault/capture ../vault/triage.ts "$@"
}

status_of() { # $1 = proposal name
  cat <<SQL | $DENO run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts | jq -r '.[0].status'
SELECT status FROM proposals WHERE id = 'urn:cl:proposal:$RUN_ID-$1';
SQL
}

echo "--- 1. Seed four proposals on throwaway subject ---"
insert_proposal doa        "x.triage.doa"       "dead-on-arrival" "$LATER" ''
insert_proposal expired    "$GRANTED_PREDICATE" "too late"        "$PAST" ''
insert_proposal survivor   "$GRANTED_PREDICATE" "smoke-v1"        "$LATER" ''
insert_proposal empty      "$GRANTED_PREDICATE" "ignored"         "$LATER" ''
# empty: strip proposed_claims to an empty array
cat <<SQL | $DENO run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /dev/null
UPDATE proposals SET proposal_json = jsonb_set(proposal_json, '{proposed_claims}', '[]'::jsonb)
WHERE id = 'urn:cl:proposal:$RUN_ID-empty';
SQL
echo "  seeded: doa, expired, survivor, empty"

echo "--- 2. Dry run changes nothing ---"
DRY=$(triage --dry-run 2>&1)
echo "$DRY" | grep -q "would reject urn:cl:proposal:$RUN_ID-doa" || { echo "FAIL: dry run missing doa: $DRY"; exit 1; }
echo "$DRY" | grep -q "would reject urn:cl:proposal:$RUN_ID-expired" || { echo "FAIL: dry run missing expired: $DRY"; exit 1; }
echo "$DRY" | grep -q "would reject urn:cl:proposal:$RUN_ID-empty" || { echo "FAIL: dry run missing empty: $DRY"; exit 1; }
for name in doa expired survivor empty; do
  [ "$(status_of $name)" = "pending_validation" ] || { echo "FAIL: dry run mutated $name"; exit 1; }
done
echo "  dry run clean (no writes)"

echo "--- 3. Triage closes doa / expired / empty, keeps survivor ---"
RUN=$(triage 2>&1)
echo "$RUN" | grep -q "rejected urn:cl:proposal:$RUN_ID-doa" || { echo "FAIL: doa not rejected: $RUN"; exit 1; }
echo "$RUN" | grep -q "not granted by active policy: x.triage.doa" || { echo "FAIL: doa reason missing: $RUN"; exit 1; }
echo "$RUN" | grep -q "rejected urn:cl:proposal:$RUN_ID-expired" || { echo "FAIL: expired not rejected: $RUN"; exit 1; }
echo "$RUN" | grep -q "rejected urn:cl:proposal:$RUN_ID-empty" || { echo "FAIL: empty not rejected: $RUN"; exit 1; }
[ "$(status_of survivor)" = "pending_validation" ] || { echo "FAIL: survivor was closed: $(status_of survivor)"; exit 1; }
echo "  doa + expired + empty rejected; survivor kept"

echo "--- 4. Human review still works on the survivor ---"
APP=$(REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" VAULT_DEK="$VAULT_DEK" REVIEWER_PRINCIPAL="urn:user:dtdubs" \
  $DENO run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault/capture ../vault/review.ts approve "urn:cl:proposal:$RUN_ID-survivor")
echo "  $APP"
echo "$APP" | grep -q "committed" || { echo "FAIL: human approve broken"; exit 1; }

echo "--- 5. Verbatim duplicate gets auto-rejected on next run ---"
insert_proposal duplicate  "$GRANTED_PREDICATE" "smoke-v1" "$LATER" ''
RUN2=$(triage 2>&1)
echo "$RUN2" | grep -q "rejected urn:cl:proposal:$RUN_ID-duplicate" || { echo "FAIL: duplicate not rejected: $RUN2"; exit 1; }
echo "$RUN2" | grep -q "duplicate of active claim" || { echo "FAIL: duplicate reason missing: $RUN2"; exit 1; }
echo "  duplicate rejected"

echo "--- 6. Partial duplicate (one new value) survives ---"
EXTRA='[{"predicate": "terminal.guard", "object": {"value": "partial-dupe-new-value", "datatype": "string"}, "confidence": 0.9}]'
insert_proposal partial    "$GRANTED_PREDICATE" "smoke-v1" "$LATER" "$EXTRA"
RUN3=$(triage 2>&1)
[ "$(status_of partial)" = "pending_validation" ] || { echo "FAIL: partial duplicate closed: $RUN3"; exit 1; }
echo "  partial duplicate kept for human"

echo "--- 7. Triage never committed claims ---"
cat <<SQL | $DENO run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /tmp/triage_claims.json
SELECT count(*) as n FROM claims WHERE subject_ref = '$SUBJECT';
SQL
N=$(jq -r '.[0].n' /tmp/triage_claims.json)
echo "  claims on subject: $N (human-approved only)"
[ "$N" = "1" ] || { echo "FAIL: expected exactly the 1 human-approved claim"; exit 1; }

echo "--- 8. Digest format: idle queue prints nothing ---"
# Reject the partial proposal via the human CLI so the queue is clean for it.
REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" VAULT_DEK="$VAULT_DEK" REVIEWER_PRINCIPAL="urn:user:dtdubs" \
  $DENO run --allow-net=127.0.0.1:5433 --allow-env --allow-read=.,../vault/capture ../vault/review.ts reject "urn:cl:proposal:$RUN_ID-partial" --reason "smoke cleanup" > /dev/null
DIGEST=$(REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" VAULT_DEK="$VAULT_DEK" \
  $DENO run --allow-net=127.0.0.1:5433 --allow-env --allow-read=.,../vault/capture ../vault/triage.ts --format digest 2>&1)
# Only proposals on OTHER subjects could appear here; assert ours is absent.
echo "$DIGEST" | grep -q "$RUN_ID" && { echo "FAIL: digest mentions cleaned subject: $DIGEST"; exit 1; }
echo "  digest clean for this subject"

echo "TRIAGE SMOKE OK"
