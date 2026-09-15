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
  assertNoSecretFields
} from "../context-layer-reference/context-layer-reference.mjs";

const server = new Server(
  { name: "clptr4p-gateway", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Hardcoded deny-by-default policy input (matches valid-exchange.json policy shape)
const DEFAULT_POLICY = {
  id: "urn:cl:policy:default-deny",
  version: "default-deny/1",
  issuer: "urn:cl:policy-engine:local",
  allowed_purpose_codes: [],
  allowed_selectors: [],
  denied_selectors: ["*"],
  allowed_actions: [],
  max_retention_seconds: 0,
  allow_onward_disclosure: false,
  transform_requirements: []
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

// @ts-ignore - bypassing strict any check on request parameter for standard MCP handler
server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  try {
    assertNoSecretFields(request.params.arguments);

    if (request.params.name === "context_request") {
      const ctxReq = request.params.arguments.request;
      
      const validation = validateContextRequest(ctxReq);
      if (!validation.valid) {
        return { content: [{ type: "text", text: `Invalid request: ${JSON.stringify(validation.errors)}` }], isError: true };
      }
      
      const decision = decideContextRequest(ctxReq, DEFAULT_POLICY);
      
      if (decision.decision === "deny") {
         const receipt = writeReceipt({
           operation: "context.request",
           request: ctxReq,
           decision: decision,
           actor: "did:local:gateway",
           issuer: "did:local:gateway",
           outcome: "denied",
           started_at: new Date().toISOString(),
           completed_at: new Date().toISOString(),
           user_summary: "Request denied by default policy."
         });
         return { content: [{ type: "text", text: JSON.stringify({ decision, receipt }, null, 2) }] };
      }
      
      // Only explicit allow states should proceed to bundle issuance
      if (decision.decision !== "allow" && decision.decision !== "allow_with_reductions") {
         return { content: [{ type: "text", text: `Unhandled decision state: ${decision.decision}` }], isError: true };
      }
      
      const bundle = issueScopedBundle({
        request: ctxReq,
        decision: decision,
        claims: [],
        issuer: "did:local:gateway"
      });
      
      const receipt = writeReceipt({
        operation: "bundle.issue",
        request: ctxReq,
        decision: decision,
        bundle: bundle,
        actor: "did:local:gateway",
        issuer: "did:local:gateway",
        outcome: "success",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        user_summary: "Issued scoped bundle."
      });
      
      return { content: [{ type: "text", text: JSON.stringify({ bundle, receipt }, null, 2) }] };
    }

    if (request.params.name === "memory_propose") {
      return { content: [{ type: "text", text: "Not implemented yet. Requires durable storage and authorization." }], isError: true };
    }

    if (request.params.name === "context_act") {
      return { content: [{ type: "text", text: "Not implemented yet. Requires bundle validation." }], isError: true };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (e) {
    const error = e as Error;
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("clptr4p Policy Gateway running on stdio");