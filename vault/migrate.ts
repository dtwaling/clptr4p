// Idempotent migration runner. Runs as the admin role; creates the gateway
// role if missing, then applies migrations/*.sql in order, tracking each in
// schema_migrations. Requires DATABASE_URL and GATEWAY_PASSWORD in env.

import postgres from "npm:postgres@3.4.5";

const dbUrl = Deno.env.get("DATABASE_URL");
const gatewayPassword = Deno.env.get("GATEWAY_PASSWORD");
if (!dbUrl || !gatewayPassword) {
  console.error("DATABASE_URL and GATEWAY_PASSWORD are required");
  Deno.exit(1);
}

const sql = postgres(dbUrl, { onnotice: () => {} });
const migrationsDir = new URL("./migrations/", import.meta.url);

try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'clptr4p_gateway'`;
  if (!role) {
    // Password cannot be parameterized in DDL; escape single quotes defensively.
    const escaped = gatewayPassword.replaceAll("'", "''");
    await sql.unsafe(`CREATE ROLE clptr4p_gateway WITH LOGIN PASSWORD '${escaped}'`);
    console.log("created role clptr4p_gateway");
  }

  const files = [...Deno.readDirSync(migrationsDir)]
    .filter((e) => e.isFile && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();

  for (const file of files) {
    const [done] = await sql`SELECT 1 FROM schema_migrations WHERE version = ${file}`;
    if (done) {
      console.log(`skip  ${file}`);
      continue;
    }
    const body = Deno.readTextFileSync(new URL(file, migrationsDir));
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
    console.log(`apply ${file}`);
  }
  console.log("migrations complete");
} finally {
  await sql.end();
}
