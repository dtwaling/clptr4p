-- INSERT ... ON CONFLICT (id) requires SELECT on the conflict target column.
-- Column-level grant exposes only the opaque event id, not payloads.
GRANT SELECT (id) ON source_events TO clptr4p_reviewer;
