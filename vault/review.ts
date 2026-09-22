// Human-driven proposal review CLI. Runs as the least-privilege reviewer role.
//
//   deno run review.ts list --reviewer <principal>
//   deno run review.ts show <proposal-id> --reviewer <principal>
//   deno run review.ts approve <proposal-id> [--tier core|archive] --reviewer <principal>
//   deno run review.ts reject <proposal-id> --reason "..." --reviewer <principal>
//   deno run review.ts unpark <proposal-id> --reviewer <principal>
//   deno run review.ts reject-parked --reason "..." --reviewer <principal>
//
// Approving mints a source_event recording the decision, commits the proposed
// claims with provenance to that event, applies add_or_contradict supersede
// semantics, and marks the proposal committed -- all in one transaction.

import postgres from "npm:postgres@3.4.5";
import { encryptPayload } from "./capture/crypto.ts";
import { isName } from "./capture/types.ts";
import { embedClaimsTx } from "./capture/embed_core.ts";

const dbUrl = Deno.env.get("REVIEWER_DATABASE_URL");
const dek = Deno.env.get("VAULT_DEK")!;
const [cmd, ...rest] = Deno.args;

async function hashId(prefix: string, ...parts: string[]): Promise<string> {
  const msg = new TextEncoder().encode(parts.join("|"));
  const buf = await crypto.subtle.digest("SHA-256", msg);
  const hex = [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `urn:cl:${prefix}:${hex}`;
}

function usage(): never {
  console.error("usage: review.ts list | show <id> | approve <id> [--tier core|archive] | reject <id> --reason <text> | unpark <id> | reject-parked [--subject <ref>] --reason <text> [--reviewer <principal>]");
  Deno.exit(1);
}

const reviewerFlagIndex = rest.indexOf("--reviewer");
const reviewerFromFlag = reviewerFlagIndex >= 0 ? rest[reviewerFlagIndex + 1] ?? usage() : undefined;
if (reviewerFlagIndex >= 0) rest.splice(reviewerFlagIndex, 2);
if (rest.includes("--reviewer")) usage();

type InjectionTier = "core" | "archive";
const tierFlagIndex = rest.indexOf("--tier");
const tierFromFlag = tierFlagIndex >= 0 ? rest[tierFlagIndex + 1] ?? usage() : "archive";
if (tierFlagIndex >= 0) rest.splice(tierFlagIndex, 2);
if (rest.includes("--tier") || (tierFromFlag !== "core" && tierFromFlag !== "archive")) usage();
const approvalTier = tierFromFlag as InjectionTier;

function requireReviewer(): string {
  const reviewer = reviewerFromFlag ?? Deno.env.get("REVIEWER_PRINCIPAL");
  if (!reviewer) {
    console.error("REVIEWER_PRINCIPAL or --reviewer <principal> is required");
    usage();
  }
  return reviewer;
}

const reviewer = requireReviewer();

if (!dbUrl || !dek) {
  console.error("REVIEWER_DATABASE_URL and VAULT_DEK are required");
  Deno.exit(1);
}

const sql = postgres(dbUrl, { onnotice: () => {} });

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
    curator_notes?: {
      recommended_tier: InjectionTier;
      replaces_claims: string[];
      net_budget_impact: number;
      demotion_candidates: string[];
    };
  };
  created_at: Date;
  reviewed_at: Date | null;
  reviewer: string | null;
  proposed_tier: InjectionTier;
}

interface ActiveClaimRow {
  id: string;
  predicate: string;
  claim: string;
  value: unknown;
  injection_tier: InjectionTier;
}

const PREFETCH_HEADER = "Approved user context (clptr4p vault, reviewed core claims):";
const DEFAULT_PREFETCH_MAX_CHARS = 11000;

function prefetchMaxChars(): number {
  const raw = Deno.env.get("CLPTR4P_PREFETCH_MAX_CHARS") ?? String(DEFAULT_PREFETCH_MAX_CHARS);
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PREFETCH_MAX_CHARS;
}

function valuePreview(value: unknown, limit = 60): string {
  const rendered = JSON.stringify(value);
  return rendered.length > limit ? `${rendered.slice(0, limit)}...` : rendered;
}

