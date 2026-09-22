-- 014: injection tiering. Claims are archived unless a human reviewer
-- explicitly stamps them core during approve. Proposals begin archive-only.

BEGIN;

ALTER TABLE claims
  ADD COLUMN injection_tier TEXT NOT NULL DEFAULT 'archive'
  CHECK (injection_tier IN ('core', 'archive'));

ALTER TABLE proposals
  ADD COLUMN proposed_tier TEXT NOT NULL DEFAULT 'archive'
  CHECK (proposed_tier IN ('core', 'archive'));

CREATE INDEX claims_core_prefetch_idx
  ON claims (subject_ref, predicate, created_at)
  WHERE injection_tier = 'core' AND superseded_by IS NULL;

GRANT UPDATE (proposed_tier) ON proposals TO clptr4p_reviewer;
GRANT UPDATE (injection_tier) ON claims TO clptr4p_reviewer;

COMMIT;