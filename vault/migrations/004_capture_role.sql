-- Least-privilege grants for the capture role.
-- Can insert raw evidence and derived claims, but cannot read or modify the exchange zone.

GRANT USAGE ON SCHEMA public TO clptr4p_capture;
GRANT SELECT, INSERT ON source_events, claims, claim_sources TO clptr4p_capture;
GRANT UPDATE (superseded_by, embedding) ON claims TO clptr4p_capture;

-- Explicitly deny access to the exchange zone and policy config
REVOKE ALL ON policies, identity_bindings, decisions, bundles, receipts, proposals FROM clptr4p_capture;
