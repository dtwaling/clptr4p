import { Server } from "npm:@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "npm:@modelcontextprotocol/sdk/types.js";
import process from "node:process";
import {
  assertNoSecretFields,
  decideContextRequest,
  issueScopedBundle,
  validateContextRequest,
  validateMemoryUpdateProposal,
  writeReceipt,
} from "../context-layer-reference/context-layer-reference.mjs";
import type { Backend, Json } from "./store/types.ts";
import { liteBackend } from "./store/lite.ts";
import { postgresBackend } from "./store/postgres.ts";

const GATEWAY_ID = "did:local:clptr4p-gateway";

// Backend selection: durable vault when GATEWAY_DATABASE_URL is set, else lite.
function selectBackend(): Backend {
  const pg = Deno.env.get("GATEWAY_DATABASE_URL");
  if (pg) return postgresBackend(pg);
  return liteBackend({
    policyFile: Deno.env.get("CLPTR4P_POLICY_FILE"),
    claimsFile: Deno.env.get("CLPTR4P_CLAIMS_FILE"),
    auditDir: new URL("../vault/data", import.meta.url).pathname,
  });
}
const store = selectBackend();

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (payload: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

async function handleContextRequest(ctxReq: Json): Promise<ToolResult> {
  const validation = validateContextRequest(ctxReq);
  if (!validation.valid) return fail(`Invalid request: ${JSON.stringify(validation.errors)}`);

  const policy = await store.policy.active();
  const decision = decideContextRequest(ctxReq, policy);
  await store.audit.decision(decision);

  if (decision.decision === "deny" || decision.decision === "needs_approval") return ok({ decision });
  if (decision.decision !== "allow" && decision.decision !== "allow_with_reductions") {
    return fail(`Unhandled decision state: ${decision.decision}`);
  }

  const requested = (ctxReq.selectors ?? []).map((s: { predicate: string }) => s.predicate);
  const claims = await store.claims.select(ctxReq.subject_ref, requested);
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
  // Bundle and its receipt become durable together or not at all (invariant 8).
  await store.bundles.issue(ctxReq, decision, bundle, receipt);
  return ok({ bundle, receipt });
}

async function handleContextAct(bundleId: string, action: string, payload: Json): Promise<ToolResult> {
  const startedAt = new Date();
  // Executor stub: lite profile has no bound side-effect adapters. The caller
  // receives approved context + restrictions and acts within them. The
  // consume receipt is written inside the same transaction as consumed_at.
  let receipt: Json;
  const result = await store.bundles.consume(bundleId, action, startedAt, ({ request, decision, bundle }) =>
    receipt = writeReceipt({
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
    }));
  if (!result.ok) {
    await store.audit.rejectedAct({ bundle_id: bundleId, action, code: result.code, detail: result.detail });
    return fail(`${result.code}: ${result.detail}`);
  }
  const { bundle } = result.entry;
  return ok({ action, context: bundle.context, restrictions: bundle.restrictions, payload_received: payload !== undefined, receipt });
}

async function handleMemoryPropose(proposal: Json): Promise<ToolResult> {
  const validation = validateMemoryUpdateProposal(proposal);
  if (!validation.valid) return fail(`Invalid proposal: ${JSON.stringify(validation.errors)}`);
  await store.audit.proposal(proposal);
  return ok({ status: "pending_validation", proposal_id: proposal.id });
}

const server = new Server({ name: "clptr4p-gateway", version: "0.3.0" }, { capabilities: { tools: {} } });

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

server.setRequestHandler(CallToolRequestSchema, async (request: Json) => {
  try {
    const args = request.params.arguments ?? {};
    assertNoSecretFields(args, "tool arguments");
    switch (request.params.name) {
      case "context_request":
        return await handleContextRequest(args.request);
      case "context_act":
        return await handleContextAct(args.bundle_id, args.action, args.payload);
      case "memory_propose":
        return await handleMemoryPropose(args.proposal);
      default:
        return fail(`Unknown tool: ${request.params.name}`);
    }
  } catch (e) {
    return fail(`Error: ${(e as Error).message}`);
  }
});

// Clean shutdown: stdio EOF or signal -> drain backend -> exit. Without this a
// live connection pool keeps the event loop alive after the client is gone.
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await store.close();
  } finally {
    Deno.exit(code);
  }
}
server.onclose = () => void shutdown(0);
// The SDK transport does not surface stdin EOF as onclose; watch it directly.
process.stdin.on("end", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));
Deno.addSignalListener("SIGINT", () => void shutdown(0));
Deno.addSignalListener("SIGTERM", () => void shutdown(0));

await server.connect(new StdioServerTransport());
console.error(`clptr4p Policy Gateway v0.3.0 on stdio; backend: ${store.describe()}`);
