-- Least-privilege grants for the gateway role. The role itself is created by
-- migrate.ts (needs the password from env); this file only shapes its access.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO clptr4p_gateway;

-- Vault zone: read-only surface. source_events intentionally absent.
GRANT SELECT ON claims, claim_sources, policies, identity_bindings TO clptr4p_gateway;

-- Exchange zone: append + narrow update.
GRANT SELECT, INSERT ON decisions, bundles, receipts, proposals TO clptr4p_gateway;
GRANT UPDATE (consumed_at) ON bundles TO clptr4p_gateway;

-- Belt and braces.
REVOKE ALL ON source_events FROM clptr4p_gateway;
