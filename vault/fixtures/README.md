# fixtures

Generic sample envelopes used by tests and docs:

- `capture-sample.json` -- minimal single-claim capture
- `capture-supersede.json` -- demonstrates the `supersede` flag

Personal capture envelopes (real history, migrations, profile-memory imports)
are deliberately kept OUT of this repo. Keep yours in a private location
outside the tree. The repo's own git history retains the originals from the
original author's setup -- intentional provenance, not an accident; nothing
sensitive, but not interesting to strangers either.

Every capture envelope must document its source in `payload.summary` -- only
real, curated history enters the vault.
