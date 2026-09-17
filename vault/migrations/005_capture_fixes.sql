-- 1. Grant missing UPDATE permission for supersede logic
GRANT UPDATE (valid_to) ON claims TO clptr4p_capture;

-- 2. Upgrade claim values to JSONB to support rich protocol types
ALTER TABLE claims ALTER COLUMN value TYPE JSONB USING to_jsonb(value);
