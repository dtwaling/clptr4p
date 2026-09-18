// Human-driven proposal review CLI. Runs as the least-privilege reviewer role.
//
//   deno run review.ts list
//   deno run review.ts show <proposal-id>
//   deno run review.ts approve <proposal-id>
//   deno run review.ts reject <proposal-id> --reason "..."
//
// Approving mints a source_event recording the decision, commits the proposed
// claims with provenance to that event, applies add_or_contradict supersede
// semantics, and marks the proposal committed -- all in one transaction.

import postgres from "npm:postgres@3.4.5";
import { encryptPayload } from "./capture/crypto.ts";
import { isName } from "./capture/types.ts";

const dbUrl = Deno.env.get("REVIEWER_DATABASE_URL");
const dek = Deno.env.get("VAULT_DEK")!;
const reviewer = Deno.env.get("REVIEWER_PRINCIPAL") ?? "urn:user:reviewer";

if (!dbUrl || !dek) {
  console.error("REVIEWER_DATABASE_URL and VAULT_DEK are required");
  Deno.exit(1);
}

const [cmd, ...rest] = Deno.args;
const sql = postgres(dbUrl, { onnotice: () => {} });

async function hashId(prefix: string, ...parts: string[]): Promise<string> {
  const msg = new TextEncoder().encode(parts.join("|"));
  const buf = await crypto.subtle.digest("SHA-256", msg);
  const hex = [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `urn:cl:${prefix}:${hex}`;
}

function usage(): never {
  console.error("usage: review.ts list | show <id> | approve <id> | reject <id> --reason <text>");
  Deno.exit(1);
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  Deno.exit(1);
}

interface ProposalRow {
  id: string;
  subject_ref: string;
  status: string;
  proposal_json: {
    operation?: string;
    proposed_claims?: { predicate: string; object: { value: unknown; datatype?: string }; confidence: number }[];
    rationale?: string;
    expires_at?: string;
    submitted_by?: string;
  };
  created_at: Date;
  reviewed_at: Date | null;
  reviewer: string | null;
}

async function loadProposal(id: string): Promise<ProposalRow | undefined> {
  const [row] = await sql<ProposalRow[]>`
    SELECT id, subject_ref, status, proposal_json, created_at, reviewed_at, reviewer
    FROM proposals WHERE id = ${id}`;
  return row;
}

function assertReviewable(p: ProposalRow): void {
  if (p.status !== "pending_validation") fail(`proposal is ${p.status}, not pending_validation`);
  const expiresAt = p.proposal_json.expires_at ? Date.parse(p.proposal_json.expires_at) : NaN;
  if (Number.isNaN(expiresAt)) fail("proposal has no parseable expires_at");
  if (Date.now() >= expiresAt) fail("proposal has expired");
  for (const [i, c] of (p.proposal_json.proposed_claims ?? []).entries()) {
    if (!isName(c.predicate)) fail(`proposed_claims[${i}].predicate is not an opaque name`);
    if (typeof c.confidence !== "number" || c.confidence < 0 || c.confidence > 1) {
      fail(`proposed_claims[${i}].confidence must be 0.0 - 1.0`);
    }
  }
}

async function listPending(): Promise<void> {
  const rows = await sql<ProposalRow[]>`
    SELECT id, subject_ref, status, proposal_json, created_at, reviewed_at, reviewer
    FROM proposals WHERE status = 'pending_validation' ORDER BY created_at`;
  if (rows.length === 0) {
    console.log("no pending proposals");
    return;
  }
  for (const p of rows) {
    const claims = (p.proposal_json.proposed_claims ?? [])
      .map((c) => `${c.predicate}=${JSON.stringify(c.object.value)}@${c.confidence}`).join(", ");
    console.log(`${p.id}`);
    console.log(`  subject:  ${p.subject_ref}`);
    console.log(`  op:       ${p.proposal_json.operation ?? "add"}`);
    console.log(`  claims:   ${claims}`);
    console.log(`  by:       ${p.proposal_json.submitted_by ?? "?"}  expires: ${p.proposal_json.expires_at ?? "?"}`);
    console.log(`  why:      ${p.proposal_json.rationale ?? "(no rationale)"}`);
    console.log();
  }
}

async function show(id: string): Promise<void> {
  const p = await loadProposal(id);
  if (!p) fail(`proposal ${id} not found`);
  console.log(JSON.stringify(p.proposal_json, null, 2));
  console.log(`-- status: ${p.status}  reviewed_at: ${p.reviewed_at ?? "-"}  reviewer: ${p.reviewer ?? "-"}`);
}

async function commit(id: string, action: "committed" | "rejected", reason?: string): Promise<void> {
  const p = await loadProposal(id);
  if (!p) fail(`proposal ${id} not found`);
  assertReviewable(p);

  const now = new Date();
  const nowIso = now.toISOString();

  // Deterministic decision event: id stable per (proposal, reviewer, action).
  const payload = { proposal_id: id, action, reviewer, reason: reason ?? null, approved_claims: action === "committed" ? (p.proposal_json.proposed_claims ?? []).map((c) => c.predicate) : [] };
  const { digest, encrypted } = await encryptPayload(payload, dek);
  const eventId = await hashId("event", p.subject_ref, "review", reviewer, id, action, digest);

  const claimCount = action === "committed" ? (p.proposal_json.proposed_claims ?? []).length : 0;

  await sql.begin(async (tx) => {
    // Re-check under lock; another reviewer may have just acted.
    const [fresh] = await tx`SELECT status FROM proposals WHERE id = ${id} FOR UPDATE`;
    if (fresh.status !== "pending_validation") throw new Error(`proposal is already ${fresh.status}`);

    // Plain INSERT: the status re-check under FOR UPDATE makes minting the same
    // decision event twice impossible, and no SELECT grant is needed (which
    // would also permit count(*) on raw evidence).
    await tx`
      INSERT INTO source_events (id, subject_ref, origin, actor, occurred_at, visibility, payload_digest, payload_encrypted)
      VALUES (${eventId}, ${p.subject_ref}, 'review', ${reviewer}, ${nowIso}, 'private', ${digest}, ${encrypted})`;

    // Claims are committed on approve ONLY. Rejection mints the decision event
    // but must not write any claims (guard explicitly on the action).
    if (action === "committed") {
      for (const c of p.proposal_json.proposed_claims ?? []) {
      const claimId = await hashId("claim", p.subject_ref, c.predicate, JSON.stringify(c.object.value), eventId);
      const claimText = `reviewer-approved proposal asserts ${c.predicate} is ${JSON.stringify(c.object.value)}`;

      await tx`
        INSERT INTO claims (id, subject_ref, predicate, claim, value, datatype, confidence, valid_from)
        VALUES (${claimId}, ${p.subject_ref}, ${c.predicate}, ${claimText}, ${sql.json(c.object.value as any)},
                ${c.object.datatype ?? "json"}, ${c.confidence}, ${nowIso})
        ON CONFLICT (id) DO NOTHING`;

      await tx`
        INSERT INTO claim_sources (claim_id, source_event_id)
        VALUES (${claimId}, ${eventId})
        ON CONFLICT DO NOTHING`;

      if (p.proposal_json.operation === "add_or_contradict") {
        await tx`
          UPDATE claims
          SET superseded_by = ${claimId}, valid_to = ${nowIso}
          WHERE subject_ref = ${p.subject_ref}
            AND predicate = ${c.predicate}
            AND superseded_by IS NULL
            AND id != ${claimId}`;
      }
      }
    }

    await tx`
      UPDATE proposals
      SET status = ${action}, reviewed_at = ${nowIso}, reviewer = ${reviewer}
      WHERE id = ${id}`;
  });

  console.log(`${action} ${id} (event ${eventId}, ${claimCount} claim(s))`);
}

try {
  switch (cmd) {
    case "list":
      await listPending();
      break;
    case "show":
      await show(rest[0] ?? usage());
      break;
    case "approve":
      await commit(rest[0] ?? usage(), "committed");
      break;
    case "reject": {
      const idx = rest.indexOf("--reason");
      const reason = idx >= 0 ? rest[idx + 1] : undefined;
      await commit(rest[0] ?? usage(), "rejected", reason);
      break;
    }
    default:
      usage();
  }
} catch (e) {
  fail((e as Error).message);
} finally {
  await sql.end();
}
