import { Server } from "npm:@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "npm:@modelcontextprotocol/sdk/types.js";
import {
  assertNoSecretFields,
  decideContextRequest,
  issueScopedBundle,
  validateContextRequest,
  validateMemoryUpdateProposal,
  writeReceipt,
} from "../context-layer-reference/context-layer-reference.mjs";
import { BundleStore } from "./bundle_store.ts";
import { ClaimStore } from "./claim_store.ts";
import { AuditLog } from "./audit.ts";

const GATEWAY_ID = "did:local:clptr4p-gateway";
const VAULT_DATA = new URL("../vault/data/", import.meta.url).pathname;

// Deny-by-default policy input (shape validated by the reference validatePolicy).
const DENY_ALL_POLICY = {
  id: "urn:cl:policy:default-deny",
  version: "default-deny/1",
  issuer: "urn:cl:policy-engine:local",
  allowed_purpose_codes: [],
  allowed_selectors: [],
  denied_selectors: [],
  allowed_actions: [],
  max_retention_seconds: 3600,
  allow_onward_disclosure: false,
  transform_requirements: [],
};

// Optional policy override. Absent or unreadable -> fail closed to deny-all.
function loadPolicy(): typeof DENY_ALL_POLICY {
  const path = Deno.env.get("CLPTR4P_POLICY_FILE");
  if (!path) return DENY_ALL_POLICY;
  try {
    return JSON.parse(Deno.readTextFileSync(path));
  } catch (e) {
    console.error(`policy load failed (${path}), falling back to deny-all:`, (e as Error).message);
    return DENY_ALL_POLICY;
  }
}
const ACTIVE_POLICY = loadPolicy();

// Optional vault claims. Absent -> empty store; allow decisions will then fail
// bundle issuance with MISSING_GRANTED_CLAIM, which is the correct outcome.
function loadClaims(): ClaimStore {
  const path = Deno.env.get("CLPTR4P_CLAIMS_FILE");
  if (!path) return ClaimStore.empty();
  try {
    return ClaimStore.fromFile(path);
  } catch (e) {
    console.error(`claims load failed (${path}), using empty store:`, (e as Error).message);
    return ClaimStore.empty();
  }
}
const CLAIMS = loadClaims();

const bundles = new BundleStore();
const decisions = new AuditLog(`${VAULT_DATA}decisions.jsonl`);
const receipts = new AuditLog(`${VAULT_DATA}receipts.jsonl`);
const proposals = new AuditLog(`${VAULT_DATA}proposals.jsonl`);

// deno-lint-ignore no-explicit-any
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (payload: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

// deno-lint-ignore no-explicit-any
function handleContextRequest(ctxReq: any): ToolResult {
  const validation = validateContextRequest(ctxReq);
  if (!validation.valid) {
    return fail(`Invalid request: ${JSON.stringify(validation.errors)}`);
  }

  const decision = decideContextRequest(ctxReq, ACTIVE_POLICY);
  decisions.append("policy_decision", decision);

  if (decision.decision === "deny" || decision.decision === "needs_approval") {
    return ok({ decision });
  }
  if (decision.decision !== "allow" && decision.decision !== "allow_with_reductions") {
    return fail(`Unhandled decision state: ${decision.decision}`);
  }

  const requested = (ctxReq.selectors ?? []).map((s: { predicate: string }) => s.predicate);
  const claims = CLAIMS.select(ctxReq.subject_ref, requested);
  const bundle = issueScopedBundle({ request: ctxReq, decision, claims, issuer: GATEWAY_ID });
  const now = new Date().toISOString();
  const receipt = writeReceipt({
    operation: "bundle.issue",
    request: ctxReq,
    decision,
    bundle,
    actor: GATEWAY_ID,
    issuer: GATEWAY_ID,
    outcome: "success",
    started_at: now,
    completed_at: now,
    user_summary: "Issued scoped bundle.",
  });
  receipts.append("receipt", receipt);
  bundles.issue(ctxReq, decision, bundle);
  return ok({ bundle, receipt });
}

// deno-lint-ignore no-explicit-any
function handleContextAct(bundleId: string, action: string, payload: any): ToolResult {
  const startedAt = new Date();
  const result = bundles.consume(bundleId, action, startedAt);
  if (!result.ok) {
    decisions.append("act_rejected", { bundle_id: bundleId, action, code: result.code, detail: result.detail });
    return fail(`${result.code}: ${result.detail}`);
  }

  const { request, decision, bundle } = result.entry;
  // Executor stub: the lite profile has no bound side-effect adapters yet.
  // Record intent + payload digest via the receipt and return the bundle
  // context so the caller can act on approved facts only.
  const receipt = writeReceipt({
    operation: action,
    request,
    decision,
    bundle,
    actor: bundle.recipient,
    issuer: GATEWAY_ID,
    outcome: "success",
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    user_summary: `Consumed bundle for ${action}.`,
  });
  receipts.append("receipt", receipt);
  return ok({ action, context: bundle.context, restrictions: bundle.restrictions, payload_received: payload !== undefined, receipt });
}

// deno-lint-ignore no-explicit-any
function handleMemoryPropose(proposal: any): ToolResult {
  const validation = validateMemoryUpdateProposal(proposal);
  if (!validation.valid) {
    return fail(`Invalid proposal: ${JSON.stringify(validation.errors)}`);
  }
  proposals.append("memory_update_proposal", proposal);
  return ok({ status: "pending_validation", proposal_id: proposal.id });
}

const server = new Server(
  { name: "clptr4p-gateway", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "context_request",
      description: "Request context for a specific purpose. Returns a PolicyDecision and, if allowed, a Scoped Context Bundle.",
      inputSchema: {
        type: "object",
        properties: { request: { type: "object", description: "context_request object (context-layer/0.2-draft)" } },
        required: ["request"],
      },
    },
    {
      name: "context_act",
      description: "Consume a Scoped Context Bundle to perform one granted action. Single-use; fails closed on expiry or ungranted action.",
      inputSchema: {
        type: "object",
        properties: {
          bundle_id: { type: "string" },
          action: { type: "string", description: "Must appear in bundle.capabilities" },
          payload: { type: "object" },
        },
        required: ["bundle_id", "action"],
      },
    },
    {
      name: "memory_propose",
      description: "Submit a memory_update_proposal. Never commits directly; queued for review.",
      inputSchema: {
        type: "object",
        properties: { proposal: { type: "object", description: "memory_update_proposal object (context-layer/0.2-draft)" } },
        required: ["proposal"],
      },
    },
  ],
}));

// deno-lint-ignore no-explicit-any
server.setRequestHandler(CallToolRequestSchema, (request: any) => {
  try {
    const args = request.params.arguments ?? {};
    assertNoSecretFields(args, "tool arguments");
    switch (request.params.name) {
      case "context_request":
        return handleContextRequest(args.request);
      case "context_act":
        return handleContextAct(args.bundle_id, args.action, args.payload);
      case "memory_propose":
        return handleMemoryPropose(args.proposal);
      default:
        return fail(`Unknown tool: ${request.params.name}`);
    }
  } catch (e) {
    return fail(`Error: ${(e as Error).message}`);
  }
});

await server.connect(new StdioServerTransport());
console.error(`clptr4p Policy Gateway v0.2.0 running on stdio (policy: ${ACTIVE_POLICY.id}, subjects: ${CLAIMS.subjectCount})`);
