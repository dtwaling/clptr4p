#!/usr/bin/env bash
# clptr4p vault restore / import.
#
#   scripts/vault_restore.sh --list <backup.tar.gz.enc>
#       Decrypt, verify digest, show manifest and per-table row counts
#       (restored into a scratch DB, then dropped). No writes to the vault.
#
#   scripts/vault_restore.sh --add <backup.tar.gz.enc>
#       Merge the backup into the LIVE vault, non-destructively: rows missing
#       here are inserted (ON CONFLICT DO NOTHING), rows already present keep
#       their live values. Backup policies import INACTIVE, so the live active
#       policy stays active and the one-active invariant holds. Embeddings
#       ride along in the dump. For vault-to-vault merges or partial recovery.
#
#   scripts/vault_restore.sh --replace <backup.tar.gz.enc>
#       Destructive: rename the live DB aside, restore the dump into a fresh
#       DB, re-run migrations, drop the old DB only on success. If the
#       backup's .env differs from the current one (fresh machine), prints
#       exactly how to align the login-role passwords (they are cluster-level
#       and NOT carried by a pg_dump; the backup ships env.txt for this).
#
# Passphrase: VAULT_BACKUP_PASSPHRASE if set, else VAULT_DEK.
# A backup contains vault secrets: handle decrypted files as 0600 material.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_DIR="$SCRIPT_DIR/../vault"

MODE=""
BACKUP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list|--add|--replace) MODE="$1"; BACKUP="${2:-}"; shift 2 ;;
    *) echo "usage: $0 --list|--add|--replace <backup.tar.gz.enc>" >&2; exit 1 ;;
  esac
done
# Resolve the backup path against the CALLER's cwd, then move to vault/.
[ -n "$MODE" ] || { echo "usage: $0 --list|--add|--replace <backup.tar.gz.enc>" >&2; exit 1; }
[ -f "$BACKUP" ] || { echo "usage: $0 --list|--add|--replace <backup.tar.gz.enc>  (got: ${BACKUP:-<none>})" >&2; exit 1; }
BACKUP="$(cd "$(dirname "$BACKUP")" && pwd)/$(basename "$BACKUP")"
cd "$VAULT_DIR"
[ -f .env ] || { echo "error: vault/.env not found"; exit 1; }
set -a; . ./.env; set +a
: "${POSTGRES_USER:?}"; : "${POSTGRES_DB:?}"; : "${VAULT_DEK:?}"

# -- decrypt + verify -------------------------------------------------------
# openssl reads the passphrase from this env var; apply the same DEK fallback
# vault_backup.sh uses (only when the operator did not set an independent one).
export VAULT_BACKUP_PASSPHRASE="${VAULT_BACKUP_PASSPHRASE:-$VAULT_DEK}"
SIDE="${BACKUP}.sha256"
if [ -f "$SIDE" ]; then
  sha256sum -c "$SIDE" >/dev/null 2>&1 \
    || { echo "error: sha256 mismatch for $BACKUP -- do not trust this backup"; exit 1; }
else
  echo "note: no .sha256 sidecar for $BACKUP; skipping integrity check"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in "$BACKUP" -out "$TMP/backup.tar.gz" -pass env:VAULT_BACKUP_PASSPHRASE 2>/dev/null \
  || { echo "error: decrypt failed (wrong passphrase?)"; exit 1; }
tar -xzf "$TMP/backup.tar.gz" -C "$TMP"
DUMP=$(find "$TMP" -name vault.pgdump | head -1)
ENV_TXT=$(find "$TMP" -name env.txt | head -1)
MANIFEST=$(find "$TMP" -name manifest.json | head -1)
[ -n "$DUMP" ] || { echo "error: no vault.pgdump inside the backup"; exit 1; }

# -- helpers -----------------------------------------------------------------
# Load the dump into a scratch DB on the cluster (admin creds, no privileges).
# The dump file lives on the HOST; pg_restore runs in the container, so the
# dump is piped via stdin (pg_restore reads custom format from stdin when no
# input file is given).
load_scratch() { # $1 = target db name
  docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS $1;" -c "CREATE DATABASE $1;" >/dev/null
  docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-privileges < "$DUMP" >/dev/null
}
drop_scratch() { # $1 = db name
  docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS $1;" >/dev/null
}

