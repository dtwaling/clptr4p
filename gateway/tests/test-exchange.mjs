import { decideContextRequest, issueScopedBundle, writeReceipt } from '../../context-layer-reference/context-layer-reference.mjs';
import { readFileSync } from 'node:fs';

const exchange = JSON.parse(readFileSync(new URL('../../context-layer-reference/valid-exchange.json', import.meta.url), 'utf8'));

console.log("-- 1. EVALUATING POLICY --");
const decision = decideContextRequest(exchange.request, exchange.policy);
console.log("Decision:", decision.decision);

console.log("\n-- 2. ISSUING BUNDLE --");
const bundle = issueScopedBundle({
  request: exchange.request,
  decision: decision,
  claims: exchange.claims,
  issuer: 'did:local:gateway'
});
console.log("Bundle ID:", bundle.id);
console.log("Allowed Actions:", bundle.capabilities.allowed_actions);

console.log("\n-- 3. WRITING RECEIPT --");
const receipt = writeReceipt({
  operation: 'bundle.issue',
  request: exchange.request,
  decision: decision,
  bundle: bundle
});
console.log("Receipt ID:", receipt.id);
console.log("Receipt Status:", receipt.outcome.status);
