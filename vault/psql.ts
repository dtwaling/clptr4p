// Admin-side helper: execute SQL from stdin as the vault admin role.
// Test/ops tooling only; the gateway never uses admin credentials.
import postgres from "npm:postgres@3.4.5";

const url = Deno.env.get("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL required");
  Deno.exit(1);
}
const body = await new Response(Deno.stdin.readable).text();
if (!body.trim()) {
  console.error("no SQL on stdin");
  Deno.exit(1);
}
// max: 1 so raw BEGIN/COMMIT in piped SQL runs on a single connection.
const sql = postgres(url, { onnotice: () => {}, max: 1 });
try {
  const result = await sql.unsafe(body);
  console.log(JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v));
} finally {
  await sql.end();
}