# -- modes -------------------------------------------------------------------
case "$MODE" in
  --list)
    echo "manifest: $(cat "$MANIFEST" 2>/dev/null || echo '(none)')"
    load_scratch restore_peek
    echo "row counts inside the dump:"
    for t in claims source_events policies proposals decisions bundles receipts identity_bindings claim_sources schema_migrations; do
      N=$(docker compose exec -T db psql -U "$POSTGRES_USER" -d restore_peek -t -A -c "SELECT count(*) FROM $t;" 2>/dev/null || echo "?")
      echo "  $t: $N"
    done
    drop_scratch restore_peek
    ;;

  --add)
    echo "merging backup into the live vault (non-destructive; conflicts keep live values)..."
    load_scratch restore_src \
      || { echo "error: could not load backup into scratch DB"; drop_scratch restore_src; exit 1; }

    # SQL file, not a pipe (repo convention). postgres_fdw: the dump lives in
    # another DATABASE on the same cluster, so plain schema-qualified names
    # do not reach it -- and FDW foreign tables would clash with local names,
    # so they import into a dedicated schema.
    cat > "$TMP/merge.sql" <<'SQL'
BEGIN;
DROP SCHEMA IF EXISTS restore_src CASCADE;
CREATE SCHEMA restore_src;
CREATE EXTENSION IF NOT EXISTS postgres_fdw;
DROP SERVER IF EXISTS restore_src_server CASCADE;
CREATE SERVER restore_src_server FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (dbname 'restore_src', host 'localhost', port '5432');
-- FDW requires an explicit user mapping for the connecting role.
CREATE USER MAPPING FOR clptr4p_admin SERVER restore_src_server
  OPTIONS (user 'clptr4p_admin', password :'fdw_password');
IMPORT FOREIGN SCHEMA public FROM SERVER restore_src_server INTO restore_src;

INSERT INTO source_events (id, subject_ref, origin, actor, occurred_at, captured_at, visibility, payload_digest, payload_encrypted)
SELECT id, subject_ref, origin, actor, occurred_at, captured_at, visibility, payload_digest, payload_encrypted
FROM restore_src.source_events
ON CONFLICT (id) DO NOTHING;

INSERT INTO claims (id, subject_ref, predicate, claim, value, datatype, confidence, valid_from, valid_to, superseded_by, embedding, created_at, injection_tier)
SELECT id, subject_ref, predicate, claim, value, datatype, confidence, valid_from, valid_to, superseded_by, embedding, created_at, injection_tier
FROM restore_src.claims
ON CONFLICT (id) DO NOTHING;

INSERT INTO claim_sources (claim_id, source_event_id)
SELECT claim_id, source_event_id FROM restore_src.claim_sources
ON CONFLICT DO NOTHING;

-- Policies arrive INACTIVE: the live active policy stays active.
INSERT INTO policies (id, version, issuer, policy_json, active, created_at)
SELECT id, version, issuer, policy_json, false, created_at
FROM restore_src.policies
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity_bindings (principal, subject_ref, auth_method, created_at)
SELECT principal, subject_ref, auth_method, created_at FROM restore_src.identity_bindings
ON CONFLICT (principal) DO NOTHING;

INSERT INTO proposals (id, subject_ref, status, proposal_json, reviewed_at, reviewer, created_at, proposed_tier)
SELECT id, subject_ref, status, proposal_json, reviewed_at, reviewer, created_at, proposed_tier
FROM restore_src.proposals
ON CONFLICT (id) DO NOTHING;

INSERT INTO decisions (id, request_ref, decision, reason_codes, decision_json, created_at)
SELECT id, request_ref, decision, reason_codes, decision_json, created_at
FROM restore_src.decisions
ON CONFLICT (id) DO NOTHING;

INSERT INTO bundles (id, request_ref, decision_ref, recipient, capabilities, expires_at, single_use, consumed_at, request_json, decision_json, bundle_json, created_at)
SELECT id, request_ref, decision_ref, recipient, capabilities, expires_at, single_use, consumed_at, request_json, decision_json, bundle_json, created_at
FROM restore_src.bundles
ON CONFLICT (id) DO NOTHING;

-- receipts are append-only: ON CONFLICT DO NOTHING skips duplicates without
-- firing the no-UPDATE/DELETE trigger (that trigger only guards UPDATE/DELETE).
INSERT INTO receipts (id, operation, actor, request_ref, decision_ref, bundle_ref, outcome, input_digest, output_digest, receipt_json, created_at)
SELECT id, operation, actor, request_ref, decision_ref, bundle_ref, outcome, input_digest, output_digest, receipt_json, created_at
FROM restore_src.receipts
ON CONFLICT (id) DO NOTHING;

-- schema_migrations: record migrations the backup applied that this vault
-- lacks (a live vault that is AHEAD keeps its own rows).
INSERT INTO schema_migrations (version, applied_at)
SELECT version, applied_at FROM restore_src.schema_migrations
ON CONFLICT (version) DO NOTHING;

