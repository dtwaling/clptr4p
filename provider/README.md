# clptr4p Hermes memory provider

A Hermes `MemoryProvider` plugin that makes the clptr4p vault the agent's
memory system. Zero-trust by construction: the provider is a thin MCP stdio
client to the deployed Policy Gateway.

```
Hermes agent loop
  -> prefetch(query)      gateway context_request (retrieve.context)
                          -> policy-gated claims -> <memory-context>
  -> clptr4p_context tool  same request, chosen predicates
  -> clptr4p_propose tool   gateway memory_propose -> human review queue
  -> builtin memory tool    mirrored on_memory_write -> review proposal
```

Nothing writes to the vault except proposals you approve in `review.ts`.
`sync_turn` is deliberately a no-op: conversation turns are never auto-written
to memory.

## Install

The provider is discovered as a user plugin at `~/.hermes/plugins/clptr4p/`
(copy of `provider/__init__.py`). Requires in `~/.hermes/.env`:

- `GATEWAY_DATABASE_URL` (same value as `vault/.env`)
- `VAULT_DEK`

Optional env: `CLPTR4P_SELECTORS` (prefetch predicates, default
`preferred_name,comm.style,formatting.rule`), `CLPTR4P_SUBJECT`,
`CLPTR4P_DENO`, `CLPTR4P_GATEWAY_ENTRY`.

## Activate

```yaml
memory:
  provider: clptr4p   # replaces honcho; exactly one external provider
```

Restart Hermes (gateway restart or CLI relaunch). The active policy must
grant `retrieve.context` for the selectors you want in prefetch (`personal/1`
does).

## Review queue

Every proposal lands in the vault's `proposals` table:

```
cd vault && set -a && . .env && set +a
REVIEWER_PRINCIPAL="urn:user:dtdubs" deno run --allow-net=127.0.0.1:5433 \
  --allow-env --allow-read=.,capture review.ts list
```

Approve -> claim committed + embedded inline. Reject -> decision event only.
