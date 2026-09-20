-- personal/3: widen selectors with the Hermes-profile-migration predicates
-- (capture envelopes fixtures/profile-migration-shared.json and
-- fixtures/profile-migration-noether.json). New grants: hermes.setup,
-- tools.convention, project.audio2midi, skill.scanner, terminal.guard,
-- browser.testing, daemon.spawn, ghcli.regression, skill.authoring,
-- github.ops, gateway.setup, ob1l.legacy, desktop.quirks, profile.rule,
-- kanban.dispatcher, clptr4p.ops. Everything else unchanged
-- (retrieve.context, no actions, 3600s, onward forbidden).

BEGIN;
UPDATE policies SET active = false;

INSERT INTO policies (id, version, issuer, policy_json, active) VALUES (
  'urn:cl:policy:personal-3',
  'personal/3',
  'urn:cl:policy-engine:local',
  '{
    "id": "urn:cl:policy:personal-3",
    "version": "personal/3",
    "issuer": "urn:cl:policy-engine:local",
    "allowed_purpose_codes": ["retrieve.context"],
    "allowed_selectors": [
      "preferred_name", "comm.style", "formatting.rule",
      "tech.stack", "notes.tool", "skill.rule", "skill.cadence",
      "project.active", "repo.remote",
      "hermes.setup", "tools.convention", "project.audio2midi",
      "skill.scanner", "terminal.guard", "browser.testing",
      "daemon.spawn", "ghcli.regression", "skill.authoring",
      "github.ops", "gateway.setup", "ob1l.legacy", "desktop.quirks",
      "profile.rule", "kanban.dispatcher", "clptr4p.ops"
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
