#!/usr/bin/env bash
# Postgres end-to-end smoke with restart durability.
#   1. seed permissive policy + claims via ADMIN (DATABASE_URL)
#   2. gateway A (GATEWAY_DATABASE_URL): request -> act
#   3. gateway B (fresh process): replay must be BUNDLE_ALREADY_CONSUMED from DB
#   4. restore deny-all policy
# Requires vault/.env sourced (DATABASE_URL, GATEWAY_DATABASE_URL).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?source vault/.env first}"
: "${GATEWAY_DATABASE_URL:?source vault/.env first}"

REF=../context-layer-reference
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LATER=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
# Fresh request id per run: bundle ids are deterministic digests, so a repeated
# request id would (correctly) collide with a previously persisted bundle.
RUN_ID="smoke-$(date -u +%s)"
REQ=$(jq -c --arg now "$NOW" --arg later "$LATER" --arg id "urn:cl:request:$RUN_ID" \
  '.request | .id=$id | .created_at=$now | .expires_at=$later' "$REF/valid-exchange.json")
SUBJECT=$(jq -r '.request.subject_ref' "$REF/valid-exchange.json")
POLICY=$(jq -c '.policy' "$REF/valid-exchange.json")

admin_sql() { deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/psql.ts; }

seed() {
  # Real SQL heredoc fed via stdin of the deno script above.
  cat <<SQL | admin_sql
BEGIN;
UPDATE policies SET active = false;
INSERT INTO policies (id, version, issuer, policy_json, active)
VALUES ('urn:cl:policy:smoke', 'smoke/1', 'urn:cl:policy-engine:local', '$POLICY'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET policy_json = EXCLUDED.policy_json, active = true;
DELETE FROM claims WHERE subject_ref = '$SUBJECT';
INSERT INTO claims (id, subject_ref, predicate, claim, value, confidence) VALUES
  ('urn:cl:claim:smoke-delivery', '$SUBJECT', 'requested_delivery_date', 'the launch timeline was requested by Friday.', '2026-08-14', 0.93),
  ('urn:cl:claim:smoke-stakeholder', '$SUBJECT', 'requesting_stakeholder', 'the request came from the launch lead.', 'launch lead', 0.98),
  ('urn:cl:claim:smoke-budget', '$SUBJECT', 'budget_delta', 'the internal budget delta is restricted.', 'synthetic restricted amount', 0.99);
COMMIT;
SQL
}

restore() {
  cat <<SQL | admin_sql
BEGIN;
UPDATE policies SET active = false;
UPDATE policies SET active = true WHERE id = 'urn:cl:policy:default-deny';
COMMIT;
SQL
}
trap restore EXIT

run_gateway() {
  timeout 20 deno run --allow-net=127.0.0.1:5433 --allow-read=.,"$REF" --allow-env main.ts 2>/dev/null
}
rpc() { printf '%s\n' "$1"; }
init() {
  rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
  rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}'
}

echo "seeding permissive policy + claims"
seed

echo "gateway A: request -> act"
OUT_A=$( { init
  rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context_request\",\"arguments\":{\"request\":$REQ}}}"
  sleep 1
} | run_gateway )
BUNDLE_ID=$(printf '%s\n' "$OUT_A" | jq -r 'select(.id==2) | .result.content[0].text | fromjson | .bundle.id')
[ -n "$BUNDLE_ID" ] && [ "$BUNDLE_ID" != "null" ] || { echo "FAIL: no bundle issued"; printf '%s\n' "$OUT_A" | jq -r 'select(.id==2) | .result.content[0].text'; exit 1; }
echo "  bundle=$BUNDLE_ID"

OUT_A2=$( { init
  rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"context_act\",\"arguments\":{\"bundle_id\":\"$BUNDLE_ID\",\"action\":\"model.generate_text\"}}}"
  sleep 1
} | run_gateway )
ACT_OP=$(printf '%s\n' "$OUT_A2" | jq -r 'select(.id==3) | .result.content[0].text | fromjson | .receipt.operation')
echo "  act op=$ACT_OP"
[ "$ACT_OP" = "model.generate_text" ] || { echo "FAIL: act (bundle issued in A, consumed in fresh process -> durability of issue)"; exit 1; }

echo "gateway B (fresh process): replay must be rejected from DB"
OUT_B=$( { init
  rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"context_act\",\"arguments\":{\"bundle_id\":\"$BUNDLE_ID\",\"action\":\"model.generate_text\"}}}"
  sleep 1
} | run_gateway )
REPLAY=$(printf '%s\n' "$OUT_B" | jq -r 'select(.id==4) | .result.content[0].text')
echo "  replay -> $REPLAY"
grep -q BUNDLE_ALREADY_CONSUMED <<<"$REPLAY" || { echo "FAIL: replay not rejected after restart"; exit 1; }

echo "PG SMOKE OK (issue, consume, and replay-rejection all survived process restarts)"
