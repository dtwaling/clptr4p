import { Server } from "npm:@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "npm:@modelcontextprotocol/sdk/types.js";
import {
  decideContextRequest,
  issueScopedBundle,
  writeReceipt,
  validateContextRequest,
  validateMemoryUpdateProposal,
  assertNoSecretFields
} from "../context-layer-reference/context-layer-reference.mjs";

const server = new Server(
  { name: "clptr4p-gateway", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Hardcoded deny-by-default policy for scaffold
const DEFAULT_POLICY = {
  spec_version: "context-layer/0.2-draft",
  type: "PolicyDecision",
  id: "urn:cl:policy:default-deny",
  created_at: new Date().toISOString(),
  issuer: { id: "did:local:clptr4p-gateway" },
  request_ref: "urn:cl:req:none",
  decision: "deny",
  reason_codes: ["default_deny_active"],
  granted_selectors: [],
  granted_actions: [],
  denied_selectors: ["*"],
  denied_actions: ["*"],
  policy_snapshot: "deny-all",
  transform_requirements: [],
  retention: "none",
  onward_disclosure: "deny",
  receipt_requirement: "always",
  expires_at: new Date(Date.now() + 3600000).toISOString()
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "context_request",
        description: "Request context for a specific purpose. Returns a Scoped Context Bundle.",
        inputSchema: {
          type: "object",
          properties: {
            request: { type: "object", description: "The ContextRequest object" }
          },
          required: ["request"]
        }
      },
      {
        name: "context_act",
        description: "Execute an action using a valid Scoped Context Bundle.",
        inputSchema: {
          type: "object",
          properties: {
            bundle_id: { type: "string" },
            action: { type: "string" },
            payload: { type: "object" }
          },
          required: ["bundle_id", "action"]
        }
      },
      {
        name: "memory_propose",
        description: "Propose a memory update. Returns a receipt.",
        inputSchema: {
          type: "object",
          properties: {
            proposal: { type: "object" }
          },
          required: ["proposal"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    assertNoSecretFields(request.params.arguments);

    if (request.params.name === "context_request") {
      const ctxReq = request.params.arguments.request;
      validateContextRequest(ctxReq);
      const decision = decideContextRequest(ctxReq, DEFAULT_POLICY);
      
      if (decision.decision === "deny") {
         const receipt = writeReceipt({
           operation: "context.request",
           request: ctxReq,
           decision: decision
         });
         return { content: [{ type: "text", text: JSON.stringify({ decision, receipt }, null, 2) }] };
      }
      
      const bundle = issueScopedBundle({
        request: ctxReq,
        decision: decision,
        claims: [],
        issuer: "did:local:clptr4p-gateway"
      });
      const receipt = writeReceipt({
        operation: "bundle.issue",
        request: ctxReq,
        decision: decision,
        bundle: bundle
      });
      return { content: [{ type: "text", text: JSON.stringify({ bundle, receipt }, null, 2) }] };
    }

    if (request.params.name === "memory_propose") {
      const proposal = request.params.arguments.proposal;
      validateMemoryUpdateProposal(proposal);
      const receipt = writeReceipt({
        operation: "memory.propose",
        request: { id: "urn:cl:req:none" },
        decision: DEFAULT_POLICY,
        outcome: { status: "proposed" }
      });
      return { content: [{ type: "text", text: JSON.stringify({ status: "proposed", receipt }, null, 2) }] };
    }

    if (request.params.name === "context_act") {
      return { content: [{ type: "text", text: "Not implemented yet. Requires bundle validation." }] };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("clptr4p Policy Gateway running on stdio");
