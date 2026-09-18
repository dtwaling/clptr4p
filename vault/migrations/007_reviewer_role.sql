-- Least-privilege grants for the reviewer role (human-driven proposal review).
-- Reads proposals, commits approved claims with provenance, records the review
-- decision as a source event. Cannot read raw evidence, touch policies, or the
-- exchange zone.

GRANT USAGE ON SCHEMA public TO clptr4p_reviewer;

-- Proposal queue: read + narrow update (status, reviewed_at, reviewer).
GRANT SELECT ON proposals TO clptr4p_reviewer;
GRANT UPDATE (status, reviewed_at, reviewer) ON proposals TO clptr4p_reviewer;

-- Committing claims: same write surface as capture.
GRANT SELECT, INSERT ON claims, claim_sources TO clptr4p_reviewer;
GRANT UPDATE (superseded_by, valid_to, embedding) ON claims TO clptr4p_reviewer;

-- Review decision events: append-only; no SELECT on raw evidence.
GRANT INSERT ON source_events TO clptr4p_reviewer;

-- Explicitly deny the rest.
REVOKE ALL ON policies, identity_bindings, decisions, bundles, receipts FROM clptr4p_reviewer;
