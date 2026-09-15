# Open Brain v2 (clptr4p) Architecture

## Core Principles
1. **Zero Ambient Access**: No direct vector DB queries. All context flows through the Policy Gateway.
2. **Purpose-Bound Disclosure**: Agents request context for a specific purpose. Gateway issues a single-use, expiring Scoped Context Bundle.
3. **Receipts & Proposals**: Actions generate append-only receipts. Memory writes are proposals, not direct mutations.
4. **Local-First Hardening**: Deno + Docker, `no-new-privileges`, loopback binds, header auth.

## Components
-- **Vault (Postgres 16 + pgvector)**: Stores raw source events, derived claims, identity bindings, policies, and receipts.
-- **Policy Gateway (Deno)**: The absolute choke point. The ONLY MCP server Hermes connects to.
   - Exposes: `context.request`, `context.act`, `memory.propose`.
   - Wraps the Sierra Catalina `context-layer-reference.mjs` logic.
-- **AAA Handshake**: Implements `/.well-known/agents.json` and `ai-instructions.json` to broadcast available capabilities and rules to connecting agents.

## Migration Path
1. Retain existing `ob1l` pgvector data as legacy derived claims (requires backfilling source-event provenance).
2. Stand up Deno Policy Gateway using the reference implementation.
3. Cut over Hermes MCP config to the new Gateway.