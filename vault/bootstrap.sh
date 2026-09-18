#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

umask 077

if [ -f .env ]; then
  echo ".env already exists. Refusing to overwrite."
  exit 1
fi

ADMIN_PASS=$(openssl rand -hex 32)
GATEWAY_PASS=$(openssl rand -hex 32)
CAPTURE_PASS=$(openssl rand -hex 32)
REVIEWER_PASS=$(openssl rand -hex 32)
VAULT_DEK=$(openssl rand -hex 32)

cat << ENV > .env
POSTGRES_USER=clptr4p_admin
POSTGRES_PASSWORD=${ADMIN_PASS}
POSTGRES_DB=clptr4p
DB_PORT=5433

# Gateway Role Credentials
GATEWAY_USER=clptr4p_gateway
GATEWAY_PASSWORD=${GATEWAY_PASS}

# Capture Role Credentials
CAPTURE_USER=clptr4p_capture
CAPTURE_PASSWORD=${CAPTURE_PASS}

# Reviewer Role Credentials
REVIEWER_USER=clptr4p_reviewer
REVIEWER_PASSWORD=${REVIEWER_PASS}

# Encryption Key for payload_encrypted and HMACs
VAULT_DEK=${VAULT_DEK}

# Connection strings
DATABASE_URL=postgres://clptr4p_admin:${ADMIN_PASS}@127.0.0.1:5433/clptr4p
GATEWAY_DATABASE_URL=postgres://clptr4p_gateway:${GATEWAY_PASS}@127.0.0.1:5433/clptr4p
CAPTURE_DATABASE_URL=postgres://clptr4p_capture:${CAPTURE_PASS}@127.0.0.1:5433/clptr4p
REVIEWER_DATABASE_URL=postgres://clptr4p_reviewer:${REVIEWER_PASS}@127.0.0.1:5433/clptr4p
ENV

echo "Generated .env with secure random passwords and DEK."
