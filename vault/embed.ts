// Backfill claim embeddings via OpenRouter (stateless compute only).
// Runs as the least-privilege capture role: SELECT claims, UPDATE embedding.
//
//   deno run embed.ts [--dry-run] [--limit N] [--batch N]
//
// Key resolution: OPENROUTER_API_KEY env var, else grep from ~/.hermes/.env.
// Resumable: only claims with NULL embedding are picked up. Re-running after
// new ingest/review commits embeds just the new rows.

import postgres from "npm:postgres@3.4.5";

const MODEL = "openai/text-embedding-3-small";
const EMBED_DIMS = 1536;

const dbUrl = Deno.env.get("CAPTURE_DATABASE_URL");

function resolveApiKey(): string {
  const fromEnv = Deno.env.get("OPENROUTER_API_KEY");
  if (fromEnv) return fromEnv;
  const hermesEnv = `${Deno.env.get("HOME")}/.hermes/.env`;
  try {
    const match = Deno.readTextFileSync(hermesEnv).match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* fall through */ }
  console.error("OPENROUTER_API_KEY not set and not found in ~/.hermes/.env");
  Deno.exit(1);
}

const args = Deno.args;
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
const batchIdx = args.indexOf("--batch");
const batchSize = batchIdx >= 0 ? Math.max(1, Number(args[batchIdx + 1])) : 32;

if (!dbUrl) {
  console.error("CAPTURE_DATABASE_URL required (source vault/.env)");
  Deno.exit(1);
}

const sql = postgres(dbUrl, { onnotice: () => {} });

interface ClaimRow {
  id: string;
  claim: string;
  value: unknown;
}

// Embed the assertion text plus the value: richest signal for retrieval.
function embedInput(c: ClaimRow): string {
  return `${c.claim} ${JSON.stringify(c.value)}`.trim();
}

async function embedBatch(inputs: string[], apiKey: string): Promise<number[][]> {
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

try {
  const rows = await sql<ClaimRow[]>`
    SELECT id, claim, value FROM claims
    WHERE embedding IS NULL
    ORDER BY created_at
    ${limit ? sql`LIMIT ${limit}` : sql``}`;

  if (rows.length === 0) {
    console.log("no claims pending embedding");
    Deno.exit(0);
  }

  const inputPreview = rows.slice(0, 3).map(embedInput);
  console.log(`claims pending: ${rows.length} (model ${MODEL}, batch ${batchSize})`);
  console.log(`sample: ${JSON.stringify(inputPreview[0]).slice(0, 120)}`);

  if (dryRun) {
    console.log("dry run: no embeddings written");
    Deno.exit(0);
  }

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
    console.log(`  embedded ${done}/${rows.length}`);
    // Gentle pacing between API calls.
    if (i + batchSize < rows.length) await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`EMBED OK (${done} claims)`);
} finally {
  await sql.end();
}
