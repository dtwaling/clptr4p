// Admin-side similarity search over claim embeddings (ops/verification tool;
// agents never search directly -- they go through the gateway by predicate).
//
//   deno run --allow-net=127.0.0.1:5433 --allow-env --allow-read=. \
//     search.ts "query text" [--limit N] [--min-sim 0.75]

import postgres from "npm:postgres@3.4.5";

const MODEL = "openai/text-embedding-3-small";

const dbUrl = Deno.env.get("DATABASE_URL");
if (!dbUrl) {
  console.error("DATABASE_URL required (source vault/.env)");
  Deno.exit(1);
}

const args = Deno.args;
const queryIdx = args.findIndex((a) => !a.startsWith("--"));
const query = args[queryIdx];
if (!query) {
  console.error("usage: search.ts <query text> [--limit N] [--min-sim 0.75]");
  Deno.exit(1);
}
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 5;
const simIdx = args.indexOf("--min-sim");
const minSim = simIdx >= 0 ? Number(args[simIdx + 1]) : 0.0;

function resolveApiKey(): string {
  const fromEnv = Deno.env.get("OPENROUTER_API_KEY");
  if (fromEnv) return fromEnv;
  const hermesEnv = `${Deno.env.get("HOME")}/.hermes/.env`;
  const match = Deno.readTextFileSync(hermesEnv).match(/^OPENROUTER_API_KEY=(.+)$/m);
  if (match) return match[1].trim();
  console.error("OPENROUTER_API_KEY not found");
  Deno.exit(1);
}

const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
  method: "POST",
  headers: { "Authorization": `Bearer ${resolveApiKey()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: MODEL, input: [query] }),
});
if (!res.ok) {
  console.error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  Deno.exit(1);
}
const qvec = ((await res.json()) as { data: { embedding: number[] }[] }).data[0].embedding;

const sql = postgres(dbUrl, { onnotice: () => {} });
try {
  const rows = await sql`
    SELECT id, subject_ref, predicate, claim, value, superseded_by IS NOT NULL as superseded,
           1 - (embedding <=> ${JSON.stringify(qvec)}::vector) as similarity
    FROM claims
    WHERE embedding IS NOT NULL
      AND superseded_by IS NULL
      AND (valid_to IS NULL OR valid_to > now())
      AND 1 - (embedding <=> ${JSON.stringify(qvec)}::vector) > ${minSim}
    ORDER BY similarity DESC
    LIMIT ${limit}`;
  if (rows.length === 0) {
    console.log("no matches");
    Deno.exit(0);
  }
  for (const r of rows) {
    console.log(`${Number(r.similarity).toFixed(3)}  ${r.predicate}  ${JSON.stringify(r.value)}`);
    console.log(`        ${r.claim}`);
    console.log(`        ${r.subject_ref}  (${r.id})`);
  }
} finally {
  await sql.end();
}
