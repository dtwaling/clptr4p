# clptr4p (Context Layer Protocol) Architecture

## Core Principles
1. **Zero Ambient Access**: No direct vector DB queries. All context flows through the Policy Gateway.
2. **Purpose-Bound Disclosure**: Agents request context for a specific purpose. Gateway issues a single-use, expiring Scoped Context Bundle.
3. **Receipts & Proposals**: Every issue/consume writes a receipt atomically with the state change. Memory writes are proposals, never direct mutations.
4. **Fail Closed**: Missing policy -> deny-all. Missing claims -> no bundle. Expired/consumed/ungranted -> rejected.
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
  migrations/        001 schema, 002 gateway role grants, 003 seed deny-all policy
  migrate.ts         idempotent runner (admin role)
  verify_rbac.ts     asserts the gateway role boundary against the live DB
  psql.ts            stdin SQL as admin (ops/tests)
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
```

## Provenance
Bundle `provenance_handles` are `prov_<sha256[:16]>(claim_id)`: opaque to the consumer, resolvable only inside the vault.

## Dev
```
cd gateway
deno task check      # typecheck
deno task test       # unit tests (lite backend)
deno task smoke      # lite stdio e2e: allow -> act -> replay rejected -> propose
deno task smoke:pg   # postgres e2e incl. restart durability (needs vault/.env sourced)
cd ../vault && deno run --allow-net=127.0.0.1:5433 --allow-env verify_rbac.ts
```

## Not yet
- Real action executors behind `context_act` (returns approved context; caller acts).
- Proposal review/commit path into `claims` (needs a reviewer role, not the gateway).
- Capture/normalize pipeline feeding `source_events` -> `claims` (+ embeddings).
- Migration of ob1l data (import as source_events; re-derive claims).
- AAA `/.well-known` handshake for agent profiles.
- Point the live Hermes MCP config at the postgres backend (set `GATEWAY_DATABASE_URL` in the server env).
