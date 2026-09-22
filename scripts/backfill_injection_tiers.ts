// One-time interactive classification of active claims for provider prefetch.
// Run manually from the repo root after sourcing vault/.env. This script never
// changes policy rows and only writes the tier selected by the human operator.

import postgres from "npm:postgres@3.4.5";

const dbUrl = Deno.env.get("DATABASE_URL");
if (!dbUrl) {
  console.error("DATABASE_URL required (source vault/.env first)");
  Deno.exit(1);
}

type ClaimRow = { id: string; predicate: string; claim: string; value: unknown; injection_tier: "core" | "archive" };
const sql = postgres(dbUrl, { onnotice: () => {} });

try {
  const claims = await sql<ClaimRow[]>`
    SELECT id, predicate, claim, value, injection_tier
    FROM claims
    WHERE superseded_by IS NULL
      AND (valid_from IS NULL OR valid_from <= now())
      AND (valid_to IS NULL OR valid_to > now())
    ORDER BY created_at ASC, id ASC`;
  if (claims.length === 0) {
    console.log("no active claims to classify");
    Deno.exit(0);
  }
  console.log(`Classifying ${claims.length} active claim(s). Enter core, archive, or q to stop.`);
  for (const [index, claim] of claims.entries()) {
    const answer = prompt(
      `\n[${index + 1}/${claims.length}] ${claim.predicate}\n${claim.claim}\nvalue: ${JSON.stringify(claim.value)}\nTier [${claim.injection_tier}]:`,
      claim.injection_tier,
    )?.trim().toLowerCase();
    if (answer === "q") {
      console.log("stopped by operator; prior selections remain committed");
      break;
    }
    if (answer !== "core" && answer !== "archive") {
      console.log("invalid choice; claim left unchanged");
      continue;
    }
    await sql`UPDATE claims SET injection_tier = ${answer} WHERE id = ${claim.id}`;
    console.log(`  stamped ${answer}`);
  }
} finally {
  await sql.end();
}