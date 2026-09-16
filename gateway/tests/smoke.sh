#!/usr/bin/env bash
# End-to-end stdio smoke test: allow -> act -> replay-rejected -> propose.
# Uses the reference fixture's permissive policy so the allow path is reachable.
set -euo pipefail
cd "$(dirname "$0")/.."

REF=../context-layer-reference
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LATER=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
REQ=$(jq -c --arg now "$NOW" --arg later "$LATER" '.request | .created_at=$now | .expires_at=$later' "$REF/valid-exchange.json")
PROPOSAL=$(jq -c '.' "$REF/valid-memory-update-proposal.json")
POLICY_FILE=$(mktemp)
CLAIMS_FILE=$(mktemp)
jq '.policy' "$REF/valid-exchange.json" > "$POLICY_FILE"
jq '{(.request.subject_ref): .claims}' "$REF/valid-exchange.json" > "$CLAIMS_FILE"
trap 'rm -f "$POLICY_FILE" "$CLAIMS_FILE"' EXIT

run_gateway() {
  # Force the lite backend regardless of ambient env.
  env -u GATEWAY_DATABASE_URL \
    CLPTR4P_POLICY_FILE="$POLICY_FILE" CLPTR4P_CLAIMS_FILE="$CLAIMS_FILE" timeout 15 deno run \
    --allow-read=.,"$REF","$POLICY_FILE","$CLAIMS_FILE" --allow-write=../vault/data --allow-env main.ts 2>/dev/null
}

rpc() { printf '%s\n' "$1"; }

# Phase 1: request a bundle, capture its id.
OUT1=$( {
  rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
  rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context_request\",\"arguments\":{\"request\":$REQ}}}"
  sleep 1
} | run_gateway )

BUNDLE_ID=$(printf '%s\n' "$OUT1" | jq -r 'select(.id==2) | .result.content[0].text | fromjson | .bundle.id')
DECISION=$(printf '%s\n' "$OUT1" | jq -r 'select(.id==2) | .result.content[0].text | fromjson | .receipt.operation')
echo "phase1 decision-op=$DECISION bundle=$BUNDLE_ID"
[ "$DECISION" = "bundle.issue" ] || { echo "FAIL: expected bundle.issue"; exit 1; }

# Phase 2: same process must hold the bundle (in-memory store), so run the full
# sequence in one session: request -> act -> replay -> ungranted -> propose.
OUT2=$( {
  rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
  rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context_request\",\"arguments\":{\"request\":$REQ}}}"
  sleep 0.5
  rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"context_act\",\"arguments\":{\"bundle_id\":\"$BUNDLE_ID\",\"action\":\"model.generate_text\"}}}"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"context_act\",\"arguments\":{\"bundle_id\":\"$BUNDLE_ID\",\"action\":\"model.generate_text\"}}}"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"context_act\",\"arguments\":{\"bundle_id\":\"$BUNDLE_ID\",\"action\":\"email.send\"}}}"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_propose\",\"arguments\":{\"proposal\":$PROPOSAL}}}"
  sleep 1
} | run_gateway )

get() { printf '%s\n' "$OUT2" | jq -r "select(.id==$1) | .result.content[0].text"; }
iserr() { printf '%s\n' "$OUT2" | jq -r "select(.id==$1) | .result.isError // false"; }

ACT_OP=$(get 3 | jq -r '.receipt.operation')
echo "phase2 act        -> op=$ACT_OP isError=$(iserr 3)"
echo "phase2 replay     -> $(get 4) isError=$(iserr 4)"
echo "phase2 ungranted  -> $(get 5) isError=$(iserr 5)"
echo "phase2 propose    -> $(get 6 | jq -c .) isError=$(iserr 6)"

[ "$ACT_OP" = "model.generate_text" ] || { echo "FAIL: act"; exit 1; }
[ "$(iserr 4)" = "true" ] && get 4 | grep -q BUNDLE_ALREADY_CONSUMED || { echo "FAIL: replay not rejected"; exit 1; }
[ "$(iserr 5)" = "true" ] && get 5 | grep -q -E 'BUNDLE_ALREADY_CONSUMED|ACTION_NOT_GRANTED' || { echo "FAIL: ungranted not rejected"; exit 1; }
[ "$(iserr 6)" = "false" ] && get 6 | grep -q pending_validation || { echo "FAIL: propose"; exit 1; }

echo "SMOKE OK"