DROP SCHEMA restore_src CASCADE;
DROP SERVER IF EXISTS restore_src_server CASCADE;
COMMIT;
SQL
    # Run the merge with ON_ERROR_STOP so a failed statement actually fails
    # the script (psql without it reports errors but exits 0). The admin
    # password reaches psql via env -> -v fdw_password variable substitution
    # (:'fdw_password' in the SQL), never in the SQL text itself.
    if ! docker compose exec -T \
      -e PGPASSWORD="$POSTGRES_PASSWORD" \
      -e FDW_PASSWORD="$POSTGRES_PASSWORD" \
      -e PGUSER="$POSTGRES_USER" \
      -e PGDATABASE="$POSTGRES_DB" \
      db bash -c 'psql -v ON_ERROR_STOP=1 -v fdw_password="$FDW_PASSWORD" -f /dev/stdin' < "$TMP/merge.sql" > "$TMP/merge.log" 2>&1; then
      echo "error: merge transaction failed (rolled back; vault untouched):"
      grep -E "ERROR|DETAIL" "$TMP/merge.log" | head -5 | sed 's/^/  /'
      drop_scratch restore_src
      exit 1
    fi
    drop_scratch restore_src

    echo "merge OK. Live row counts:"
    docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -F' ' -c \
      "SELECT t || ': ' || n FROM (SELECT 'claims' t, count(*) n FROM claims UNION ALL SELECT 'source_events', count(*) FROM source_events UNION ALL SELECT 'policies', count(*) FROM policies) x ORDER BY t;" \
      | while read -r line; do echo "  $line"; done
    ;;

  --replace)
    echo "RESTORE MODE: --replace is DESTRUCTIVE to database $POSTGRES_DB."
    echo "  Live DB is renamed aside; the dump is restored into a fresh DB;"
    echo "  migrations are re-applied; the old DB is dropped only on success."
    read -r -p "Type 'replace' to confirm: " confirm
    [ "$confirm" = "replace" ] || { echo "aborted"; exit 1; }

    # Load dump into a scratch DB first: verify it restores cleanly BEFORE
    # touching the live database.
    load_scratch restore_check \
      || { echo "error: backup does not restore cleanly -- live vault untouched"; drop_scratch restore_check; exit 1; }
    DUMP_TABLES=$(docker compose exec -T db psql -U "$POSTGRES_USER" -d restore_check -t -A -c \
      "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';")
    drop_scratch restore_check
    LIVE_TABLES=$(docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c \
      "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';")
    if [ -n "${DUMP_TABLES:-}" ] && [ "$LIVE_TABLES" != "$DUMP_TABLES" ]; then
      echo "warning: live tables [$LIVE_TABLES] != dump tables [$DUMP_TABLES]"
      echo "  --replace rebuilds only what the dump contains; extra live tables are lost."
      read -r -p "Continue anyway? Type 'replace': " c2
      [ "$c2" = "replace" ] || { echo " aborted"; exit 1; }
    fi

    # Kick active connections out of the live DB (the gateway holds a pool);
    # they reconnect against whichever database then exists.
    docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres -t -A -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();" >/dev/null
    docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS ${POSTGRES_DB}_old;" >/dev/null
    if ! docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
      -v ON_ERROR_STOP=1 -c "ALTER DATABASE $POSTGRES_DB RENAME TO ${POSTGRES_DB}_old" >/dev/null 2>&1; then
      echo "error: could not rename live DB aside (active sessions?) -- aborting"
      exit 1
    fi
    docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
      -c "CREATE DATABASE $POSTGRES_DB;" >/dev/null
    if ! docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner < "$DUMP" >/dev/null 2>&1; then
      echo "error: pg_restore failed -- rolling back to the pre-restore database"
      docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
        -c "DROP DATABASE $POSTGRES_DB;" \
        -c "ALTER DATABASE ${POSTGRES_DB}_old RENAME TO $POSTGRES_DB;" >/dev/null
      exit 1
    fi
    # Re-apply any migrations newer than the dump (idempotent; also records
    # schema_migrations rows the dump already had).
    DENO="${CLPTR4P_DENO:-$HOME/.deno/bin/deno}"
    if ! "$DENO" run --allow-net=127.0.0.1:5433 --allow-env --allow-read=. migrate.ts; then
      echo "warn: migrate.ts failed post-restore; check vault/.env -- schema_migrations may be stale"
    fi
    docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS ${POSTGRES_DB}_old;" >/dev/null

    if [ -n "${ENV_TXT:-}" ] && ! diff -q "$ENV_TXT" .env >/dev/null 2>&1; then
      echo
      echo "NOTE: the backup's .env differs from the current vault/.env."
      echo "  Login-role passwords are CLUSTER-level and not carried by the"
      echo "  dump; gateway/capture/reviewer roles may fail auth until aligned:"
      echo "    1. adopt the backup secrets:  cp $TMP/*/env.txt .env   (path shown post-run)"
      echo "    2. or keep current secrets and ALTER ROLE ... PASSWORD to match"
      echo "  The restored database itself is live either way."
    fi
    echo "replace OK: $POSTGRES_DB rebuilt from $(basename "$BACKUP")"
    ;;
esac