function prefetchLineChars(claim: Pick<ActiveClaimRow, "claim" | "predicate" | "value">): number {
  return `- ${claim.claim} [${claim.predicate} = ${claim.value}]`.length;
}

function printCuratorNotes(p: ProposalRow): void {
  const notes = p.proposal_json.curator_notes;
  if (!notes) return;
  console.log(`  curator advisory: recommended tier ${notes.recommended_tier}; net budget impact ${notes.net_budget_impact} chars`);
  console.log(`    replaces: ${notes.replaces_claims.length ? notes.replaces_claims.join(", ") : "none"}`);
  console.log(`    demotion candidates: ${notes.demotion_candidates.length ? notes.demotion_candidates.join(", ") : "none"}`);
}

async function activeClaimsFor(p: ProposalRow): Promise<ActiveClaimRow[]> {
  const predicates = [...new Set((p.proposal_json.proposed_claims ?? []).map((c) => c.predicate))];
  if (predicates.length === 0) return [];
  return await sql<ActiveClaimRow[]>`
    SELECT id, predicate, claim, value, injection_tier
    FROM claims
    WHERE subject_ref = ${p.subject_ref}
      AND predicate = ANY(${predicates})
      AND superseded_by IS NULL
      AND (valid_from IS NULL OR valid_from <= now())
      AND (valid_to IS NULL OR valid_to > now())
    ORDER BY created_at ASC, id ASC`;
}

async function activeCoreClaims(subjectRef: string): Promise<ActiveClaimRow[]> {
  return await sql<ActiveClaimRow[]>`
    SELECT id, predicate, claim, value, injection_tier
    FROM claims
    WHERE subject_ref = ${subjectRef}
      AND injection_tier = 'core'
      AND superseded_by IS NULL
      AND (valid_from IS NULL OR valid_from <= now())
      AND (valid_to IS NULL OR valid_to > now())
    ORDER BY created_at ASC, id ASC`;
}

async function printReviewPreview(p: ProposalRow): Promise<void> {
  const proposedClaims = p.proposal_json.proposed_claims ?? [];
  const active = await activeClaimsFor(p);
  const activeByPredicate = new Map<string, ActiveClaimRow[]>();
  for (const claim of active) {
    const matches = activeByPredicate.get(claim.predicate) ?? [];
    matches.push(claim);
    activeByPredicate.set(claim.predicate, matches);
  }

  console.log("  supersede preview:");
  for (const proposed of proposedClaims) {
    const matches = activeByPredicate.get(proposed.predicate) ?? [];
    if (matches.length === 0) {
      console.log(`    ${proposed.predicate}: new predicate, no conflict`);
      continue;
    }
    for (const current of matches) {
      console.log(`    ${proposed.predicate}: replaces: ${current.predicate} (current value: ${valuePreview(current.value)})`);
    }
  }

  // Approval is the only tier-stamping action. This is a read-only preview of
  // what choosing --tier core would cost before the reviewer makes that choice.
  const core = await activeCoreClaims(p.subject_ref);
  const replacementIds = new Set(
    p.proposal_json.operation === "add_or_contradict"
      ? active.filter((claim) => claim.injection_tier === "core").map((claim) => claim.id)
      : [],
  );
  const prospective = proposedClaims.map((claim) => ({
    claim: `reviewer-approved proposal asserts ${claim.predicate} is ${JSON.stringify(claim.object.value)}`,
    predicate: claim.predicate,
    value: claim.object.value,
  }));
  const currentChars = PREFETCH_HEADER.length + core.reduce((total, claim) => total + 1 + prefetchLineChars(claim), 0);
  const grossChars = currentChars + prospective.reduce((total, claim) => total + 1 + prefetchLineChars(claim), 0);
  const demotionChars = core.filter((claim) => replacementIds.has(claim.id))
    .reduce((total, claim) => total + 1 + prefetchLineChars(claim), 0);
  const maxChars = prefetchMaxChars();
  if (grossChars > maxChars) {
    console.log(`  core approval budget (if --tier core): gross ${grossChars}/${maxChars} chars; net after replacements ${grossChars - demotionChars}/${maxChars} chars`);
    const demotions = core.filter((claim) => replacementIds.has(claim.id));
    if (demotions.length === 0) {
      console.log("    demotion candidates: none");
    } else {
      console.log("    demotion candidates:");
      for (const claim of demotions) {
        console.log(`      ${claim.predicate}: ${prefetchLineChars(claim)} chars (current value: ${valuePreview(claim.value)})`);
      }
    }
  }
}

