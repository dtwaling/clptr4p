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
- `clptr4p_capture` -- raw evidence ingestion. Reads/writes `source_events`,
  `claims`, `claim_sources`; supersede + embedding updates only. No access to
  policies or the exchange zone.
- `clptr4p_reviewer` -- human proposal review. Reads `proposals` and `claims`;
  commits approved claims; inserts (cannot read) decision `source_events`;
  updates only proposal review columns. No access to raw evidence payloads,
  policies, or the exchange zone.

## Bring-up

```
./bootstrap.sh                          # once: writes .env with random secrets
docker compose up -d --wait
set -a; . ./.env; set +a
deno run --allow-net=127.0.0.1:5433 --allow-env --allow-read=. migrate.ts
deno run --allow-net=127.0.0.1:5433 --allow-env verify_rbac.ts   # expect RBAC BOUNDARY OK
```

Gateway selects this backend when `GATEWAY_DATABASE_URL` is set.

## Capture pipeline

```
deno run --allow-net=127.0.0.1:5433 --allow-env --allow-read=.,capture \
  capture/ingest.ts fixtures/capture-sample.json
```

Envelopes are validated (`capture/types.ts`), payloads sealed with AES-256-GCM
(`VAULT_DEK`), event/claim ids are deterministic hashes (idempotent re-ingest),
and `supersede: true` claims atomically retire prior active claims.

## Embeddings (OpenRouter)

Claims are embedded with `openai/text-embedding-3-small` (1536 dims, matches
`claims.embedding vector(1536)`). OpenRouter is stateless compute only.

The API key is reused from the Hermes harness (no separate clptr4p key):
`OPENROUTER_API_KEY` env var, else parsed from `~/.hermes/.env`.

```
set -a; . ./.env; set +a
export OPENROUTER_API_KEY=$(grep '^OPENROUTER_API_KEY=' ~/.hermes/.env | head -1 | cut -d= -f2-)
deno run --allow-net=127.0.0.1:5433,openrouter.ai --allow-env --allow-read=. \
  embed.ts [--dry-run] [--limit N] [--batch N]     # resumable backfill
deno run ... search.ts "query text" [--limit N] [--min-sim 0.75]   # admin-side ops
```

- `embed.ts` runs as the capture role (SELECT claims, UPDATE embedding only);
  resumable -- only NULL embeddings are picked up, so run it after any ingest
  or approved review.
- `search.ts` is an admin ops/verification tool; agents never query vectors
  directly -- agent access flows through the gateway by predicate, under
  policy.

## Proposal review (human gate)

Agents submit `memory_propose` via the gateway; proposals land in the
`proposals` table with status `pending_validation`. You review:

```
set -a; . ./.env; set +a
REVIEWER_PRINCIPAL="urn:user:dtdubs" deno run --allow-net=127.0.0.1:5433 \
  --allow-env --allow-read=.,capture review.ts list
REVIEWER_PRINCIPAL="urn:user:dtdubs" deno run ... review.ts show <id>
REVIEWER_PRINCIPAL="urn:user:dtdubs" deno run ... review.ts approve <id>
REVIEWER_PRINCIPAL="urn:user:dtdubs" deno run ... review.ts reject <id> --reason "text"
```

Approving mints an encrypted decision `source_event` (origin `review`), commits
the proposed claims with provenance to that event, applies `add_or_contradict`
supersede semantics, and flips the proposal to `committed` -- one transaction.
Double-approve and expired proposals are rejected; the status re-check runs
under `FOR UPDATE`.

## Ops helpers

- `psql.ts` -- run SQL from stdin as admin: `cat file.sql | deno run --allow-net=127.0.0.1:5433 --allow-env psql.ts`
- `migrate.ts` -- idempotent; tracks applied files in `schema_migrations`.

## Invariants enforced in-DB

- `receipts` is append-only (trigger rejects UPDATE/DELETE).
- Exactly one active policy (partial unique index).
- Bundle consume: `SELECT ... FOR UPDATE` + `consumed_at` + receipt in one txn.
- Bundle issue: bundle row + issuance receipt in one txn.
- Reviewer cannot read raw evidence; only append decision events.
