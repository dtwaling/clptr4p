// Backfill claim embeddings via OpenRouter (stateless compute only).
// Runs as the least-privilege capture role: SELECT claims, UPDATE embedding.
//
//   deno run embed.ts [--dry-run] [--limit N] [--batch N]
//
// Resumable: only claims with NULL embedding are picked up. The ingest and
// review-approve paths embed inline via capture/embed_core.ts; this CLI exists
// for backfills and for claims whose inline embed failed (e.g. OpenRouter down
// -- the claim lands, embedding stays NULL, this picks it up later).

import postgres from "npm:postgres@3.4.5";
import { embedPending, embedInput } from "./capture/embed_core.ts";

const dbUrl = Deno.env.get("CAPTURE_DATABASE_URL");

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

try {
  const pending = await sql<{ id: string; claim: string; value: unknown }[]>`
    SELECT id, claim, value FROM claims
    WHERE embedding IS NULL
    ORDER BY created_at
    ${limit ? sql`LIMIT ${limit}` : sql``}`;

  if (pending.length === 0) {
    console.log("no claims pending embedding");
    Deno.exit(0);
  }

  console.log(`claims pending: ${pending.length}`);
  console.log(`sample: ${JSON.stringify(embedInput(pending[0])).slice(0, 120)}`);

  if (dryRun) {
    console.log("dry run: no embeddings written");
    Deno.exit(0);
  }

  const done = await embedPending(sql, { batchSize, limit });
  console.log(`EMBED OK (${done} claims)`);
} finally {
  await sql.end();
}
