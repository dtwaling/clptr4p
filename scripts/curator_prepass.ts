// Advisory-only curator pre-pass for pending human-review proposals.
//
// The curator role can update only proposals.proposal_json. It never receives
// VAULT_DEK and never writes claims, proposal status, or injection tiers.
// Failures are intentionally fail-open: failed rows remain unannotated.

import postgres from "npm:postgres@3.4.5";
import { resolveApiKey } from "../vault/capture/embed_core.ts";

type Tier = "core" | "archive";
type ProposedClaim = { predicate?: string; object?: { value?: unknown } };
type CuratorNotes = {
  recommended_tier: Tier;
  replaces_claims: string[];
  net_budget_impact: number;
  demotion_candidates: string[];
};
type ProposalJson = {
  operation?: string;
  proposed_claims?: ProposedClaim[];
  curator_notes?: CuratorNotes;
  [key: string]: unknown;
};
type ProposalRow = { id: string; subject_ref: string; proposal_json: ProposalJson };
type ClaimRow = { id: string; predicate: string; claim: string; value: unknown; injection_tier: Tier };
type CuratorConfig = { provider: string; model: string; base_url: string; api_key: string; timeout: number };

const dbUrl = Deno.env.get("CURATOR_DATABASE_URL");
const configPath = Deno.env.get("CLPTR4P_CURATOR_CONFIG") ?? `${Deno.env.get("HOME")}/.hermes/config.yaml`;
const mockResponse = Deno.env.get("CLPTR4P_CURATOR_MOCK_RESPONSE");
const PREFETCH_HEADER = "Approved user context (clptr4p vault, reviewed core claims):";

function fail(message: string): never {
  throw new Error(message);
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Parse only the small, fixed auxiliary.curator YAML mapping we need. Hermes
// owns config.yaml; this avoids adding a YAML parser to the vault dependency
// surface and deliberately ignores every unrelated config value.
function readCuratorConfig(path: string): CuratorConfig {
  const lines = Deno.readTextFileSync(path).split("\n");
  let auxiliaryIndent: number | undefined;
  let curatorIndent: number | undefined;
  const values = new Map<string, string>();
  for (const line of lines) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = line.match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) continue;
    const [, whitespace, key, raw] = match;
    const indent = whitespace.length;
    if (key === "auxiliary" && indent === 0) {
      auxiliaryIndent = indent;
      curatorIndent = undefined;
      continue;
    }
    if (auxiliaryIndent === undefined || indent <= auxiliaryIndent) continue;
    if (key === "curator" && indent > auxiliaryIndent && raw.trim() === "") {
      curatorIndent = indent;
      continue;
    }
    if (curatorIndent !== undefined && indent > curatorIndent) values.set(key, scalar(raw));
  }
  const provider = values.get("provider");
  const model = values.get("model");
  if (!provider || !model) fail("auxiliary.curator provider and model are required");
  const timeout = Number.parseInt(values.get("timeout") ?? "600", 10);
  return {
    provider,
    model,
    base_url: values.get("base_url") ?? "",
    api_key: values.get("api_key") ?? "",
    timeout: Number.isSafeInteger(timeout) && timeout > 0 ? timeout : 600,
  };
}

function prefetchLineChars(claim: Pick<ClaimRow, "claim" | "predicate" | "value">): number {
  return `- ${claim.claim} [${claim.predicate} = ${claim.value}]`.length;
}

function parseRecommendedTier(body: string): Tier {
  const parsed = JSON.parse(body) as { recommended_tier?: unknown };
  if (parsed.recommended_tier !== "core" && parsed.recommended_tier !== "archive") {
    fail("curator response must be JSON with recommended_tier core or archive");
  }
  return parsed.recommended_tier;
}

async function recommendTier(config: CuratorConfig, proposal: ProposalRow): Promise<Tier> {
  if (mockResponse !== undefined) return parseRecommendedTier(mockResponse);

  // MoA uses Hermes' internal moa://local virtual endpoint, which is not an
  // HTTP provider endpoint. A configured HTTP base_url is required for a
  // standalone pre-pass; absent one, leave the queue untouched.
  if (!config.base_url) fail(`curator provider ${config.provider} has no HTTP base_url`);
  const apiKey = config.api_key || resolveApiKey();
  const endpoint = config.base_url.replace(/\/$/, "").endsWith("/chat/completions")
    ? config.base_url.replace(/\/$/, "")
    : `${config.base_url.replace(/\/$/, "")}/chat/completions`;
  const prompt = [
    "You are an advisory curator for a human-reviewed memory vault.",
    "Return JSON only: {\"recommended_tier\":\"core\"|\"archive\"}.",
    "Recommend core only when this proposal is durable, high-value context likely needed in most future sessions. You cannot approve, reject, write claims, or override a human.",
    JSON.stringify({ id: proposal.id, subject_ref: proposal.subject_ref, proposal: proposal.proposal_json }),
  ].join("\n");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
    signal: AbortSignal.timeout(config.timeout * 1000),
  });
  if (!response.ok) fail(`curator completion failed: HTTP ${response.status}`);
  const payload = await response.json() as { choices?: { message?: { content?: unknown } }[] };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") fail("curator completion did not return message content");
  return parseRecommendedTier(content);
}

