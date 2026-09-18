// Shared embedding core. Two entry points:
//   - embedPending(sql, opts): resumable backfill of claims with NULL embedding
//   - embedClaims(tx, claims):  embed specific claim rows inside a live txn
//
// Key resolution: OPENROUTER_API_KEY env var, else grep from ~/.hermes/.env.
// OpenRouter is stateless compute only (model openai/text-embedding-3-small,
// 1536 dims). All write paths use the capture role's UPDATE(embedding) only.

import postgres from "npm:postgres@3.4.5";

export const MODEL = "openai/text-embedding-3-small";
export const EMBED_DIMS = 1536;

export function resolveApiKey(): string {
  const fromEnv = Deno.env.get("OPENROUTER_API_KEY");
  if (fromEnv) return fromEnv;
  const hermesEnv = `${Deno.env.get("HOME")}/.hermes/.env`;
  try {
    const match = Deno.readTextFileSync(hermesEnv).match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* fall through */ }
  throw new Error("OPENROUTER_API_KEY not set and not found in ~/.hermes/.env");
}

interface ClaimRow {
  id: string;
  claim: string;
  value: unknown;
}

export function embedInput(c: { claim: string; value: unknown }): string {
  return `${c.claim} ${JSON.stringify(c.value)}`.trim();
}

export async function embedBatch(inputs: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json() as { data: { embedding: number[]; index: number }[] };
  // API may return out of order; restore request order.
  const byIndex = new Map(json.data.map((d) => [d.index, d.embedding]));
  return inputs.map((_, i) => byIndex.get(i)!);
}

// Embed given claims and write vectors, all inside the caller's transaction.
// deno-lint-ignore no-explicit-any
export async function embedClaimsTx(tx: any, claims: ClaimRow[]): Promise<number> {
  if (claims.length === 0) return 0;
  const apiKey = resolveApiKey();
  const embeddings = await embedBatch(claims.map(embedInput), apiKey);
  for (const [i, c] of claims.entries()) {
    const vec = embeddings[i];
    if (vec.length !== EMBED_DIMS) throw new Error(`claim ${c.id}: got ${vec.length} dims, expected ${EMBED_DIMS}`);
    await tx`UPDATE claims SET embedding = ${JSON.stringify(vec)}::vector WHERE id = ${c.id}`;
  }
  return claims.length;
}

// Resumable backfill: every claim with a NULL embedding, ordered, batched.
export async function embedPending(
  sql: postgres.Sql<Record<string, postgres.PostgresType>>,
  opts: { batchSize?: number; limit?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 32;
  const rows = await sql<ClaimRow[]>`
    SELECT id, claim, value FROM claims
    WHERE embedding IS NULL
    ORDER BY created_at
    ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}`;
  if (rows.length === 0) return 0;

  const apiKey = resolveApiKey();
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const embeddings = await embedBatch(batch.map(embedInput), apiKey);
    await sql.begin(async (tx) => {
      for (const [j, row] of batch.entries()) {
        const vec = embeddings[j];
        if (vec.length !== EMBED_DIMS) throw new Error(`claim ${row.id}: got ${vec.length} dims, expected ${EMBED_DIMS}`);
        await tx`UPDATE claims SET embedding = ${JSON.stringify(vec)}::vector WHERE id = ${row.id}`;
      }
    });
    done += batch.length;
    if (i + batchSize < rows.length) await new Promise((r) => setTimeout(r, 250));
  }
  return done;
}
