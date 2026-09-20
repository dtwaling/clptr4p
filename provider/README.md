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

See [docs/SETUP.md](../docs/SETUP.md) for the full fresh-install path
(vault bootstrap, secrets, MCP wiring, verification). The short version:

The provider is discovered as a user plugin at `~/.hermes/plugins/clptr4p/`
(copy of `provider/__init__.py`). Requires in `~/.hermes/.env`:

- `GATEWAY_DATABASE_URL` (same value as `vault/.env`)
- `VAULT_DEK`
- `OPENROUTER_API_KEY` (embeddings; approve/ingest fail without it)

Optional env: `CLPTR4P_SELECTORS` (prefetch predicates; default is the full
granted set of the shipped starter policy), `CLPTR4P_SUBJECT`, `CLPTR4P_DENO`,
`CLPTR4P_GATEWAY_ENTRY`.

## Activate

```yaml
memory:
  provider: clptr4p   # replaces honcho; exactly one external provider
```

And the MCP server entry in `~/.hermes/config.yaml` (this is what hands the
gateway its DB access -- the role password inside the URL is the access key;
there is no separate MCP token):

```yaml
mcp_servers:
  clptr4p:
    command: /home/you/.deno/bin/deno
    args:
      - run
      - --allow-read=/path/to/clptr4p/gateway,/path/to/clptr4p/context-layer-reference
      - --allow-write=/path/to/clptr4p/vault/data
      - --allow-env
      - --allow-net=127.0.0.1:5433
      - /path/to/clptr4p/gateway/main.ts
    cwd: /path/to/clptr4p/gateway
    env:
      GATEWAY_DATABASE_URL: ${GATEWAY_DATABASE_URL}
      VAULT_DEK: ${VAULT_DEK}
    timeout: 60
```

Restart Hermes (gateway restart or CLI relaunch). The active policy must
grant `retrieve.context` for the selectors you want in prefetch (the shipped
starter policy does).

## Review queue

Every proposal lands in the vault's `proposals` table:

```
cd vault && set -a && . .env && set +a
REVIEWER_PRINCIPAL="urn:user:dtdubs" deno run --allow-net=127.0.0.1:5433 \
  --allow-env --allow-read=.,capture review.ts list
```

Approve -> claim committed + embedded inline. Reject -> decision event only.
