-- Seed the deny-all policy as the active default. Fail closed from day one.
INSERT INTO policies (id, version, issuer, policy_json, active) VALUES (
  'urn:cl:policy:default-deny',
  'default-deny/1',
  'urn:cl:policy-engine:local',
  '{
    "id": "urn:cl:policy:default-deny",
    "version": "default-deny/1",
    "issuer": "urn:cl:policy-engine:local",
    "allowed_purpose_codes": [],
    "allowed_selectors": [],
    "denied_selectors": [],
    "allowed_actions": [],
    "max_retention_seconds": 3600,
    "allow_onward_disclosure": false,
    "transform_requirements": []
  }'::jsonb,
  true
);
