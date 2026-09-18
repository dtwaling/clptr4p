#!/usr/bin/env bash
# Policy personal/1 verification: allow / deny / reduction / execute-purpose paths.
# Requires vault/.env sourced.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GATEWAY_DATABASE_URL:?source vault/.env first}"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LATER=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
RUN="polcheck-$(date -u +%s)"

req() { # $1 = suffix, $2 = purpose, $3 = selectors, $4 = actions
  jq -n -c --arg now "$NOW" --arg later "$LATER" --arg id "urn:cl:request:$RUN-$1" --arg pc "$2" \
    --argjson sel "$3" --argjson act "$4" '{
    spec_version: "context-layer/0.2-draft", type: "context_request", id: $id, created_at: $now,
    issuer: {id: "urn:agent:hermes"}, subject_ref: "vault://subjects/primary",
    requester: {principal: "urn:agent:hermes", authenticated_by: "local", client_instance: "urn:device:local-workstation"},
    recipient: {principal: "urn:model:configured", onward_disclosure: "forbidden"},
    purpose_code: $pc, purpose: "draft a response for Dustin", task: {kind: "draft_only", user_visible: true},
    selectors: $sel, requested_actions: $act,
    retention: {mode: "ephemeral", max_seconds: 7200}, receipt_requirement: {level: "operation", required: true},
    expires_at: $later
  }'
}

call() { # $1 = request json -> emits parsed tool result json on stdout
  { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context_request\",\"arguments\":{\"request\":$1}}}"
    sleep 1
  } | timeout 15 deno run --allow-net=127.0.0.1:5433 --allow-read=.,../context-layer-reference --allow-env main.ts 2>/dev/null \
    | jq -r 'select(.id==2) | .result.content[0].text'
}

echo "=== 1. ALLOW: retrieve.context, all granted selectors ==="
OUT=$(call "$(req ok retrieve.context '[{"predicate":"preferred_name"},{"predicate":"comm.style"},{"predicate":"formatting.rule"}]' '[]')")
# Allow path returns {bundle, receipt}; deny/needs_approval return {decision}.
echo "receipt: $(echo "$OUT" | jq -r '.receipt.operation')/$(echo "$OUT" | jq -r '.receipt.outcome')"
echo "$OUT" | jq -r '.bundle.context[] | "  \(.predicate) = \(.value)"'
[ "$(echo "$OUT" | jq -r '.receipt.operation')" = "bundle.issue" ] || { echo "FAIL: expected bundle.issue"; exit 1; }
[ "$(echo "$OUT" | jq -r '.bundle.context | length')" = "3" ] || { echo "FAIL: expected 3 claims"; exit 1; }

echo
echo "=== 2. DENY: purpose not in policy ==="
OUT=$(call "$(req bad 'execute.approved_action' '[{"predicate":"preferred_name"}]' '[]')")
DEC=$(echo "$OUT" | jq -r '.decision.decision')
echo "decision: $DEC  reason: $(echo "$OUT" | jq -r '.decision.reason_codes | join(",")')"
[ "$DEC" = "deny" ] || { echo "FAIL: expected deny"; exit 1; }

echo
echo "=== 3. REDUCTION: granted + ungranted selector mix ==="
OUT=$(call "$(req mix retrieve.context '[{"predicate":"preferred_name"},{"predicate":"salary"}]' '[]')")
echo "receipt: $(echo "$OUT" | jq -r '.receipt.operation')  (reduction still issues a bundle)"
echo "  served: $(echo "$OUT" | jq -r '.bundle.context[0].value')"
[ "$(echo "$OUT" | jq -r '.receipt.operation')" = "bundle.issue" ] || { echo "FAIL: expected bundle.issue"; exit 1; }
[ "$(echo "$OUT" | jq -r '.bundle.context | length')" = "1" ] || { echo "FAIL: should serve only granted"; exit 1; }
[ "$(echo "$OUT" | jq -r '.bundle.context[0].predicate')" = "preferred_name" ] || { echo "FAIL: wrong claim served"; exit 1; }
COUNT_SALARY=$(echo "$OUT" | jq -r '[.bundle.context[] | select(.predicate == "salary")] | length')
[ "$COUNT_SALARY" = "0" ] || { echo "FAIL: salary leaked"; exit 1; }

echo
echo "=== 4. RETENTION capped at policy (7200 -> 3600) ==="
RET=$(echo "$OUT" | jq -r '.bundle.restrictions.retention_seconds')
echo "retention: $RET"
[ "$RET" = "3600" ] || { echo "FAIL: retention not capped"; exit 1; }

echo
echo "=== 5. Onward disclosure forbidden ==="
[ "$(echo "$OUT" | jq -r '.bundle.restrictions.onward_disclosure')" = "forbidden" ] || { echo "FAIL: onward"; exit 1; }
echo "onward: forbidden"

echo "POLICY CHECK OK"
