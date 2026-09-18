import postgres from "npm:postgres@3.4.5";
import { validateEnvelope } from "./types.ts";
import { encryptPayload } from "./crypto.ts";
import { embedClaimsTx } from "./embed_core.ts";

const dbUrl = Deno.env.get("CAPTURE_DATABASE_URL");
const dek = Deno.env.get("VAULT_DEK");
const filePath = Deno.args[0];

if (!dbUrl || !dek || !filePath) {
  console.error("Usage: CAPTURE_DATABASE_URL=... VAULT_DEK=... deno run ingest.ts <envelope.json>");
  Deno.exit(1);
}

const raw = JSON.parse(Deno.readTextFileSync(filePath));
validateEnvelope(raw);

const { digest, encrypted } = await encryptPayload(raw.payload, dek);

async function hashId(prefix: string, ...parts: string[]): Promise<string> {
  const msg = new TextEncoder().encode(parts.join("|"));
  const buf = await crypto.subtle.digest("SHA-256", msg);
  const hex = [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `urn:cl:${prefix}:${hex}`;
}

const eventId = await hashId("event", raw.subject_ref, raw.origin, raw.actor, raw.occurred_at, digest);

const sql = postgres(dbUrl, { onnotice: () => {} });

// Claims newly inserted by this run (conflicts are re-ingests); hoisted so the
// summary line after the transaction can report the inline-embed count.
const inserted: { id: string; claim: string; value: unknown }[] = [];

try {
  await sql.begin(async (tx) => {
    // 1. Insert source event (idempotent)
    await tx`
      INSERT INTO source_events (id, subject_ref, origin, actor, occurred_at, visibility, payload_digest, payload_encrypted)
      VALUES (${eventId}, ${raw.subject_ref}, ${raw.origin}, ${raw.actor}, ${raw.occurred_at}, ${raw.visibility}, ${digest}, ${encrypted})
      ON CONFLICT (id) DO NOTHING
    `;

    // 2. Insert claims and link provenance
    for (const c of raw.claims) {
      const claimId = await hashId("claim", raw.subject_ref, c.predicate, JSON.stringify(c.value), eventId);
      
      await tx`
        INSERT INTO claims (id, subject_ref, predicate, claim, value, datatype, confidence, valid_from)
        VALUES (${claimId}, ${raw.subject_ref}, ${c.predicate}, ${c.claim}, ${sql.json(c.value as any)}, ${c.datatype ?? "json"}, ${c.confidence}, ${raw.occurred_at})
        ON CONFLICT (id) DO NOTHING
      `;

      await tx`
        INSERT INTO claim_sources (claim_id, source_event_id)
        VALUES (${claimId}, ${eventId})
        ON CONFLICT DO NOTHING
      `;

      // Only newly inserted claims need embedding; conflicts are re-ingests.
      // deno-lint-ignore no-explicit-any
      const [{ n }]: any = await tx`SELECT count(*)::int AS n FROM claims WHERE id = ${claimId} AND embedding IS NULL`;
      if (n > 0) inserted.push({ id: claimId, claim: c.claim, value: c.value });

      if (c.supersede) {
        await tx`
          UPDATE claims 
          SET superseded_by = ${claimId}, valid_to = ${raw.occurred_at}
          WHERE subject_ref = ${raw.subject_ref} 
            AND predicate = ${c.predicate} 
            AND superseded_by IS NULL 
            AND id != ${claimId}
        `;
      }
    }

    // 3. Hook: embed the new claims inline. On failure the whole txn rolls
    // back INCLUDING the claims -- a claim without its embedding is treated as
    // a failed ingest; the envelope can be re-ingested (idempotent).
    if (inserted.length > 0) {
      try {
        await embedClaimsTx(tx, inserted);
      } catch (e) {
        throw new Error(`embedding failed, ingest rolled back: ${(e as Error).message}`);
      }
    }
  });
  const embedded = inserted.length;
  console.log(`Ingested event ${eventId} with ${raw.claims.length} claims (${embedded} embedded).`);
} finally {
  await sql.end();
}
