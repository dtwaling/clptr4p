import { decideContextRequest, issueScopedBundle, writeReceipt } from '../../context-layer-reference/context-layer-reference.mjs';
import { readFileSync } from 'node:fs';

const exchange = JSON.parse(readFileSync(new URL('../../context-layer-reference/valid-exchange.json', import.meta.url), 'utf8'));
const decision = decideContextRequest(exchange.request, exchange.policy);
const bundle = issueScopedBundle({
  request: exchange.request,
  decision: decision,
  claims: exchange.claims,
  issuer: 'did:local:gateway'
});
const receipt = writeReceipt({
  operation: 'bundle.issue',
  request: exchange.request,
  decision: decision,
  bundle: bundle
});

console.log("--- BUNDLE ---");
console.log(JSON.stringify(bundle, null, 2));
console.log("--- RECEIPT ---");
console.log(JSON.stringify(receipt, null, 2));
