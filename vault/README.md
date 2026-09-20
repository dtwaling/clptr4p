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
`proposals` table with status `pending_validation`. The one-command wrapper
(sources `.env` itself):

```
../scripts/review.sh list
../scripts/review.sh show <id>
../scripts/review.sh approve <id>
../scripts/review.sh reject <id> --reason "text"
```

Equivalent raw invocations:

```
set -a; . ./.env; set +a
REVIEWER_PRINCIPAL="urn:user:dtdubs" deno run --allow-net=127.0.0.1:5433 \
  --allow-env --allow-read=.,capture review.ts list
```

Approving mints an encrypted decision `source_event` (origin `review`), commits
the proposed claims with provenance to that event, applies `add_or_contradict`
supersede semantics, and flips the proposal to `committed` -- one transaction.
Double-approve and expired proposals are rejected; the status re-check runs
under `FOR UPDATE`.

### Auto-triage (`triage.ts`)

`vault/triage.ts` closes the dead weight so only real candidates reach your
eyes. It may **only reject** -- and rejection commits zero claims by design,
so automated closing can never bypass the human gate. Approval stays
human-only, always.

```
deno run --allow-net=127.0.0.1:5433 --allow-env --allow-read=.,capture triage.ts            # apply
deno run ... triage.ts --dry-run                                                           # preview
deno run ... triage.ts --format digest                                                     # digest (silent when idle)
```

Deterministic rules, first match wins: **expired** (past `expires_at`), **empty**
(no claims), **ungranted** (a predicate outside the active policy's
`allowed_selectors` -- approval could never serve it), **duplicate** (every
proposed claim already active verbatim -- approval would be a no-op). Malformed
proposals are kept for the human, never auto-closed. Each close mints an
encrypted decision event (reviewer `urn:cl:triage`) with the reason; rejected
proposal rows and their content remain queryable.

`scripts/triage_digest.sh` runs triage in digest mode for a cron watchdog:
empty output on an idle queue, so a no-agent cron job only messages you when
something needs eyes (or was closed). `gateway/tests/smoke_triage.sh` covers
the whole surface against the real active policy.

## Ops helpers

- `psql.ts` -- run SQL from stdin as admin: `cat file.sql | deno run --allow-net=127.0.0.1:5433 --allow-env psql.ts`
- `migrate.ts` -- idempotent; tracks applied files in `schema_migrations`.

## Invariants enforced in-DB

- `receipts` is append-only (trigger rejects UPDATE/DELETE).
- Exactly one active policy (partial unique index).
- Bundle consume: `SELECT ... FOR UPDATE` + `consumed_at` + receipt in one txn.
- Bundle issue: bundle row + issuance receipt in one txn.
- Reviewer cannot read raw evidence; only append decision events.

## Active policy

**`personal/3`** (migration 012): purpose `retrieve.context`; selectors
`preferred_name`, `comm.style`, `formatting.rule`, `tech.stack`, `notes.tool`,
`skill.rule`, `skill.cadence`, `project.active`, `repo.remote`, plus the
sixteen Hermes-profile-migration predicates (`hermes.setup`, `tools.convention`,
`project.audio2midi`, `skill.scanner`, `terminal.guard`, `browser.testing`,
`daemon.spawn`, `ghcli.regression`, `skill.authoring`, `github.ops`,
`gateway.setup`, `ob1l.legacy`, `desktop.quirks`, `profile.rule`,
`kanban.dispatcher`, `clptr4p.ops`); no actions; retention 3600s; onward
disclosure forbidden. `default-deny` stays in the table as the fail-closed
fallback (inactive). Verify with `gateway: deno task check:policy`.

Note: `policies` enforces exactly one active row -- "additional policies" are
versioned swaps (e.g. a future `personal/3` or `workspace/1`), not stacked
policies.
