#!/usr/bin/env bash
# Proposal review end-to-end:
#   1. gateway memory_propose queues a proposal (predicate x.verified.handle)
#   2. review.ts list/show sees it
#   3. review.ts approve commits claims with provenance
#   4. gateway context_request serves the committed claim
#   5. double-approve is rejected
#   6. a second proposal for the same predicate (add_or_contradict) supersedes
#   7. reject path works
# Requires vault/.env sourced.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?source vault/.env first}"
: "${GATEWAY_DATABASE_URL:?source vault/.env first}"
: "${REVIEWER_DATABASE_URL:?source vault/.env first}"
: "${VAULT_DEK:?source vault/.env first}"

RUN_ID="smoke-rev-$(date -u +%s)"
SUBJECT="vault://subjects/$RUN_ID"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LATER=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)

restore() {
  # Restore the prior active policy AND remove this run's subject data in one
  # SQL block (set -e would skip the deletes if a separate policy block failed).
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
}

# Read the production active policy BEFORE registering the trap: a read failure
# must exit without touching anything, not fire a restore with an empty id.
PRIOR_POLICY=$(cat <<SQL | deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts | jq -r '.[0].id'
SELECT id FROM policies WHERE active;
SQL
)
: "${PRIOR_POLICY:?no active policy found}"
trap restore EXIT

# Permissive policy for our test predicate.
POLICY=$(jq -n -c --arg sel "x.verified.handle" '{
  id: "urn:cl:policy:smoke-review", version: "smoke/1", issuer: "urn:cl:policy-engine:local",
  allowed_purpose_codes: ["x.test.read"], allowed_selectors: [$sel], denied_selectors: [],
  allowed_actions: [], max_retention_seconds: 3600, allow_onward_disclosure: false,
  transform_requirements: []}')
cat <<SQL | deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /dev/null
BEGIN;
UPDATE policies SET active = false;
INSERT INTO policies (id, version, issuer, policy_json, active)
VALUES ('urn:cl:policy:smoke-review', 'smoke/1', 'urn:cl:policy-engine:local', '$POLICY'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET policy_json = EXCLUDED.policy_json, active = true;
COMMIT;
SQL

propose() { # $1 = proposal value
  jq -n -c --arg sub "$SUBJECT" --arg now "$NOW" --arg later "$LATER" --arg id "urn:cl:proposal:$RUN_ID-$1" --arg val "$1" '{
    spec_version: "context-layer/0.2-draft", type: "memory_update_proposal", id: $id, created_at: $now,
    issuer: {id: "urn:agent:test"}, subject_ref: $sub,
    operation: "add_or_contradict",
    proposed_claims: [{predicate: "x.verified.handle", object: {value: $val, datatype: "string"}, confidence: 0.9}],
    provenance_refs: [], rationale: "smoke test proposal", submitted_by: "urn:agent:test",
    status: "pending_validation", approval_requirement: ["user_confirm"], expires_at: $later
  }'
}

call_gateway() { # $1 = tool name, $2 = json arg value
  { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
    sleep 1
  } | timeout 15 deno run --allow-net=127.0.0.1:5433 --allow-read=.,../context-layer-reference --allow-env main.ts 2>/dev/null \
    | jq -r 'select(.id==2) | .result.content[0].text'
}

echo "--- 1. Agent proposes 'hermes' ---"
OUT=$(call_gateway memory_propose "{\"proposal\":$(propose hermes)}")
echo "$OUT" | grep -q pending_validation || { echo "FAIL: propose: $OUT"; exit 1; }
echo "  queued: $(echo "$OUT" | jq -r .proposal_id)"

