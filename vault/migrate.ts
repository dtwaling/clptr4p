// Idempotent migration runner. Runs as the admin role; creates the gateway
// role if missing, then applies migrations/*.sql in order, tracking each in
// schema_migrations. Requires DATABASE_URL and GATEWAY_PASSWORD in env.

import postgres from "npm:postgres@3.4.5";

const dbUrl = Deno.env.get("DATABASE_URL");
const gatewayPassword = Deno.env.get("GATEWAY_PASSWORD");
const capturePassword = Deno.env.get("CAPTURE_PASSWORD");
const reviewerPassword = Deno.env.get("REVIEWER_PASSWORD");
const curatorPassword = Deno.env.get("CURATOR_PASSWORD");
if (!dbUrl || !gatewayPassword || !capturePassword || !reviewerPassword || !curatorPassword) {
  console.error("DATABASE_URL, GATEWAY_PASSWORD, CAPTURE_PASSWORD, REVIEWER_PASSWORD, and CURATOR_PASSWORD are required");
  Deno.exit(1);
}

const sql = postgres(dbUrl, { onnotice: () => {} });
const migrationsDir = new URL("./migrations/", import.meta.url);

try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const [gatewayRole] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'clptr4p_gateway'`;
  if (!gatewayRole) {
    const escaped = gatewayPassword.replaceAll("'", "''");
    await sql.unsafe(`CREATE ROLE clptr4p_gateway WITH LOGIN PASSWORD '${escaped}'`);
    console.log("created role clptr4p_gateway");
  }

  const [captureRole] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'clptr4p_capture'`;
  if (!captureRole) {
    const escaped = capturePassword.replaceAll("'", "''");
    await sql.unsafe(`CREATE ROLE clptr4p_capture WITH LOGIN PASSWORD '${escaped}'`);
    console.log("created role clptr4p_capture");
  }

  const [reviewerRole] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'clptr4p_reviewer'`;
  if (!reviewerRole) {
    const escaped = reviewerPassword.replaceAll("'", "''");
    await sql.unsafe(`CREATE ROLE clptr4p_reviewer WITH LOGIN PASSWORD '${escaped}'`);
    console.log("created role clptr4p_reviewer");
  }

  const [curatorRole] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'clptr4p_curator'`;
  if (!curatorRole) {
    const escaped = curatorPassword.replaceAll("'", "''");
    await sql.unsafe(`CREATE ROLE clptr4p_curator WITH LOGIN PASSWORD '${escaped}'`);
    console.log("created role clptr4p_curator");
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
