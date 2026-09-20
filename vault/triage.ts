// Auto-triage for the proposal review queue. Runs as the least-privilege
// reviewer role but may ONLY REJECT: a rejection mints a decision event and
// commits zero claims (the same invariant review.ts enforces), so automated
// closing can never bypass human consent. Approval stays human-only, always.
//
//   deno run triage.ts                 # apply rules, log decisions + survivors
//   deno run triage.ts --dry-run       # show what would happen, write nothing
//   deno run triage.ts --format digest # survivor digest; silent when idle
//
// Rules (deterministic, first match wins):
//   expired   -- past expires_at: the human CLI can no longer act on it, so
//                it would sit in the queue forever.
//   empty     -- no proposed claims: nothing to commit.
//   ungranted -- a predicate outside the active policy's allowed_selectors:
//                even approval could never serve the claim.
//   duplicate -- every proposed claim already exists as an active claim
//                (same subject, predicate, value): approval would be a no-op.
// Anything else survives for human review. Malformed proposals (unparseable
// expires_at, non-array claims) are kept and flagged, never auto-closed.

import postgres from "npm:postgres@3.4.5";
import { encryptPayload } from "./capture/crypto.ts";

const dbUrl = Deno.env.get("REVIEWER_DATABASE_URL");
const dek = Deno.env.get("VAULT_DEK")!;
const principal = Deno.env.get("TRIAGE_PRINCIPAL") ?? "urn:cl:triage";
const dryRun = Deno.args.includes("--dry-run");
const formatIdx = Deno.args.indexOf("--format");
const format = formatIdx >= 0 ? Deno.args[formatIdx + 1] : "log";

if (!dbUrl || !dek) {
  console.error("REVIEWER_DATABASE_URL and VAULT_DEK are required");
  Deno.exit(1);
}
if (format !== "log" && format !== "digest") {
  console.error("--format must be log or digest");
  Deno.exit(1);
}

const sql = postgres(dbUrl, { onnotice: () => {} });

interface ProposalRow {
  id: string;
  subject_ref: string;
  proposal_json: {
    proposed_claims?: { predicate: string; object: { value: unknown } }[];
    rationale?: string;
    expires_at?: string;
    submitted_by?: string;
  };
}

interface Decision {
  rule: "expired" | "empty" | "ungranted" | "duplicate";
  reason: string;
}

