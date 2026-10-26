-- Organization verification: only verified 501(c)(3) / tax-exempt organizations can receive donations or payouts.

ALTER TABLE mosques
  ADD COLUMN ein text CHECK (ein IS NULL OR ein ~ '^[0-9]{9}$'),
  ADD COLUMN legal_name text,
  ADD COLUMN verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending_review', 'verified', 'rejected')),
  ADD COLUMN verification_note text,
  ADD COLUMN verification_submitted_at timestamptz,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN ein_lookup jsonb;

-- One organization account per EIN while a claim is pending or approved (stops duplicates / impersonation).
CREATE UNIQUE INDEX mosques_ein_active ON mosques (ein) WHERE verification_status IN ('pending_review', 'verified');

CREATE TABLE verification_documents (
  id           text PRIMARY KEY,
  mosque_id    text NOT NULL REFERENCES mosques(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes   integer NOT NULL,
  data         bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_documents_mosque_idx ON verification_documents (mosque_id);

-- Who decided what, and when.
CREATE TABLE verification_events (
  id         text PRIMARY KEY,
  mosque_id  text NOT NULL REFERENCES mosques(id) ON DELETE CASCADE,
  action     text NOT NULL CHECK (action IN ('submitted', 'approved', 'rejected')),
  actor_id   text REFERENCES users(id),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_events_mosque_idx ON verification_events (mosque_id, created_at);

ALTER TABLE verification_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_events    ENABLE ROW LEVEL SECURITY;
