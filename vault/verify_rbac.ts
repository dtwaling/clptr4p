// Verifies the gateway role's privilege boundary against the live vault.
// Run with GATEWAY_DATABASE_URL in env. Exit non-zero on any violation.

import postgres from "npm:postgres@3.4.5";

const url = Deno.env.get("GATEWAY_DATABASE_URL");
if (!url) {
  console.error("GATEWAY_DATABASE_URL required");
  Deno.exit(1);
}
const sql = postgres(url, { onnotice: () => {} });

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

try {
  await expectAllowed("select active policy", async () => {
    const [p] = await sql`SELECT id FROM policies WHERE active`;
    if (p.id !== "urn:cl:policy:default-deny") throw new Error(`active policy is ${p.id}`);
  });
  await expectAllowed("select claims", () => sql`SELECT count(*) FROM claims`);
  await expectDenied("select source_events", () => sql`SELECT count(*) FROM source_events`);
  await expectDenied("insert claims", () =>
    sql`INSERT INTO claims (id, subject_ref, predicate, claim, value, confidence)
        VALUES ('x', 's', 'p', 'c', 'v', 0.5)`);
  await expectDenied("insert policies", () =>
    sql`INSERT INTO policies (id, version, issuer, policy_json) VALUES ('x', 'v', 'i', '{}')`);
  await expectDenied("update policies", () => sql`UPDATE policies SET active = false`);
  await expectDenied("delete decisions", () => sql`DELETE FROM decisions`);
  await expectDenied("update bundles.expires_at", () =>
    sql`UPDATE bundles SET expires_at = now() WHERE false`);
  await expectAllowed("update bundles.consumed_at", () =>
    sql`UPDATE bundles SET consumed_at = now() WHERE false`);
  await expectDenied("delete receipts", () => sql`DELETE FROM receipts`);
  await expectDenied("update receipts", () => sql`UPDATE receipts SET outcome = 'x' WHERE false`);
} finally {
  await sql.end();
}

if (failures > 0) {
  console.error(`${failures} boundary violation(s)`);
  Deno.exit(1);
}
console.log("RBAC BOUNDARY OK");
