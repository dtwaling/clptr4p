-- Revert 008: column-level SELECT (id) also permits SELECT count(*), leaking
-- evidence cardinality to the reviewer. Plain INSERT needs no conflict clause:
-- the proposal status re-check under lock makes a duplicate decision event
-- impossible, so ON CONFLICT was unnecessary.
REVOKE SELECT (id) ON source_events FROM clptr4p_reviewer;
