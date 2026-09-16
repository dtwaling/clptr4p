# clptr4p vault

PostgreSQL 16 + pgvector, isolated from ob1l (own compose project, own volume,
loopback-only on `127.0.0.1:5433`). Same hardening profile as ob1l: pinned
image digest, `no-new-privileges`, noexec tmpfs.

## Roles

- `clptr4p_admin` -- owner. Migrations, seeding, ops. Never used by the gateway.
- `clptr4p_gateway` -- least privilege. Reads `claims`, `policies`, `identity_bindings`;
  appends `decisions`, `bundles`, `receipts`, `proposals`; may update only
  `bundles.consumed_at`. **No grants on `source_events`.** Enforced by
  `migrations/002_roles.sql`, verified by `verify_rbac.ts`.

## Bring-up

```
./bootstrap.sh                          # once: writes .env with random secrets
docker compose up -d --wait
set -a; . ./.env; set +a
deno run --allow-net=127.0.0.1:5433 --allow-env --allow-read=. migrate.ts
deno run --allow-net=127.0.0.1:5433 --allow-env verify_rbac.ts   # expect RBAC BOUNDARY OK
```

Gateway selects this backend when `GATEWAY_DATABASE_URL` is set.

## Ops helpers

- `psql.ts` -- run SQL from stdin as admin: `cat file.sql | deno run --allow-net=127.0.0.1:5433 --allow-env psql.ts`
- `migrate.ts` -- idempotent; tracks applied files in `schema_migrations`.

## Invariants enforced in-DB

- `receipts` is append-only (trigger rejects UPDATE/DELETE).
- Exactly one active policy (partial unique index).
- Bundle consume: `SELECT ... FOR UPDATE` + `consumed_at` + receipt in one txn.
- Bundle issue: bundle row + issuance receipt in one txn.
