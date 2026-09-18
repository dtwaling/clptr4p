-- First real policy: personal/1. Agents may retrieve reviewed personal context
-- (name, communication style, formatting rules) to draft responses for Dustin.
-- Read-only: no actions. Retention capped at 1h; no onward disclosure.
-- default-deny stays in the table as the fail-closed fallback (inactive).

UPDATE policies SET active = false;

INSERT INTO policies (id, version, issuer, policy_json, active) VALUES (
  'urn:cl:policy:personal-1',
  'personal/1',
  'urn:cl:policy-engine:local',
  '{
    "id": "urn:cl:policy:personal-1",
    "version": "personal/1",
    "issuer": "urn:cl:policy-engine:local",
    "allowed_purpose_codes": ["retrieve.context"],
    "allowed_selectors": ["preferred_name", "comm.style", "formatting.rule"],
    "denied_selectors": [],
    "allowed_actions": [],
    "max_retention_seconds": 3600,
    "allow_onward_disclosure": false,
    "transform_requirements": []
  }'::jsonb,
  true
);
