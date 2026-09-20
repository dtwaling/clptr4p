# clptr4p

A zero-trust memory vault for AI agents, implementing the
[Context Layer Protocol](https://sierracatalina.com/context-layer) (aka: CLP).
Agents request context for a stated purpose; a policy engine decides what they
get; every disclosure is single-use, expiring, and receipted; every memory
write is a proposal a human reviews. No ambient access, ever.

Intended to be like a steel *trap* for all the juicy bits buried in your context that you want kept secured, hence **CLPTR4P**.
  ...any similarity to certain excitable robots sometimes found guarding the gateway prattling on and shouting about the rules is just your imagination, merely coincidental.

> This has been on my workbench for a while, and after finally getting some time to poke at it again I had a few more idea to tinker with.  So I figure if I put publish the repo in gh, that might spur me to get after it ...probably ...maybe.  ...More to come, anyway.<br/><br/>
> What I've checked in here is just a basic implementation of Sierra Catalina's Context Layer Protocol.  So if you're curious and what to try something bigger, fancier, or just different with her protocol I highly encourage you to check it out for yourself -> https://sierracatalina.com/context-layer

## Why

Standard agent memory is ambient: a vector store the agent (and anything
holding its credentials) can read and write freely. clptr4p inverts that:

- **Purpose-bound disclosure** -- context is issued only for a declared
  purpose, scoped to granted selectors, with a hard retention cap.
- **Consent-gated writes** -- memory changes are proposals. A human approves
  or rejects. Rejection mints a decision event but commits zero claims.
- **Provenance everywhere** -- every claim traces to an encrypted source
  event; consumers see only opaque provenance handles, never vault ids.
- **Least privilege in the database** -- enforced by Postgres grants, not
  application discipline, and verified by `vault/verify_rbac.ts`.
- **Fail closed** -- missing policy -> deny-all; missing claim -> no bundle;
  expired/consumed/ungranted -> rejected.

Many 3rd-party memory solutions are cloud hosted or often a bit heavy or complex for to run locally.

- **Hermes-Agent plugin** -- Extending clptr4p as a [hermes-agent](https://github.com/NousResearch/hermes-agent) plugin allows me to replace my 3rd-party product with a very simple, secure, and light-weight solution that I fully own and control.

## Architecture

```
capture (CLI/agent)                           agents (MCP clients, e.g. Hermes)
  ingest.ts                                     context_request -> policy-gated bundle
    |                                             memory_propose  -> review queue
    v                                                ^
  vault (Postgres 16 + pgvector)                     |
    source_events  (encrypted, append-only)          |
    claims         (+ embeddings, provenance)   review.ts (human CLI)
    policies       (exactly one active)           approve -> claims + embedding
    proposals      (pending_validation)           reject  -> decision event
    bundles/receipts/decisions (exchange zone)
         ^
  gateway (Deno MCP server, main.ts)
    policy engine + bundle issuer + audit rail
```

| Piece | What it is |
|---|---|
| `gateway/` | Deno MCP server (stdio): `context_request`, `context_act`, `memory_propose`. Pluggable stores: in-memory/file (lite) and Postgres. |
| `vault/` | Postgres schema, RBAC migrations, capture/ingest, review CLI, embedding backfill, similarity search (admin-side). |
| `provider/` | Hermes `MemoryProvider` plugin -- makes clptr4p a drop-in agent memory backend (prefetch + tools, writes mirrored as proposals). |
| `scripts/` | Ops: provider E2E verification, read-only Honcho export. |
| `context-layer-reference/` | Vendored Sierra Catalina reference implementation + schemas. See [VENDORED.md](VENDORED.md). |
| `agent-aware-starter/` | Vendored Sierra Catalina AAA starter (MIT). |

## Quick start

Requirements: Docker, Deno, an OpenRouter API key (for embeddings).

```
cd vault
./bootstrap.sh                    # writes .env with random secrets + DEK
docker compose up -d --wait       # Postgres 16 + pgvector on 127.0.0.1:5433
set -a; . ./.env; set +a
deno run --allow-net=127.0.0.1:5433 --allow-env --allow-read=. migrate.ts
deno run --allow-net=127.0.0.1:5433 --allow-env verify_rbac.ts
                                  # expect: RBAC BOUNDARY OK (4 roles)
```

Seed a real policy (see `vault/migrations/` for examples), then run the
gateway:

```
cd gateway
GATEWAY_DATABASE_URL=... VAULT_DEK=... deno task start
```

Agent writes flow through the review gate:

```
cd vault
REVIEWER_PRINCIPAL="urn:user:you" deno run --allow-net=127.0.0.1:5433 \
  --allow-env --allow-read=.,capture review.ts list
REVIEWER_PRINCIPAL="urn:user:you" deno run ... review.ts approve <id>
```

## Roles (RBAC)

| Role | Reads | Writes |
|---|---|---|
| `clptr4p_admin` | everything (ops/migrations only) | everything |
| `clptr4p_gateway` | claims, policies, bundles | decisions, bundles, receipts, proposals (insert-only); `bundles.consumed_at` update |
| `clptr4p_capture` | claims, source events | claims, events, provenance; embedding updates |
| `clptr4p_reviewer` | proposals, claims | claims (approve), decision events (insert-only, cannot read raw evidence), proposal review columns |

The gateway role cannot read `source_events`; the reviewer can append but
never read them. Receipts are append-only (DB trigger). All verified by
`verify_rbac.ts` against the live database.

## Embeddings

Claims are embedded with `openai/text-embedding-3-small` (1536 dims) via
OpenRouter -- stateless compute only. Embedding is **transactional**: ingest
and review-approve embed inside the same transaction as the claim insert; if
the embed call fails, the whole write rolls back (a claim without its
embedding is a failed write). `vault/embed.ts` is the resumable backfill.

## Hermes integration

See [provider/README.md](provider/README.md). One config line
(`memory.provider: clptr4p`) makes the vault the agent's memory system:
prefetch serves policy-gated claims each turn; agent proposals land in the
review queue; the builtin memory tool's writes are mirrored as proposals too.
Conversation turns are never auto-written to memory.

## Development

```
cd gateway
deno task check          # typecheck
deno task test           # unit tests
deno task smoke          # lite-backend stdio e2e
# Postgres-backed (needs vault/.env sourced):
deno task smoke:pg       # restart durability, replay rejection
deno task smoke:capture  # ingest -> supersede -> gateway round trip
deno task smoke:review   # propose -> approve/reject -> supersede
deno task check:policy   # live policy allow/deny/reduction matrix
cd vault && deno run --allow-net=127.0.0.1:5433 --allow-env verify_rbac.ts
```

Smoke tests seed throwaway policies and subjects; their cleanup traps restore
the prior active policy and delete their own data, so runs leave zero residue.

## Status

In production use as the memory backend for a Hermes agent rig
(`personal/3` policy, human-reviewed claims, migrated from Honcho and the
Hermes profile memory files).
Protocol surface follows context-layer/0.2-draft; expect rough edges and
schema changes. Not yet: real action executors behind `context_act`, AAA
`/.well-known` handshake, semantic (vector) retrieval as a policy capability.

## Credits

- The Context Layer Protocol and the reference implementation are by
  [Sierra Catalina](https://sierracatalina.com/context-layer) -- vendored
  under `context-layer-reference/` and `agent-aware-starter/` (see
  [VENDORED.md](VENDORED.md) for provenance).
- Built on the [Hermes Agent](https://github.com/NousResearch/hermes-agent)
  plugin contract for the provider.
