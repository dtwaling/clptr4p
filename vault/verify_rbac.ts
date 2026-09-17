// Verifies the privilege boundaries for both gateway and capture roles.
// Run with GATEWAY_DATABASE_URL and CAPTURE_DATABASE_URL in env.

import postgres from "npm:postgres@3.4.5";

const gatewayUrl = Deno.env.get("GATEWAY_DATABASE_URL");
const captureUrl = Deno.env.get("CAPTURE_DATABASE_URL");
if (!gatewayUrl || !captureUrl) {
  console.error("GATEWAY_DATABASE_URL and CAPTURE_DATABASE_URL required");
  Deno.exit(1);
}

let failures = 0;

const expectDenied = async (label: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    console.log(`FAIL  ${label}: succeeded but should be denied`);
    failures++;
  } catch (e) {
    const msg = (e as Error).message;
    if (/permission denied|append-only/i.test(msg)) {
      console.log(`ok    ${label}: denied`);
    } else {
      console.log(`FAIL  ${label}: unexpected error ${msg}`);
      failures++;
    }
  }
};

const expectAllowed = async (label: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    console.log(`ok    ${label}`);
  } catch (e) {
    console.log(`FAIL  ${label}: ${(e as Error).message}`);
    failures++;
  }
};

async function testGatewayRole() {
  console.log("--- Testing Gateway Role ---");
  const sql = postgres(gatewayUrl!, { onnotice: () => {} });
  try {
    await expectAllowed("gateway: select active policy", async () => {
      const [p] = await sql`SELECT id FROM policies WHERE active`;
      if (p.id !== "urn:cl:policy:default-deny") throw new Error(`active policy is ${p.id}`);
    });
    await expectAllowed("gateway: select claims", () => sql`SELECT count(*) FROM claims`);
    await expectDenied("gateway: select source_events", () => sql`SELECT count(*) FROM source_events`);
    await expectDenied("gateway: insert claims", () =>
      sql`INSERT INTO claims (id, subject_ref, predicate, claim, value, confidence)
          VALUES ('x', 's', 'p', 'c', '{}'::jsonb, 0.5)`);
    await expectDenied("gateway: insert policies", () =>
      sql`INSERT INTO policies (id, version, issuer, policy_json) VALUES ('x', 'v', 'i', '{}')`);
    await expectDenied("gateway: update policies", () => sql`UPDATE policies SET active = false`);
    await expectDenied("gateway: delete decisions", () => sql`DELETE FROM decisions`);
    await expectDenied("gateway: update bundles.expires_at", () =>
      sql`UPDATE bundles SET expires_at = now() WHERE false`);
    await expectAllowed("gateway: update bundles.consumed_at", () =>
      sql`UPDATE bundles SET consumed_at = now() WHERE false`);
    await expectDenied("gateway: delete receipts", () => sql`DELETE FROM receipts`);
    await expectDenied("gateway: update receipts", () => sql`UPDATE receipts SET outcome = 'x' WHERE false`);
  } finally {
    await sql.end();
  }
}

async function testCaptureRole() {
  console.log("--- Testing Capture Role ---");
  const sql = postgres(captureUrl!, { onnotice: () => {} });
  try {
    await expectAllowed("capture: select source_events", () => sql`SELECT count(*) FROM source_events`);
    await expectAllowed("capture: select claims", () => sql`SELECT count(*) FROM claims`);
    await expectAllowed("capture: insert source_events", () => 
      sql`INSERT INTO source_events (id, subject_ref, origin, actor, occurred_at, visibility, payload_digest)
          VALUES ('test_event', 's', 'o', 'a', now(), 'v', 'd') ON CONFLICT DO NOTHING`);
    await expectAllowed("capture: insert claims", () =>
      sql`INSERT INTO claims (id, subject_ref, predicate, claim, value, confidence)
          VALUES ('test_claim', 's', 'p', 'c', '{}'::jsonb, 0.5) ON CONFLICT DO NOTHING`);
    await expectAllowed("capture: update claims.superseded_by", () =>
      sql`UPDATE claims SET superseded_by = 'test_claim' WHERE id = 'test_claim'`);
    
    await expectDenied("capture: select policies", () => sql`SELECT count(*) FROM policies`);
    await expectDenied("capture: select decisions", () => sql`SELECT count(*) FROM decisions`);
    await expectDenied("capture: select bundles", () => sql`SELECT count(*) FROM bundles`);
    await expectDenied("capture: select receipts", () => sql`SELECT count(*) FROM receipts`);
    await expectDenied("capture: insert decisions", () => 
      sql`INSERT INTO decisions (id, request_ref, decision, reason_codes, decision_json) VALUES ('x','r','d','{}','{}')`);
  } finally {
    // Cleanup test data
    const adminUrl = Deno.env.get("DATABASE_URL");
    if (adminUrl) {
      const adminSql = postgres(adminUrl, { onnotice: () => {} });
      await adminSql`DELETE FROM claims WHERE id = 'test_claim'`;
      await adminSql`DELETE FROM source_events WHERE id = 'test_event'`;
      await adminSql.end();
    }
    await sql.end();
  }
}

await testGatewayRole();
await testCaptureRole();

if (failures > 0) {
  console.error(`${failures} boundary violation(s)`);
  Deno.exit(1);
}
console.log("RBAC BOUNDARY OK");
