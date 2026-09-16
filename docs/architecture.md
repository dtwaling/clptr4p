# clptr4p (Context Layer Protocol) Architecture

## Core Principles
1. **Zero Ambient Access**: No direct vector DB queries. All context flows through the Policy Gateway.
2. **Purpose-Bound Disclosure**: Agents request context for a specific purpose. Gateway issues a single-use, expiring Scoped Context Bundle.
3. **Receipts & Proposals**: Every issue/consume writes an append-only receipt. Memory writes are proposals, never direct mutations.
4. **Fail Closed**: Missing policy -> deny-all. Missing claims -> no bundle. Expired/consumed/ungranted -> rejected.

## Components (gateway/)
- `main.ts` -- MCP server (stdio). Tools: `context_request`, `context_act`, `memory_propose`.
- `bundle_store.ts` -- in-memory issued-bundle registry; enforces single-use, expiry, capability binding.
- `claim_store.ts` -- file-backed vault claims surface, keyed by `subject_ref`. Gateway selects requested predicates; policy engine grants.
- `audit.ts` -- append-only JSONL writer. IO failure throws (no false success).
- `../context-layer-reference/` -- vendored Sierra Catalina v0.2-draft reference (validators, decide, issue, receipt).

## Runtime config (env)
- `CLPTR4P_POLICY_FILE` -- JSON policy input (reference `policy` shape). Absent/unreadable -> deny-all.
- `CLPTR4P_CLAIMS_FILE` -- JSON `{ "<subject_ref>": Claim[] }`. Absent -> empty store.

## Data (vault/data/, gitignored)
- `decisions.jsonl` -- every PolicyDecision + rejected act attempts.
- `receipts.jsonl` -- `bundle.issue` and per-action consume receipts.
- `proposals.jsonl` -- queued `memory_update_proposal`s (status `pending_validation`).

## Flow
```
context_request(request)
  -> validate -> decide(policy) -> log decision
  -> deny/needs_approval: return decision
  -> allow*: select claims -> issueScopedBundle -> receipt(bundle.issue) -> store bundle
context_act(bundle_id, action)
  -> store.consume: not found | expired | consumed | ungranted => reject + log
  -> ok: receipt(action, actor=recipient) -> return bundle.context + restrictions
memory_propose(proposal)
  -> validate -> append proposals.jsonl -> pending_validation
```

## Dev
```
cd gateway
deno task check   # typecheck
deno task test    # unit tests
deno task smoke   # stdio end-to-end: allow -> act -> replay rejected -> propose
```

## Not yet
- Durable bundle store (in-memory; restart drops issued bundles by design for now).
- Real action executors behind `context_act` (currently returns approved context; caller acts).
- Proposal review/commit path into the vault.
- Postgres/pgvector vault backend replacing the JSON claim file.
- AAA `/.well-known` handshake for agent profiles.
