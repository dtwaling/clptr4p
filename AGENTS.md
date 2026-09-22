# AGENTS.md

This is **clptr4p** -- a zero-trust memory vault for agents implementing the
Sierra Catalina Context Layer Protocol (v0.2-draft). Human-reviewed claims,
policy-gated disclosure, provenance on everything.

## Mission

Replace ambient agent memory with a consent-gated vault:

```
agent -> context_request (purpose-bound) -> policy engine -> single-use bundle
agent -> memory_propose  -> human review -> approved claims (or nothing)
```

## Hard rules

- **Never print or commit secrets.** Credentials live in `vault/.env` and
  `~/.hermes/.env` only. If a secret appears in chat or a transcript, flag it
  and rotate it -- this happened before; do not let it happen again.
- **No em-dashes.** ASCII `--` everywhere: markdown, code comments, commit
  messages.
- **No heredoc/pipe-to-interpreter scripts.** Test and verification code goes
  in versioned files under `scripts/` and runs as files. This keeps the
  approval gate quiet and the work reviewable.
- **SQL via files**, not inline pipes: write `foo.sql`, feed it to
  `vault/psql.ts` with `< foo.sql`.
- **Never bulk-write to the production policy table.** Smokes must capture the
  prior active policy and restore it in a trap registered before the first DB
  write; test subjects must self-delete. (Both rules exist because we broke
  them once.)
- **Fail closed, loudly.** A failed embed rolls back the whole write; a failed
  policy load is deny-all. Preserve these semantics in every new path.
- Vendored upstreams (`context-layer-reference/`, `agent-aware-starter/`) are
  reference material: read them, don't edit them.

## Layout

- `gateway/` -- Deno MCP server. Tools: `context_request`, `context_act`,
  `memory_propose`. `store/` holds the Backend interface plus lite (memory/
  file/JSONL) and Postgres implementations. State + receipt go in ONE
  transaction on both issue and consume (protocol invariant 8).
- `vault/` -- Postgres 16 + pgvector on `127.0.0.1:5433` (loopback only).
  - `migrations/` -- numbered SQL, applied by `migrate.ts`; roles in 002/004/007.
  - `capture/` -- envelope validation, AES-256-GCM payload sealing (`VAULT_DEK`),
    `ingest.ts` (deterministic ids -> idempotent re-ingest), shared embed core.
  - `review.ts` -- human review CLI. Approve = encrypted decision event +
    claims + provenance + inline embedding, one txn. Reject = decision event
    only, zero claims. An explicit reviewer principal is required through
    `REVIEWER_PRINCIPAL` or `--reviewer`; it never defaults to a human identity.
    `list` and `show` include parked rows, supersede previews, and read-only
    core-budget replacement accounting. Approve with `--tier core|archive`
    stamps each committed claim's human-selected injection tier; `unpark` is
    the only route from parked to reviewable.
  - `triage.ts` -- auto-triage for the review queue. Expired, unparseable
    expiry, and ungranted-predicate proposals are **parked**: they write zero
    claims, are excluded from later digests, stay visible in review, and can
    re-enter review only through human `unpark`. Empty, malformed, and
    verbatim-duplicate proposals are terminally rejected; rejection mints a
    decision event but commits zero claims. This is the zero-trust invariant:
    auto-triage never approves or commits a claim. `scripts/triage_digest.sh`
    is the cron entry point and `scripts/review.sh` is the human wrapper;
    `reject-parked [--subject <ref>]` provides scoped terminal cleanup.
  - `verify_rbac.ts` -- live privilege-boundary test for all roles. Run it
    after touching any grant.
  - `embed.ts` / `search.ts` -- backfill CLI / admin similarity search. Agents
    never query vectors; they go by predicate under policy.
- `provider/` -- Hermes MemoryProvider plugin (thin MCP stdio client).
  Builtin Hermes memory stays local: durable vault writes happen only through
  deliberate `clptr4p_propose` calls and human approval. `sync_turn` is
  deliberately a no-op: turns are never auto-written to memory. Prefetch
  requests only human-stamped `core` claims and applies the fail-soft
  `CLPTR4P_PREFETCH_MAX_CHARS` character budget (default 11000); explicit
  policy-gated context requests may retrieve archive claims.
- `scripts/` -- repo-filed ops scripts (provider E2E, Honcho export). All rig
  specifics are flags/env, no hardcodes. `backfill_injection_tiers.ts` is the
  one-time interactive human classifier for existing active claims.
- `docs/architecture.md` -- detailed design notes.

## Environment

- Deno at `~/.deno/bin/deno` (absolute path in the MCP config; the gateway's
  spawn env may lack the user PATH).
- Postgres runs in Docker; `vault/.env` (0600) holds all role credentials and
  the DEK. Source it: `set -a; . .env; set +a`.
- OpenRouter key for embeddings resolves from `~/.hermes/.env` -- no separate
  clptr4p credential.
- The live Hermes integration: MCP server entry in `~/.hermes/config.yaml`
  (env passthrough `GATEWAY_DATABASE_URL`, `VAULT_DEK`), provider installed at
  `~/.hermes/plugins/clptr4p/` and the configured profile plugin homes (keep
  all copies in sync with `provider/__init__.py`), active memory provider is
  clptr4p.
- One digest watchdog is registered in the default profile: cron
  `9b6df582187f`, Telegram delivery, daily at 9am EDT. Do not create another
  profile-level digest cron.

## Verification before "done"

Run the suite from `gateway/` (with `vault/.env` sourced):

```
deno task check && deno task test
deno run --allow-net=127.0.0.1:5433 --allow-env ../vault/verify_rbac.ts
bash tests/smoke.sh && bash tests/smoke_pg.sh
bash tests/smoke_capture.sh && bash tests/smoke_review.sh && bash tests/smoke_triage.sh
bash tests/check_policy.sh
```

Then confirm no residue and the right active policy with a repo-filed SQL
query via `vault/psql.ts`; do not use an inline pipe-to-interpreter command.

After provider changes also run `uv run --script scripts/verify_provider.py`.
Its cleanup must run as `urn:cl:verify`; re-sync every installed plugin copy
and verify byte-identical source hashes.

## Commit style

`type(scope): subject` -- `feat`, `fix`, `docs`, `chore`, `test`. ASCII `--`.
Trailer: `Co-Authored-By: Hermes Agent <noreply@hermes.local>`.

## Conventions worth keeping

- Claim predicates: `snake_case` opaque names (`isName` regex in the
  reference: `[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*`). Test-only predicates use the
  `x.` namespace.
- Fixture timestamps: `occurred_at` must be <= real time; the vault's
  `valid_from <= now()` filter enforces it and future-dated captures silently
  don't serve. Write the true capture time.
- Every capture envelope documents its source in `payload.summary`; the vault
  is a clean start -- only real, curated history enters it.
- Provenance handles are HMAC-derived (`prov_<hex>`), never claim ids.
