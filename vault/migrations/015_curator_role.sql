-- Least-privilege advisory curator role. It may read the pending queue and the
-- active claims needed for deterministic replacement accounting, and may write
-- only proposal_json annotations. It cannot mint or promote claims.

GRANT USAGE ON SCHEMA public TO clptr4p_curator;
GRANT SELECT ON proposals, claims TO clptr4p_curator;
GRANT UPDATE (proposal_json) ON proposals TO clptr4p_curator;

REVOKE ALL ON source_events, claim_sources, policies, identity_bindings,
  decisions, bundles, receipts FROM clptr4p_curator;
REVOKE INSERT, UPDATE, DELETE ON claims FROM clptr4p_curator;
REVOKE INSERT, DELETE ON proposals FROM clptr4p_curator;
REVOKE UPDATE (id, subject_ref, status, reviewed_at, reviewer, created_at,
  proposed_tier) ON proposals FROM clptr4p_curator;