echo "--- 2. Reviewer sees it ---"
LIST=$(REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" REVIEWER_PRINCIPAL="urn:user:dtdubs" \
  deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault/capture ../vault/review.ts list)
echo "$LIST" | grep -q "$RUN_ID-hermes" || { echo "FAIL: list does not show proposal"; echo "$LIST"; exit 1; }
echo "$LIST" | grep -q "x.verified.handle=.*hermes" || { echo "FAIL: list missing claim"; echo "$LIST"; exit 1; }
echo "  listed ok"

echo "--- 3. Reviewer approves ---"
APP=$(REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" REVIEWER_PRINCIPAL="urn:user:dtdubs" \
  deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault/capture ../vault/review.ts approve "urn:cl:proposal:$RUN_ID-hermes")
echo "  $APP"
echo "$APP" | grep -q "committed" || { echo "FAIL: approve"; exit 1; }

echo "--- 4. Gateway serves the committed claim ---"
REQ=$(jq -n -c --arg now "$NOW" --arg later "$LATER" --arg id "urn:cl:request:$RUN_ID" --arg sub "$SUBJECT" '{
  spec_version: "context-layer/0.2-draft", type: "context_request", id: $id, created_at: $now,
  issuer: {id: "urn:agent:test"}, subject_ref: $sub,
  requester: {principal: "urn:agent:test", authenticated_by: "local", client_instance: "test"},
  recipient: {principal: "urn:model:test", onward_disclosure: "allowed"},
  purpose_code: "x.test.read", purpose: "test", task: {kind: "test", user_visible: true},
  selectors: [{predicate: "x.verified.handle"}], requested_actions: [],
  retention: {mode: "ephemeral", max_seconds: 3600}, receipt_requirement: {level: "operation", required: true},
  expires_at: $later
}')
BUNDLE=$(call_gateway context_request "{\"request\":$REQ}")
VAL=$(echo "$BUNDLE" | jq -r '.bundle.context[0].value')
echo "  gateway returned: $VAL"
[ "$VAL" = "hermes" ] || { echo "FAIL: wrong value: $BUNDLE"; exit 1; }

echo "--- 5. Double-approve is rejected ---"
DBL=$(REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" REVIEWER_PRINCIPAL="urn:user:dtdubs" \
  deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault/capture ../vault/review.ts approve "urn:cl:proposal:$RUN_ID-hermes" 2>&1) && { echo "FAIL: double approve succeeded"; exit 1; }
echo "$DBL" | grep -q -E "already committed|is committed" || { echo "FAIL: unexpected double-approve error: $DBL"; exit 1; }
echo "  rejected: $DBL"

echo "--- 6. Contradicting proposal supersedes ---"
OUT=$(call_gateway memory_propose "{\"proposal\":$(propose claptrap)}")
echo "$OUT" | grep -q pending_validation || { echo "FAIL: propose 2"; exit 1; }
APP2=$(REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" REVIEWER_PRINCIPAL="urn:user:dtdubs" \
  deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault/capture ../vault/review.ts approve "urn:cl:proposal:$RUN_ID-claptrap")
echo "$APP2" | grep -q "committed" || { echo "FAIL: approve 2"; exit 1; }
BUNDLE2=$(call_gateway context_request "{\"request\":$REQ}")
VAL2=$(echo "$BUNDLE2" | jq -r '.bundle.context[0].value')
echo "  gateway now returns: $VAL2"
[ "$VAL2" = "claptrap" ] || { echo "FAIL: supersede not served"; exit 1; }

echo "--- 7. Reject path ---"
OUT=$(call_gateway memory_propose "{\"proposal\":$(propose bogus)}")
echo "$OUT" | grep -q pending_validation || { echo "FAIL: propose 3"; exit 1; }
REJ=$(REVIEWER_DATABASE_URL="$REVIEWER_DATABASE_URL" REVIEWER_PRINCIPAL="urn:user:dtdubs" \
  deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=.,../vault/capture ../vault/review.ts reject "urn:cl:proposal:$RUN_ID-bogus" --reason "smoke reject")
echo "  $REJ"
echo "$REJ" | grep -q "rejected" || { echo "FAIL: reject"; exit 1; }
echo "$REJ" | grep -q "0 claim(s)" || { echo "FAIL: reject reported nonzero claims"; exit 1; }
# Rejection must commit ZERO claims -- the exact bug where reject wrote claims.
cat <<SQL | deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /tmp/reject_claims.json
SELECT count(*) as n FROM claims WHERE subject_ref = '$SUBJECT' AND predicate = 'x.verified.handle' AND value @> '"bogus"';
SQL
N=$(jq -r '.[0].n' /tmp/reject_claims.json)
echo "  claims committed by reject: $N"
[ "$N" = "0" ] || { echo "FAIL: reject committed claims"; exit 1; }
# Hook: approved claims must be embedded INLINE (no separate embed run).
cat <<SQL | deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /tmp/emb_check.json
SELECT count(*) as n FROM claims WHERE subject_ref = '$SUBJECT' AND predicate = 'x.verified.handle' AND embedding IS NULL;
SQL
UNEMB=$(jq -r '.[0].n' /tmp/emb_check.json)
echo "  approved claims missing embedding: $UNEMB"
[ "$UNEMB" = "0" ] || { echo "FAIL: inline embed missing on approved claims"; exit 1; }
cat <<SQL | deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts > /dev/null
SELECT 1 FROM proposals WHERE id = 'urn:cl:proposal:$RUN_ID-bogus' AND status = 'rejected';
SQL

echo "REVIEW SMOKE OK"
