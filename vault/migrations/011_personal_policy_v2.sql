-- personal/2: widen selectors with the Honcho-migration predicates.
-- New grants: tech.stack, notes.tool, skill.rule, skill.cadence, project.active,
-- repo.remote. Everything else unchanged (retrieve.context, no actions, 3600s,
-- onward forbidden).

BEGIN;
UPDATE policies SET active = false;

INSERT INTO policies (id, version, issuer, policy_json, active) VALUES (
  'urn:cl:policy:personal-2',
  'personal/2',
  'urn:cl:policy-engine:local',
  '{
    "id": "urn:cl:policy:personal-2",
    "version": "personal/2",
    "issuer": "urn:cl:policy-engine:local",
    "allowed_purpose_codes": ["retrieve.context"],
    "allowed_selectors": [
      "preferred_name", "comm.style", "formatting.rule",
      "tech.stack", "notes.tool", "skill.rule", "skill.cadence",
      "project.active", "repo.remote"
    ],
    "denied_selectors": [],
    "allowed_actions": [],
    "max_retention_seconds": 3600,
    "allow_onward_disclosure": false,
    "transform_requirements": []
  }'::jsonb,
  true
);
COMMIT;