async function hashId(prefix: string, ...parts: string[]): Promise<string> {
  const msg = new TextEncoder().encode(parts.join("|"));
  const buf = await crypto.subtle.digest("SHA-256", msg);
  const hex = [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `urn:cl:${prefix}:${hex}`;
}

// Stable JSON rendering (sorted object keys) so proposal values and jsonb
// round-tripped claim values compare equal regardless of key order.
function norm(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(norm).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${norm((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

async function loadActiveSelectors(): Promise<Set<string>> {
  const [row] = await sql<{ policy_json: { allowed_selectors?: string[] } }[]>`
    SELECT policy_json FROM policies WHERE active`;
  if (!row) throw new Error("no active policy -- failing closed, nothing auto-closed");
  return new Set(row.policy_json.allowed_selectors ?? []);
}

// Active claims per subject (for the duplicate rule), cached per run.
const subjectClaims = new Map<string, Map<string, string>>(); // subject -> predicate -> [norm(value)]
async function activeClaims(subject: string): Promise<Map<string, string>> {
  const cached = subjectClaims.get(subject);
  if (cached) return cached;
  const rows = await sql<{ predicate: string; value: unknown }[]>`
    SELECT predicate, value FROM claims
    WHERE subject_ref = ${subject} AND superseded_by IS NULL`;
  const byPredicate = new Map<string, string>();
  for (const r of rows) {
    byPredicate.set(r.predicate, (byPredicate.get(r.predicate) ?? "").concat("\x00", norm(r.value)));
  }
  subjectClaims.set(subject, byPredicate);
  return byPredicate;
}

async function decide(p: ProposalRow, granted: Set<string>): Promise<Decision | null> {
  const expiresAt = p.proposal_json.expires_at ? Date.parse(p.proposal_json.expires_at) : NaN;
  if (!Number.isNaN(expiresAt) && Date.now() >= expiresAt) {
    return { rule: "expired", reason: "auto-triage: expired before review" };
  }
  const claims = Array.isArray(p.proposal_json.proposed_claims) ? p.proposal_json.proposed_claims : null;
  if (!claims) return null; // malformed -- keep for the human
  if (claims.length === 0) {
    return { rule: "empty", reason: "auto-triage: proposal contains no claims" };
  }
  const ungranted = [...new Set(claims.map((c) => c.predicate))].filter((pred) => !granted.has(pred));
  if (ungranted.length > 0) {
    return {
      rule: "ungranted",
      reason: `auto-triage: predicate(s) not granted by active policy: ${ungranted.join(", ")} (claim could never serve)`,
    };
  }
  const active = await activeClaims(p.subject_ref);
  const allDupes = claims.every((c) => {
    const values = active.get(c.predicate);
    return values !== undefined && values.includes(norm(c.object?.value));
  });
  if (allDupes) {
    return { rule: "duplicate", reason: "auto-triage: verbatim duplicate of active claim(s) -- approval would be a no-op" };
  }
  return null;
}

async function close(p: ProposalRow, reason: string): Promise<string> {
  const payload = { proposal_id: p.id, action: "rejected", reviewer: principal, reason, auto: true };
  const { digest, encrypted } = await encryptPayload(payload, dek);
  const eventId = await hashId("event", p.subject_ref, "review", principal, p.id, "rejected", digest);
  const nowIso = new Date().toISOString();
  await sql.begin(async (tx) => {
    const [fresh] = await tx`SELECT status FROM proposals WHERE id = ${p.id} FOR UPDATE`;
    if (!fresh || fresh.status !== "pending_validation") {
      throw new Error(`proposal is already ${fresh?.status ?? "gone"}`);
    }
    await tx`
      INSERT INTO source_events (id, subject_ref, origin, actor, occurred_at, visibility, payload_digest, payload_encrypted)
      VALUES (${eventId}, ${p.subject_ref}, 'review', ${principal}, ${nowIso}, 'private', ${digest}, ${encrypted})`;
    await tx`
      UPDATE proposals
      SET status = 'rejected', reviewed_at = ${nowIso}, reviewer = ${principal}
      WHERE id = ${p.id}`;
  });
  return eventId;
}

function shortClaims(p: ProposalRow): string {
  return (p.proposal_json.proposed_claims ?? [])
    .map((c) => `${c.predicate}=${JSON.stringify(c.object?.value)}`)
    .join(", ");
}

try {
  const pending = await sql<ProposalRow[]>`
    SELECT id, subject_ref, proposal_json FROM proposals
    WHERE status = 'pending_validation' ORDER BY created_at`;

  if (pending.length === 0) {
    if (format === "log") console.log("no pending proposals");
    await sql.end();
    Deno.exit(0);
  }

  const granted = await loadActiveSelectors();
  const counts = { expired: 0, empty: 0, ungranted: 0, duplicate: 0 };
  const survivors: ProposalRow[] = [];

  for (const p of pending) {
    let d: Decision | null = null;
    try {
      d = await decide(p, granted);
    } catch (e) {
      console.error(`warn: rule eval failed for ${p.id}, keeping for human review: ${(e as Error).message}`);
      survivors.push(p);
      continue;
    }
    if (!d) {
      survivors.push(p);
      continue;
    }
    counts[d.rule]++;
    if (dryRun) {
      console.log(`would reject ${p.id} -- ${d.reason}`);
      continue;
    }
    const eventId = await close(p, d.reason);
    console.log(`rejected ${p.id} (event ${eventId}) -- ${d.reason}`);
  }

  const closed = counts.expired + counts.empty + counts.ungranted + counts.duplicate;

  if (format === "digest") {
    if (closed === 0 && survivors.length === 0) Deno.exit(0); // idle: print nothing
    const parts: string[] = [];
    if (closed > 0) {
      const breakdown = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ");
      parts.push(`clptr4p auto-triage closed ${closed} proposal(s) (${breakdown}).`);
    }
    if (survivors.length > 0) {
      parts.push(`${survivors.length} proposal(s) need your eyes:`);
      for (const p of survivors) {
        parts.push(`\n${p.id}`);
        parts.push(`  claims: ${shortClaims(p)}`);
        parts.push(`  why:    ${p.proposal_json.rationale ?? "(no rationale)"}`);
        parts.push(`  reply "approve ${p.id}", "reject ${p.id} because ...", or inspect: /mnt/bro/thinktank/clptr4p/scripts/review.sh show ${p.id}`);
      }
    }
    console.log(parts.join("\n"));
  } else {
    console.log(`\nauto-closed ${closed} (expired ${counts.expired}, empty ${counts.empty}, ungranted ${counts.ungranted}, duplicate ${counts.duplicate})`);
    console.log(`survivors (need human review): ${survivors.length}`);
    for (const p of survivors) {
      console.log(`  ${p.id}`);
      console.log(`    claims: ${shortClaims(p)}`);
      console.log(`    why:    ${p.proposal_json.rationale ?? "(no rationale)"}`);
    }
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  Deno.exit(1);
} finally {
  await sql.end();
}
