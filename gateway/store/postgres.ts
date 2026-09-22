// Postgres backend: durable vault. Connects as the least-privilege gateway
// role; source_events is unreadable by construction (see vault/migrations).

import postgres from "npm:postgres@3.4.5";
import {
  type Audit,
  type Backend,
  type BundleRepo,
  type Claim,
  type ClaimSource,
  type ConsumeResult,
  evaluateConsume,
  type IssuedBundle,
  type Json,
  type PolicySource,
} from "./types.ts";

type Sql = ReturnType<typeof postgres>;

class PgPolicy implements PolicySource {
  constructor(private readonly sql: Sql) {}
  async active(): Promise<Json> {
    const [row] = await this.sql`SELECT policy_json FROM policies WHERE active`;
    if (!row) throw new Error("no active policy in vault");
    return row.policy_json;
  }
}

class PgClaims implements ClaimSource {
  constructor(private readonly sql: Sql) {}
  async select(subjectRef: string, predicates: string[], injectionTier?: "core"): Promise<Claim[]> {
    if (predicates.length === 0) return [];
    const rows = await this.sql<{ id: string; claim: string; predicate: string; value: string; confidence: number }[]>`
      SELECT id, claim, predicate, value, confidence
      FROM claims
      WHERE subject_ref = ${subjectRef}
        AND predicate = ANY(${predicates})
        AND (${injectionTier ?? null}::text IS NULL OR injection_tier = ${injectionTier ?? null})
        AND superseded_by IS NULL
        AND (valid_from IS NULL OR valid_from <= now())
        AND (valid_to IS NULL OR valid_to > now())
      ORDER BY created_at ASC, id ASC`;
    // Provenance handle must be an opaque name (reference isName regex), not
    // the claim id. Derive a stable short digest so the bundle reveals nothing
    // about vault identifiers while remaining traceable server-side.
    const handles = await Promise.all(rows.map((r) => provenanceHandle(r.id)));
    return rows.map((r, i) => ({
      claim: r.claim,
      predicate: r.predicate,
      value: r.value,
      confidence: Number(r.confidence),
      provenance_handles: [handles[i]],
    }));
  }
}

async function provenanceHandle(claimId: string): Promise<string> {
  const dekHex = Deno.env.get("VAULT_DEK");
  if (!dekHex) throw new Error("VAULT_DEK required for provenance handles");
  const keyBytes = new Uint8Array(dekHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new TextEncoder().encode(claimId);
  const signature = await crypto.subtle.sign("HMAC", key, bytes);
  const hex = [...new Uint8Array(signature)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `prov_${hex}`;
}

class PgBundles implements BundleRepo {
  constructor(private readonly sql: Sql) {}

  // Bundle + issuance receipt in one transaction (spec invariant 8).
  async issue(request: Json, decision: Json, bundle: Json, receipt: Json): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO bundles (id, request_ref, decision_ref, recipient, capabilities, expires_at, single_use,
                             request_json, decision_json, bundle_json)
        VALUES (${bundle.id}, ${bundle.request_ref}, ${bundle.decision_ref}, ${bundle.recipient},
                ${bundle.capabilities}, ${bundle.expires_at}, ${bundle.single_use},
                ${request}, ${decision}, ${bundle})`;
      await insertReceipt(tx, receipt);
    });
  }

  // SELECT ... FOR UPDATE, evaluate, then consumed_at + receipt in the same
  // transaction so concurrent consumers cannot both succeed and a consumed
  // bundle can never exist without its receipt.
  consume(
    bundleId: string,
    action: string,
    now: Date = new Date(),
    onGranted?: (entry: IssuedBundle) => Json,
  ): Promise<ConsumeResult> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ request_json: Json; decision_json: Json; bundle_json: Json; consumed_at: Date | null }[]>`
        SELECT request_json, decision_json, bundle_json, consumed_at
        FROM bundles WHERE id = ${bundleId} FOR UPDATE`;
      const entry: IssuedBundle | undefined = row
        ? {
          request: row.request_json,
          decision: row.decision_json,
          bundle: row.bundle_json,
          consumed_at: row.consumed_at ? row.consumed_at.toISOString() : null,
        }
        : undefined;
      const result = evaluateConsume(entry, bundleId, action, now);
      if (result.ok) {
        if (entry!.bundle.single_use) {
          await tx`UPDATE bundles SET consumed_at = ${now} WHERE id = ${bundleId}`;
          entry!.consumed_at = now.toISOString();
        }
        if (onGranted) await insertReceipt(tx, onGranted(entry!));
      }
      return result;
    }) as Promise<ConsumeResult>;
  }
}

// deno-lint-ignore no-explicit-any
async function insertReceipt(tx: any, r: Json): Promise<void> {
  await tx`
    INSERT INTO receipts (id, operation, actor, request_ref, decision_ref, bundle_ref, outcome,
                          input_digest, output_digest, receipt_json)
    VALUES (${r.id}, ${r.operation}, ${r.actor}, ${r.request_ref}, ${r.decision_ref}, ${r.bundle_ref ?? null},
            ${r.outcome}, ${r.input_digest ?? null}, ${r.output_digest ?? null}, ${r})`;
}

class PgAudit implements Audit {
  constructor(private readonly sql: Sql) {}
  async decision(d: Json): Promise<void> {
    await this.sql`
      INSERT INTO decisions (id, request_ref, decision, reason_codes, decision_json)
      VALUES (${d.id}, ${d.request_ref}, ${d.decision}, ${d.reason_codes ?? []}, ${d})
      ON CONFLICT (id) DO NOTHING`;
  }
  async rejectedAct(r: { bundle_id: string; action: string; code: string; detail: string }): Promise<void> {
    const id = `urn:cl:decision:act-rejected:${crypto.randomUUID()}`;
    const record: Json = { ...r };
    await this.sql`
      INSERT INTO decisions (id, request_ref, decision, reason_codes, decision_json)
      VALUES (${id}, ${r.bundle_id}, 'deny', ${[r.code]}, ${record})`;
  }
  async proposal(p: Json): Promise<void> {
    await this.sql`
      INSERT INTO proposals (id, subject_ref, status, proposal_json)
      VALUES (${p.id}, ${p.subject_ref}, ${p.status}, ${p})
      ON CONFLICT (id) DO NOTHING`;
  }
}

export function postgresBackend(url: string): Backend {
  const sql = postgres(url, { onnotice: () => {}, max: 4 });
  return {
    policy: new PgPolicy(sql),
    claims: new PgClaims(sql),
    bundles: new PgBundles(sql),
    audit: new PgAudit(sql),
    describe: () => `postgres (${new URL(url).host})`,
    close: () => sql.end(),
  };
}
