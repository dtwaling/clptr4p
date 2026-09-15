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
  bundle: bundle,
  actor: 'did:local:gateway',
  issuer: 'did:local:gateway',
  outcome: 'success',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  user_summary: 'Issued scoped bundle.'
});

console.log("Shapes dumped successfully.");
