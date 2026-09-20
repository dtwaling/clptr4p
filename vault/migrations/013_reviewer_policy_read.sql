-- 013: reviewer may read the policies table.
--
-- Auto-triage (vault/triage.ts) closes dead-on-arrival proposals whose
-- predicates the active policy does not grant; a human reviewer judging the
-- queue needs the same information. Read-only: the reviewer still cannot
-- write policies (kept enforced by verify_rbac.ts).

BEGIN;
GRANT SELECT ON policies TO clptr4p_reviewer;
COMMIT;