async function loadProposal(id: string): Promise<ProposalRow | undefined> {
  const [row] = await sql<ProposalRow[]>`
    SELECT id, subject_ref, status, proposal_json, created_at, reviewed_at, reviewer, proposed_tier
    FROM proposals WHERE id = ${id}`;
  return row;
}

function assertApprovable(p: ProposalRow): void {
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
    SELECT id, subject_ref, status, proposal_json, created_at, reviewed_at, reviewer, proposed_tier
    FROM proposals WHERE status IN ('pending_validation', 'parked') ORDER BY created_at`;
  if (rows.length === 0) {
    console.log("no pending proposals");
    return;
  }
  for (const p of rows) {
    const claims = (p.proposal_json.proposed_claims ?? [])
      .map((c) => `${c.predicate}=${JSON.stringify(c.object.value)}@${c.confidence}`).join(", ");
    console.log(`${p.id}`);
    console.log(`  subject:  ${p.subject_ref}`);
    console.log(`  status:   ${p.status}  op: ${p.proposal_json.operation ?? "add"}  tier: ${p.proposed_tier}`);
    console.log(`  claims:   ${claims}`);
    console.log(`  by:       ${p.proposal_json.submitted_by ?? "?"}  expires: ${p.proposal_json.expires_at ?? "?"}`);
    console.log(`  why:      ${p.proposal_json.rationale ?? "(no rationale)"}`);
    printCuratorNotes(p);
    await printReviewPreview(p);
    console.log();
  }
}

async function show(id: string): Promise<void> {
  const p = await loadProposal(id);
  if (!p) fail(`proposal ${id} not found`);
  console.log(JSON.stringify(p.proposal_json, null, 2));
  console.log(`-- status: ${p.status}  tier: ${p.proposed_tier}  reviewed_at: ${p.reviewed_at ?? "-"}  reviewer: ${p.reviewer ?? "-"}`);
  printCuratorNotes(p);
  await printReviewPreview(p);
}

async function commit(id: string, action: "committed" | "rejected", reason?: string, tier: InjectionTier = "archive"): Promise<void> {
  const p = await loadProposal(id);
  if (!p) fail(`proposal ${id} not found`);
  if (action === "committed") assertApprovable(p);
  if (action === "rejected" && p.status !== "pending_validation" && p.status !== "parked") {
    fail(`proposal is ${p.status}, not pending_validation or parked`);
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // Deterministic decision event: id stable per (proposal, reviewer, action).
  const payload = { proposal_id: id, action, reviewer, reason: reason ?? null, injection_tier: action === "committed" ? tier : null, approved_claims: action === "committed" ? (p.proposal_json.proposed_claims ?? []).map((c) => c.predicate) : [] };
  const { digest, encrypted } = await encryptPayload(payload, dek);
  const eventId = await hashId("event", p.subject_ref, "review", reviewer, id, action, digest);

  const claimCount = action === "committed" ? (p.proposal_json.proposed_claims ?? []).length : 0;

  await sql.begin(async (tx) => {
    // Re-check under lock; another reviewer may have just acted.
    const [fresh] = await tx`SELECT status FROM proposals WHERE id = ${id} FOR UPDATE`;
    if (action === "committed" && fresh.status !== "pending_validation") throw new Error(`proposal is already ${fresh.status}`);
    if (action === "rejected" && fresh.status !== "pending_validation" && fresh.status !== "parked") {
      throw new Error(`proposal is already ${fresh.status}`);
    }

    // Plain INSERT: the status re-check under FOR UPDATE makes minting the same
    // decision event twice impossible, and no SELECT grant is needed (which
    // would also permit count(*) on raw evidence).
    await tx`
      INSERT INTO source_events (id, subject_ref, origin, actor, occurred_at, visibility, payload_digest, payload_encrypted)
      VALUES (${eventId}, ${p.subject_ref}, 'review', ${reviewer}, ${nowIso}, 'private', ${digest}, ${encrypted})`;

    // Claims are committed on approve ONLY. Rejection mints the decision event
    // but must not write any claims (guard explicitly on the action).
    const committed: { id: string; claim: string; value: unknown }[] = [];
    if (action === "committed") {
      for (const c of p.proposal_json.proposed_claims ?? []) {
      const claimId = await hashId("claim", p.subject_ref, c.predicate, JSON.stringify(c.object.value), eventId);
      const claimText = `reviewer-approved proposal asserts ${c.predicate} is ${JSON.stringify(c.object.value)}`;

      await tx`
        INSERT INTO claims (id, subject_ref, predicate, claim, value, datatype, confidence, valid_from, injection_tier)
        VALUES (${claimId}, ${p.subject_ref}, ${c.predicate}, ${claimText}, ${sql.json(c.object.value as any)},
                ${c.object.datatype ?? "json"}, ${c.confidence}, ${nowIso}, ${tier})
        ON CONFLICT (id) DO NOTHING`;

      committed.push({ id: claimId, claim: claimText, value: c.object.value });

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

      // Hook: embed approved claims inline. On failure the whole txn rolls
      // back INCLUDING the claims -- an approved proposal with no embedding is
      // a failed approve; the proposal stays pending and can be re-approved.
      if (committed.length > 0) {
        try {
          await embedClaimsTx(tx, committed);
        } catch (e) {
          throw new Error(`embedding failed, approve rolled back: ${(e as Error).message}`);
        }
      }
    }

    await tx`
      UPDATE proposals
      SET status = ${action}, reviewed_at = ${nowIso}, reviewer = ${reviewer},
          proposed_tier = CASE WHEN ${action} = 'committed' THEN ${tier} ELSE proposed_tier END
      WHERE id = ${id}`;
  });

  console.log(`${action} ${id} (event ${eventId}, ${claimCount} claim(s))`);
}

async function unpark(id: string): Promise<void> {
  const p = await loadProposal(id);
  if (!p) fail(`proposal ${id} not found`);
  if (p.status !== "parked") fail(`proposal is ${p.status}, not parked`);
  await sql.begin(async (tx) => {
    const [fresh] = await tx`SELECT status FROM proposals WHERE id = ${id} FOR UPDATE`;
    if (!fresh || fresh.status !== "parked") throw new Error(`proposal is already ${fresh?.status ?? "gone"}`);
    await tx`UPDATE proposals SET status = 'pending_validation' WHERE id = ${id}`;
  });
  console.log(`unparked ${id}`);
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
      await commit(rest[0] ?? usage(), "committed", undefined, approvalTier);
      break;
    case "reject": {
      const idx = rest.indexOf("--reason");
      const reason = idx >= 0 ? rest[idx + 1] : undefined;
      await commit(rest[0] ?? usage(), "rejected", reason);
      break;
    }
    case "unpark":
      await unpark(rest[0] ?? usage());
      break;
    case "reject-parked": {
      const idx = rest.indexOf("--reason");
      const reason = idx >= 0 ? rest[idx + 1] : undefined;
      const subjectIdx = rest.indexOf("--subject");
      const subject = subjectIdx >= 0 ? rest[subjectIdx + 1] : undefined;
      if (!reason) usage();
      if (subjectIdx >= 0 && !subject) usage();
      const rows = subject
        ? await sql<ProposalRow[]>`SELECT id FROM proposals WHERE status = 'parked' AND subject_ref = ${subject} ORDER BY created_at`
        : await sql<ProposalRow[]>`SELECT id FROM proposals WHERE status = 'parked' ORDER BY created_at`;
      for (const p of rows) await commit(p.id, "rejected", reason);
      console.log(`cleared ${rows.length} parked proposal(s)`);
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
