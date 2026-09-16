-- clptr4p vault schema (context-layer/0.2-draft trust zones)
-- Vault zone: source_events, claims, claim_sources, policies, identity_bindings
-- Exchange zone: decisions, bundles, receipts, proposals

CREATE EXTENSION IF NOT EXISTS vector;

-- Raw captured evidence. The gateway role has NO grants on this table.
CREATE TABLE source_events (
  id               TEXT PRIMARY KEY,
  subject_ref      TEXT NOT NULL,
  origin           TEXT NOT NULL,
  actor            TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  visibility       TEXT NOT NULL,
  payload_digest   TEXT NOT NULL,
  payload_encrypted BYTEA
);
CREATE INDEX source_events_subject_idx ON source_events (subject_ref, occurred_at DESC);

-- Derived claims. Only surface the gateway may read.
CREATE TABLE claims (
  id            TEXT PRIMARY KEY,
  subject_ref   TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  claim         TEXT NOT NULL,
  value         TEXT NOT NULL,
  datatype      TEXT NOT NULL DEFAULT 'string',
  confidence    REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  valid_from    TIMESTAMPTZ,
  valid_to      TIMESTAMPTZ,
  superseded_by TEXT REFERENCES claims(id),
  embedding     vector(1536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX claims_subject_predicate_idx ON claims (subject_ref, predicate) WHERE superseded_by IS NULL;
CREATE INDEX claims_embedding_idx ON claims USING hnsw (embedding vector_cosine_ops);

-- Provenance edges: claim -> supporting source events.
CREATE TABLE claim_sources (
  claim_id        TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL REFERENCES source_events(id) ON DELETE RESTRICT,
  PRIMARY KEY (claim_id, source_event_id)
);

-- Policy inputs (reference validatePolicy shape). Exactly one active.
CREATE TABLE policies (
  id          TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  issuer      TEXT NOT NULL,
  policy_json JSONB NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX policies_single_active_idx ON policies (active) WHERE active;

CREATE TABLE identity_bindings (
  principal   TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exchange zone --------------------------------------------------------

CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  request_ref   TEXT NOT NULL,
  decision      TEXT NOT NULL,
  reason_codes  TEXT[] NOT NULL,
  decision_json JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX decisions_request_idx ON decisions (request_ref);

CREATE TABLE bundles (
  id            TEXT PRIMARY KEY,
  request_ref   TEXT NOT NULL,
  decision_ref  TEXT NOT NULL REFERENCES decisions(id),
  recipient     TEXT NOT NULL,
  capabilities  TEXT[] NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  single_use    BOOLEAN NOT NULL,
  consumed_at   TIMESTAMPTZ,
  request_json  JSONB NOT NULL,
  decision_json JSONB NOT NULL,
  bundle_json   JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bundles_expires_idx ON bundles (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE receipts (
  id            TEXT PRIMARY KEY,
  operation     TEXT NOT NULL,
  actor         TEXT NOT NULL,
  request_ref   TEXT NOT NULL,
  decision_ref  TEXT NOT NULL,
  bundle_ref    TEXT,
  outcome       TEXT NOT NULL,
  input_digest  TEXT,
  output_digest TEXT,
  receipt_json  JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipts_bundle_idx ON receipts (bundle_ref);

-- Spec invariant: receipts are logically append-only.
CREATE OR REPLACE FUNCTION receipts_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'receipts are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER receipts_no_update_delete
  BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_append_only();

CREATE TABLE proposals (
  id            TEXT PRIMARY KEY,
  subject_ref   TEXT NOT NULL,
  status        TEXT NOT NULL,
  proposal_json JSONB NOT NULL,
  reviewed_at   TIMESTAMPTZ,
  reviewer      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX proposals_status_idx ON proposals (status) WHERE reviewed_at IS NULL;
