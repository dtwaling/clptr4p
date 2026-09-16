import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { readFileSync } from "node:fs";
import { decideContextRequest } from "../../context-layer-reference/context-layer-reference.mjs";

const exchange = JSON.parse(readFileSync(new URL('../../context-layer-reference/valid-exchange.json', import.meta.url), 'utf8'));

Deno.test("Policy Gateway - Default Deny Policy Validation", () => {
  const DEFAULT_POLICY = {
    id: "urn:cl:policy:default-deny",
    version: "default-deny/1",
    issuer: "urn:cl:policy-engine:local",
    allowed_purpose_codes: [],
    allowed_selectors: [],
    denied_selectors: [],
    allowed_actions: [],
    max_retention_seconds: 3600, // Fixed: must be > 0
    allow_onward_disclosure: false,
    transform_requirements: []
  };

  const decision = decideContextRequest(exchange.request, DEFAULT_POLICY);
  
  assertEquals(decision.decision, "deny");
  assertStringIncludes(decision.reason_codes.join(","), "PURPOSE_DENIED");
});