#!/usr/bin/env bash
# Test prefetchCoreOnly behavior and non-core fail-closed invariant.
set -euo pipefail
cd "$(dirname "$0")/.."

REF=../context-layer-reference
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LATER=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
REQ=$(jq -c --arg now "$NOW" --arg later "$LATER" '.request | .created_at=$now | .expires_at=$later' "$REF/valid-exchange.json")
POLICY_FILE=$(mktemp)
CLAIMS_FILE=$(mktemp)
jq '.policy' "$REF/valid-exchange.json" > "$POLICY_FILE"

# Provide ONE granted claim but omit the other ('requesting_stakeholder')
cat << 'JSON' > "$CLAIMS_FILE"
{
  "vault://subjects/primary": [
    {
      "claim": "the launch timeline was requested by Friday.",
      "predicate": "requested_delivery_date",
      "value": "2026-08-14",
      "confidence": 0.93,
      "provenance_handles": ["prov_delivery"]
    }
  ]
}
JSON

cleanup() {
  rm -f "$POLICY_FILE" "$CLAIMS_FILE"
}
trap cleanup EXIT

run_gateway() {
  env -u GATEWAY_DATABASE_URL \
    CLPTR4P_POLICY_FILE="$POLICY_FILE" CLPTR4P_CLAIMS_FILE="$CLAIMS_FILE" timeout 15 deno run \
    --allow-read=.,"$REF","$POLICY_FILE","$CLAIMS_FILE",../vault/data --allow-write=../vault/data --allow-env main.ts 2>/dev/null
}

rpc() { printf '%s\n' "$1"; }

# Clear audit log for clean test
> ../vault/data/decisions.jsonl

# Test 1: prefetchCoreOnly = false (default). Should fail closed because 'requesting_stakeholder' is missing.
OUT1=$( {
  rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
  rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context_request\",\"arguments\":{\"request\":$REQ}}}"
  sleep 1
} | run_gateway )

ERR1=$(printf '%s\n' "$OUT1" | jq -r 'select(.id==2) | .result.content[0].text')
IS_ERR1=$(printf '%s\n' "$OUT1" | jq -r 'select(.id==2) | .result.isError // false')

echo "Test 1 (non-core): isError=$IS_ERR1"
if [ "$IS_ERR1" != "true" ]; then
  echo "FAIL: expected non-core request to fail closed when claims are missing"
  exit 1
fi
if ! echo "$ERR1" | grep -q "no claim was supplied for granted predicate"; then
  echo "FAIL: expected 'no claim was supplied' error message"
  exit 1
fi

# Test 2: prefetchCoreOnly = true. Should skip missing claims and return allow_with_reductions.
OUT2=$( {
  rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
  rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context_request\",\"arguments\":{\"request\":$REQ,\"prefetch_core_only\":true}}}"
  sleep 1
} | run_gateway )

IS_ERR2=$(printf '%s\n' "$OUT2" | jq -r 'select(.id==2) | .result.isError // false')

echo "Test 2 (prefetchCoreOnly): isError=$IS_ERR2"
if [ "$IS_ERR2" = "true" ]; then
  echo "FAIL: expected prefetchCoreOnly to succeed despite missing claims"
  exit 1
fi

# Verify audit log recorded the mutated decision
DECISION_AUDIT=$(tail -n 1 ../vault/data/decisions.jsonl | jq -r '.record.decision')
REDACTED=$(tail -n 1 ../vault/data/decisions.jsonl | jq -r '.record.transform_requirements[] | select(. == "redact:requesting_stakeholder")' || echo "none")

echo "Audit check: decision=$DECISION_AUDIT redacted=$REDACTED"
if [ "$DECISION_AUDIT" != "allow_with_reductions" ]; then
  echo "FAIL: expected audit decision to be allow_with_reductions, got $DECISION_AUDIT"
  exit 1
fi
if [ "$REDACTED" != "redact:requesting_stakeholder" ]; then
  echo "FAIL: expected redact:requesting_stakeholder in audit transform_requirements"
  exit 1
fi

echo "SMOKE PREFETCH OK"