async function activeClaimsFor(sql: postgres.Sql, proposal: ProposalRow): Promise<ClaimRow[]> {
  const predicates = [...new Set((proposal.proposal_json.proposed_claims ?? [])
    .map((claim) => claim.predicate)
    .filter((predicate): predicate is string => typeof predicate === "string"))];
  if (predicates.length === 0) return [];
  return await sql<ClaimRow[]>`
    SELECT id, predicate, claim, value, injection_tier
    FROM claims
    WHERE subject_ref = ${proposal.subject_ref}
      AND predicate = ANY(${predicates})
      AND superseded_by IS NULL
      AND (valid_from IS NULL OR valid_from <= now())
      AND (valid_to IS NULL OR valid_to > now())
    ORDER BY created_at ASC, id ASC`;
}

async function activeCoreClaims(sql: postgres.Sql, subjectRef: string): Promise<ClaimRow[]> {
  return await sql<ClaimRow[]>`
    SELECT id, predicate, claim, value, injection_tier
    FROM claims
    WHERE subject_ref = ${subjectRef}
      AND injection_tier = 'core'
      AND superseded_by IS NULL
      AND (valid_from IS NULL OR valid_from <= now())
      AND (valid_to IS NULL OR valid_to > now())
    ORDER BY created_at ASC, id ASC`;
}

async function deterministicNotes(sql: postgres.Sql, proposal: ProposalRow, recommendedTier: Tier): Promise<CuratorNotes> {
  const active = await activeClaimsFor(sql, proposal);
  const core = await activeCoreClaims(sql, proposal.subject_ref);
  const replacementIds = proposal.proposal_json.operation === "add_or_contradict"
    ? new Set(active.map((claim) => claim.id))
    : new Set<string>();
  const proposedChars = (proposal.proposal_json.proposed_claims ?? []).reduce((total, proposed) => {
    const predicate = typeof proposed.predicate === "string" ? proposed.predicate : "?";
    const value = proposed.object?.value;
    return total + 1 + `- reviewer-approved proposal asserts ${predicate} is ${JSON.stringify(value)} [${predicate} = ${value}]`.length;
  }, 0);
  const replacedCoreChars = core.filter((claim) => replacementIds.has(claim.id))
    .reduce((total, claim) => total + 1 + prefetchLineChars(claim), 0);
  return {
    recommended_tier: recommendedTier,
    replaces_claims: [...replacementIds],
    net_budget_impact: proposedChars - replacedCoreChars,
    demotion_candidates: core.filter((claim) => replacementIds.has(claim.id)).map((claim) => claim.id),
  };
}

if (!dbUrl) {
  console.error("CURATOR_DATABASE_URL required (source vault/.env)");
  Deno.exit(1);
}

const sql = postgres(dbUrl, { onnotice: () => {} });
try {
  const config = readCuratorConfig(configPath);
  const pending = await sql<ProposalRow[]>`
    SELECT id, subject_ref, proposal_json
    FROM proposals
    WHERE status = 'pending_validation'
      AND proposal_json->>'curator_notes' IS NULL
    ORDER BY created_at`;
  for (const proposal of pending) {
    try {
      const recommendedTier = await recommendTier(config, proposal);
      const curatorNotes = await deterministicNotes(sql, proposal, recommendedTier);
      const proposalJson = { ...proposal.proposal_json, curator_notes: curatorNotes };
      const result = await sql`
        UPDATE proposals
        SET proposal_json = ${sql.json(proposalJson as any)}
        WHERE id = ${proposal.id}
          AND status = 'pending_validation'
          AND proposal_json->>'curator_notes' IS NULL`;
      if (result.count === 1) console.log(`annotated ${proposal.id}`);
      else console.log(`skipped ${proposal.id}: status or annotation changed`);
    } catch (error) {
      console.error(`warn: curator skipped ${proposal.id}: ${(error as Error).message}`);
    }
  }
} catch (error) {
  console.error(`warn: curator pre-pass unavailable: ${(error as Error).message}`);
} finally {
  await sql.end();
}
