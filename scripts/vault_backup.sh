#!/usr/bin/env bash
# clptr4p vault backup.
#
#   scripts/vault_backup.sh [--keep N] [--out DIR]
#
# Produces vault/backups/clptr4p-vault-<ts>.tar.gz.enc (+ .sha256 sidecar):
#   vault.pgdump  -- pg_dump custom format (schema + data + embeddings,
#                   loopback container, already compressed internally)
#   env.txt       -- copy of vault/.env (login roles are cluster-level, NOT in
#                   a pg_dump; without this the backup cannot restore the
#                   role passwords or the DEK)
#   manifest.json -- provenance: timestamp, pg version, dump digest
# The tar.gz is encrypted with openssl AES-256-CBC + PBKDF2 (600k iters).
#
# Passphrase: VAULT_BACKUP_PASSPHRASE if set, else VAULT_DEK. With the DEK
# fallback the backup is only decryptable where vault/.env still exists --
# for off-machine disaster recovery set an independent
# VAULT_BACKUP_PASSPHRASE (see docs/SETUP.md).
#
# --keep N keeps only the newest N backups (default 30, 0 = keep all).
# Backups contain vault secrets: keep the destination 0600 and private.
set -euo pipefail
cd "$(dirname "$0")/../vault"

KEEP=30
OUT=backups
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2 ;;
    --out)  OUT="$2"; shift 2 ;;
    *) echo "usage: $0 [--keep N] [--out DIR]" >&2; exit 1 ;;
  esac
done

[ -f .env ] || { echo "error: vault/.env not found (run from a configured vault)"; exit 1; }
set -a; . ./.env; set +a
: "${POSTGRES_USER:?POSTGRES_USER missing}"
: "${POSTGRES_DB:?POSTGRES_DB missing}"
: "${VAULT_DEK:?VAULT_DEK missing}"

docker compose ps db 2>/dev/null | grep -q "healthy\|Up" || { echo "error: vault db container not running (docker compose up -d --wait)"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME="clptr4p-vault-$TS"
STAGE="$TMP/$NAME"
mkdir -p "$STAGE" "$OUT"

# 1. Dump (custom format) straight from the container.
docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" -Fc > "$STAGE/vault.pgdump"
[ -s "$STAGE/vault.pgdump" ] || { echo "error: pg_dump produced no data"; exit 1; }

# 2. The .env (role passwords + DEK) so the backup is self-sufficient.
cp .env "$STAGE/env.txt"
chmod 600 "$STAGE/env.txt"

# 3. Manifest.
PGV=$(docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "SHOW server_version;")
DUMP_SHA=$(sha256sum "$STAGE/vault.pgdump" | cut -d' ' -f1)
DUMP_BYTES=$(stat -c%s "$STAGE/vault.pgdump")
PASS_SRC="VAULT_DEK (fallback)"
[ -n "${VAULT_BACKUP_PASSPHRASE:-}" ] && PASS_SRC="VAULT_BACKUP_PASSPHRASE"
cat > "$STAGE/manifest.json" <<EOF
{
  "tool": "scripts/vault_backup.sh",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pg_version": "$PGV",
  "dump_bytes": $DUMP_BYTES,
  "dump_sha256": "$DUMP_SHA",
  "passphrase_source": "$PASS_SRC"
}
EOF

# 4. Zip + encrypt + digest.
tar -czf "$TMP/$NAME.tar.gz" -C "$TMP" "$NAME"
export VAULT_BACKUP_PASSPHRASE="${VAULT_BACKUP_PASSPHRASE:-$VAULT_DEK}"
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$TMP/$NAME.tar.gz" -out "$OUT/$NAME.tar.gz.enc" \
  -pass env:VAULT_BACKUP_PASSPHRASE
sha256sum "$OUT/$NAME.tar.gz.enc" > "$OUT/$NAME.tar.gz.enc.sha256"
chmod 600 "$OUT/$NAME.tar.gz.enc" "$OUT/$NAME.tar.gz.enc.sha256"

# 5. Prune to the newest KEEP (sidecar removed with its backup).
if [ "$KEEP" -gt 0 ]; then
  ls -1t "$OUT"/clptr4p-vault-*.tar.gz.enc 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" "$old.sha256"
  done
fi

ENC_BYTES=$(stat -c%s "$OUT/$NAME.tar.gz.enc")
echo "backup OK: $OUT/$NAME.tar.gz.enc ($ENC_BYTES bytes, dump $DUMP_BYTES bytes)"
echo "  pg $PGV | passphrase: $PASS_SRC | kept: $(ls -1 "$OUT"/clptr4p-vault-*.tar.gz.enc | wc -l) backup(s)"
