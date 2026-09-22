# clptr4p (Context Layer Protocol) Architecture

## Core Principles
1. **Zero Ambient Access**: No direct vector DB queries. All context flows through the Policy Gateway.
2. **Purpose-Bound Disclosure**: Agents request context for a specific purpose. Gateway issues a single-use, expiring Scoped Context Bundle.
3. **Receipts & Proposals**: Every issue/consume writes a receipt atomically with the state change. Memory writes are proposals, never direct mutations.
4. **Fail Closed**: Missing policy -> deny-all. Missing claims -> no bundle. Expired, consumed, or ungranted bundle actions are rejected. Proposal triage never grants access or commits claims.
5. **Least Privilege at the DB**: the gateway's Postgres role cannot read raw source events or write claims/policies. Enforced by grants, verified by test.

## Components
```
gateway/
  main.ts            MCP server (stdio). Tools: context_request, context_act, memory_propose
  store/types.ts     Backend interface + shared consume semantics (evaluateConsume)
  store/lite.ts      memory bundles, file policy/claims, JSONL audit (zero infra)
  store/postgres.ts  durable vault backend, least-privilege role
vault/
  docker-compose.yml pg16+pgvector, 127.0.0.1:5433, hardened
  migrations/        numbered schema and role migrations; 014 adds claim injection tiers
  migrate.ts         idempotent runner (admin role)
  verify_rbac.ts     asserts the gateway role boundary against the live DB
  psql.ts            stdin SQL as admin (ops/tests)
  triage.ts          conservative queue hygiene: park recoverable proposals,
                     reject only terminally unusable ones
  review.ts          explicit-principal human review CLI; approve, reject,
                     unpark, and scoped parked-queue cleanup
provider/
  __init__.py        Hermes MemoryProvider. Builtin Hermes memory remains
                     local; vault writes require deliberate clptr4p_propose.
scripts/
  backfill_injection_tiers.ts  one-time interactive human tier classification
  triage_digest.sh             queue digest watchdog entry point
context-layer-reference/  vendored Sierra Catalina v0.2-draft (validators, decide, issue, receipt)
```

## Backend selection (env)
- `GATEWAY_DATABASE_URL` set -> postgres backend (production path).
- else lite: `CLPTR4P_POLICY_FILE` (absent -> deny-all), `CLPTR4P_CLAIMS_FILE` (absent -> empty). Audit to `vault/data/*.jsonl`.

## Flow
```
context_request(request)
  -> validate -> policy.active() -> decide -> audit.decision
  -> deny/needs_approval: return decision
  -> allow*: claims.select(subject, predicates) -> issueScopedBundle
            -> bundles.issue(bundle + receipt)   [one txn]
context_act(bundle_id, action)
  -> bundles.consume: FOR UPDATE -> evaluate (not found | consumed | expired | ungranted)
            -> ok: consumed_at + receipt          [one txn]
            -> reject: audit.rejectedAct
memory_propose(proposal)
  -> validate -> audit.proposal (status pending_validation)
human review (review.ts, explicit reviewer principal)
  -> approve --tier core|archive: decision event + claims + provenance +
     embedding in one transaction
  -> reject: decision event only, zero claims
auto-triage (triage.ts)
  -> expired / ungranted: parked, no decision event and zero claims
  -> empty / malformed / verbatim duplicate: rejected, decision event and
     zero claims
```

## Review queue and zero-trust boundary

`review.ts` requires an explicit reviewer identity: set `REVIEWER_PRINCIPAL`
or pass `--reviewer <principal>`. Its `list` and `show` commands include
parked rows, a same-subject/predicate supersede preview, and the hypothetical
gross and net core-prefetch cost of `--tier core`. When a candidate would
exceed the budget, the preview identifies relevant core demotion candidates;
it does not change a tier or claim.

Triage is deliberately conservative. Expired proposals, unparseable expiry,
and proposals whose predicates are outside the active policy are **parked**,
not rejected. Parked proposals are excluded from the digest, remain visible to
the reviewer, can return to `pending_validation` only through human `unpark`,
and can be terminally cleared with `reject-parked [--subject <ref>]`. Empty,
malformed, and verbatim duplicate proposals are terminally rejected. The
zero-trust invariant is that parked rows commit zero claims and never re-enter
human review except by a human un-park action; auto-triage never approves a
proposal.

`scripts/verify_provider.py` uses the machine reviewer principal
`urn:cl:verify` for its cleanup rejection and verifies that audit actor.

## Injection tiers and provider prefetch

Claims have a human-stamped `injection_tier`: `core` or `archive`. New claims
and proposals default to `archive`; `review.ts approve --tier core` stamps an
approved claim core. Existing active claims can instead be classified
deliberately with the interactive
`scripts/backfill_injection_tiers.ts` script. This tier is an injection
control, not a retention limit: archived claims remain in the vault and are
available through policy-gated explicit context requests.

The provider's per-session prefetch requests only human-stamped core claims
and applies `CLPTR4P_PREFETCH_MAX_CHARS` (default 11000) as a fail-soft
character budget. Explicit `clptr4p_context` requests are still policy-gated
and are not restricted to core. `sync_turn` remains deliberately a no-op:
conversation turns and builtin Hermes memory writes are never mirrored into
the vault. Durable vault writes happen only through deliberate
`clptr4p_propose` calls followed by human approval.

## Operations

There is one review-queue digest watchdog: default-profile cron
`9b6df582187f`, delivered to Telegram daily at 9am EDT. It runs
`clptr4p_triage_digest.sh`; the former implementer-profile digest cron has
been removed. The digest is silent for an idle queue and excludes parked
proposals, while reporting remaining human-review candidates and triage work.

## Provenance
Bundle `provenance_handles` are `prov_<sha256[:16]>(claim_id)`: opaque to the consumer, resolvable only inside the vault.

## Dev
```
cd gateway
deno task check      # typecheck
deno task test       # unit tests (lite backend)
deno task smoke      # lite stdio e2e: allow -> act -> replay rejected -> propose
deno task smoke:pg   # postgres e2e incl. restart durability (needs vault/.env sourced)
deno task smoke:capture  # capture -> supersede -> gateway round trip
deno task smoke:review   # review approval, rejection, tier previews
bash tests/smoke_triage.sh  # parked/rejected queue semantics against live policy
deno task check:policy      # live policy allow/deny/reduction matrix
cd ../vault && deno run --allow-net=127.0.0.1:5433 --allow-env verify_rbac.ts
```

For the full live verification sequence, source `vault/.env` and run the
commands above in addition to `bash tests/smoke_capture.sh`,
`bash tests/smoke_review.sh`, and `bash tests/check_policy.sh`. Provider
changes also require `uv run --script scripts/verify_provider.py` and
byte-identical synchronization to every installed provider home.

## Not yet
- Real action executors behind `context_act` (returns approved context; caller acts).
- Migration of ob1l data (import as source_events; re-derive claims).
- AAA `/.well-known` handshake for agent profiles.
