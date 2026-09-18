#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?source vault/.env first}"
: "${CAPTURE_DATABASE_URL:?source vault/.env first}"
: "${GATEWAY_DATABASE_URL:?source vault/.env first}"
: "${VAULT_DEK:?source vault/.env first}"

RUN_ID="smoke-cap-$(date -u +%s)"
SUBJECT="vault://subjects/$RUN_ID"

# Remember the production active policy so the trap restores IT (not a hardcoded id).
PRIOR_POLICY=$(cat <<SQL | deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts | jq -r '.[0].id'
SELECT id FROM policies WHERE active;
SQL
)
: "${PRIOR_POLICY:?no active policy found}"

# Cleanup runs from the FIRST DB write onward: restore the prior active policy
# and remove this run's subject data. Registered before any seeding so a crash
# mid-run can never leak test data or clobber the production policy.
restore() {
  cat <<SQL | deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /dev/null
BEGIN;
UPDATE policies SET active = false;
UPDATE policies SET active = true WHERE id = '${PRIOR_POLICY}';
COMMIT;
DELETE FROM claim_sources WHERE claim_id IN (SELECT id FROM claims WHERE subject_ref = '$SUBJECT');
DELETE FROM claims WHERE subject_ref = '$SUBJECT';
DELETE FROM source_events WHERE subject_ref = '$SUBJECT';
DELETE FROM proposals WHERE subject_ref = '$SUBJECT';
SQL
  rm -f /tmp/cap1.json /tmp/cap2.json /tmp/check1.sql /tmp/check2.sql /tmp/out1.txt /tmp/out2.txt /tmp/out3.txt /tmp/seed.sql /tmp/restore.sql
}
trap restore EXIT

jq --arg sub "$SUBJECT" '.subject_ref = $sub' ../vault/fixtures/capture-sample.json > /tmp/cap1.json
jq --arg sub "$SUBJECT" '.subject_ref = $sub' ../vault/fixtures/capture-supersede.json > /tmp/cap2.json

echo "--- 1. Ingest sample ---"
deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault,/tmp ../vault/capture/ingest.ts /tmp/cap1.json

echo "--- 2. Verify counts ---"
cat <<SQL > /tmp/check1.sql
SELECT count(*) as events FROM source_events WHERE subject_ref = '$SUBJECT';
SELECT count(*) as claims FROM claims WHERE subject_ref = '$SUBJECT';
SQL
deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts < /tmp/check1.sql > /tmp/out1.txt
grep -q '"events":"1"' /tmp/out1.txt || { echo "FAIL: expected 1 event"; cat /tmp/out1.txt; exit 1; }
grep -q '"claims":"1"' /tmp/out1.txt || { echo "FAIL: expected 1 claim"; cat /tmp/out1.txt; exit 1; }

echo "--- 3. Re-ingest (idempotency) ---"
deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault,/tmp ../vault/capture/ingest.ts /tmp/cap1.json
deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts < /tmp/check1.sql > /tmp/out2.txt
diff /tmp/out1.txt /tmp/out2.txt || { echo "FAIL: idempotency broken"; exit 1; }

echo "--- 4. Ingest supersede ---"
deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault,/tmp ../vault/capture/ingest.ts /tmp/cap2.json

echo "--- 5. Verify supersede ---"
cat <<SQL > /tmp/check2.sql
SELECT value, superseded_by IS NOT NULL as superseded, embedding IS NOT NULL as embedded FROM claims WHERE predicate = 'preferred_name' AND subject_ref = '$SUBJECT' ORDER BY created_at;
SQL
deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts < /tmp/check2.sql > /tmp/out3.txt
OLD_SUP=$(cat /tmp/out3.txt | jq -r '.[] | select(.value | contains("Dustin")) | .superseded')
NEW_SUP=$(cat /tmp/out3.txt | jq -r '.[] | select(.value | contains("dtdubs")) | .superseded')
[ "$OLD_SUP" = "true" ] || { echo "FAIL: old claim not superseded"; cat /tmp/out3.txt; exit 1; }
[ "$NEW_SUP" = "false" ] || { echo "FAIL: new claim not active"; cat /tmp/out3.txt; exit 1; }
# Hook: the superseding claim must be embedded INLINE (no separate embed run).
NEW_EMB=$(cat /tmp/out3.txt | jq -r '.[] | select(.value | contains("dtdubs")) | .embedded')
[ "$NEW_EMB" = "true" ] || { echo "FAIL: inline embed missing on new claim"; cat /tmp/out3.txt; exit 1; }
echo "  inline embed: ok"

echo "--- 6. Gateway end-to-end ---"
POLICY='{"id":"urn:cl:policy:smoke-capture","version":"smoke/1","issuer":"urn:cl:policy-engine:local","allowed_purpose_codes":["x.test.read"],"allowed_selectors":["preferred_name"],"denied_selectors":[],"allowed_actions":[],"max_retention_seconds":3600,"allow_onward_disclosure":false,"transform_requirements":[]}'
cat <<SQL > /tmp/seed.sql
BEGIN;
UPDATE policies SET active = false;
INSERT INTO policies (id, version, issuer, policy_json, active) VALUES ('urn:cl:policy:smoke-capture', 'smoke/1', 'urn:cl:policy-engine:local', '$POLICY'::jsonb, true) ON CONFLICT (id) DO UPDATE SET policy_json = EXCLUDED.policy_json, active = true;
COMMIT;
SQL
deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts < /tmp/seed.sql

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LATER=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
REQ=$(jq -n -c --arg now "$NOW" --arg later "$LATER" --arg id "urn:cl:request:$RUN_ID" --arg sub "$SUBJECT" '{
  spec_version: "context-layer/0.2-draft", type: "context_request", id: $id, created_at: $now,
  issuer: {id: "urn:agent:test"}, subject_ref: $sub,
  requester: {principal: "urn:agent:test", authenticated_by: "local", client_instance: "test"},
  recipient: {principal: "urn:model:test", onward_disclosure: "allowed"},
  purpose_code: "x.test.read", purpose: "test", task: {kind: "test", user_visible: true},
  selectors: [{predicate: "preferred_name"}], requested_actions: [],
  retention: {mode: "ephemeral", max_seconds: 3600}, receipt_requirement: {level: "operation", required: true},
  expires_at: $later
}')

OUT=$( {
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context_request\",\"arguments\":{\"request\":$REQ}}}"
  sleep 1
} | timeout 15 deno run --allow-net=127.0.0.1:5433 --allow-read=.,../context-layer-reference --allow-env main.ts 2>/dev/null )

BUNDLE=$(printf '%s\n' "$OUT" | jq -r 'select(.id==2) | .result.content[0].text | fromjson | .bundle')
CLAIM_VAL=$(echo "$BUNDLE" | jq -r '.context[0].value')
PROV_HANDLE=$(echo "$BUNDLE" | jq -r '.context[0].provenance_handles[0]')

echo "Gateway returned value: $CLAIM_VAL"
echo "Gateway returned prov: $PROV_HANDLE"

CLAIM_VAL_CLEAN=$(echo "$CLAIM_VAL" | tr -d '"')
[ "$CLAIM_VAL_CLEAN" = "dtdubs" ] || { echo "FAIL: wrong claim value ($CLAIM_VAL)"; exit 1; }
[[ "$PROV_HANDLE" == prov_* ]] || { echo "FAIL: bad prov handle"; exit 1; }

echo "CAPTURE SMOKE OK"
