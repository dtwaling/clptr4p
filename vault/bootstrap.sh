#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo ".env already exists. Refusing to overwrite."
  exit 1
fi

ADMIN_PASS=$(openssl rand -hex 32)
GATEWAY_PASS=$(openssl rand -hex 32)

cat << ENV > .env
POSTGRES_USER=clptr4p_admin
POSTGRES_PASSWORD=${ADMIN_PASS}
POSTGRES_DB=clptr4p
DB_PORT=5433

# Gateway Role Credentials
GATEWAY_USER=clptr4p_gateway
GATEWAY_PASSWORD=${GATEWAY_PASS}

# Connection strings for migrations and gateway
DATABASE_URL=postgres://clptr4p_admin:${ADMIN_PASS}@127.0.0.1:5433/clptr4p
GATEWAY_DATABASE_URL=postgres://clptr4p_gateway:${GATEWAY_PASS}@127.0.0.1:5433/clptr4p
ENV

echo "Generated .env with secure random passwords."
