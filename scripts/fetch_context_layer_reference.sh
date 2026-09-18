#!/usr/bin/env bash
# Fetch/refresh the Sierra Catalina Context Layer reference implementation +
# schemas from upstream, checksum-pinned.
#
# The reference IS vendored in this repository (see VENDORED.md for provenance
# and permission basis). Use this script to pull upstream updates: it fails
# loudly on checksum mismatch so changes get reviewed before they land.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/context-layer-reference"
BASE="https://sierracatalina.com/context-layer/implementation"
FILES=(
  "context-layer-reference.mjs"
  "context-request.schema.json"
  "memory-update-proposal.schema.json"
  "policy-decision.schema.json"
  "receipt.schema.json"
  "scoped-context-bundle.schema.json"
  "valid-exchange.json"
  "valid-memory-update-proposal.json"
  "valid-policy-decision.json"
)

declare -A SHA256=(
  ["context-layer-reference.mjs"]="fb53d3095ca358512a5dce0af4a76fb3f65cee6417181e3a2b79e10aec41205e"
  ["context-request.schema.json"]="e3d7f226208d73a0a3bde4d1a03a9e0590f5816b2fe15bc741f6c05e3bc3237f"
  ["memory-update-proposal.schema.json"]="76b209476a533c4c5819090a881eaacce2cefe00e71b88044fa53e5f42006035"
  ["policy-decision.schema.json"]="b39bace9af7ca80ada0fb06d4f45e97cba6ee123822eee5534bdf2e901bd0b4a"
  ["receipt.schema.json"]="26386ed05c6ba858b70f1f8f3a92590c4336a84b5a7791d6a19a6f2b031f296f"
  ["scoped-context-bundle.schema.json"]="d5462f71928021b03236dcdfa02450276c4981d5de583070292d92841efa8f38"
  ["valid-exchange.json"]="6413978df9af1c5b777362e3ac83371486731c75f66152bfe0aa79b4f4dbc95b"
  ["valid-memory-update-proposal.json"]="9bd0c1746b7a209b73d9ef7b5c6239b536cec234089b46b970c4ad34b73fccb9"
  ["valid-policy-decision.json"]="9ee9c49035c2d0f0ca60fa561d0b13cd790b147ec391ca2c8129e19b67863e41"
)

mkdir -p "$DIR"
for f in "${FILES[@]}"; do
  out="$DIR/$f"
  if [ -f "$out" ]; then
    echo "have  $f"
    continue
  fi
  echo "fetch $f"
  curl -fsSL "$BASE/$f" -o "$out"
done

# Verify pinned checksums (fail loudly if upstream drifted).
fail=0
for f in "${!SHA256[@]}"; do
  actual=$(sha256sum "$DIR/$f" | cut -d' ' -f1)
  if [ "$actual" != "${SHA256[$f]}" ]; then
    echo "CHECKSUM MISMATCH for $f:" >&2
    echo "  expected ${SHA256[$f]}" >&2
    echo "  actual   $actual" >&2
    echo "Upstream changed -- review the diff, then update this script." >&2
    fail=1
  fi
done
[ "$fail" = 0 ] || exit 1

echo "context-layer reference ready: $DIR"
