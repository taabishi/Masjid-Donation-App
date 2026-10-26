-- Money columns are bigint cents. Ids are app-generated UUID strings.

CREATE TABLE mosques (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  city               text NOT NULL,
  state              text NOT NULL,
  address            text NOT NULL DEFAULT '',
  description        text NOT NULL DEFAULT '',
  payouts_connected  boolean NOT NULL DEFAULT false,
  payout_account_id  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  email                text NOT NULL UNIQUE,
  password_hash        text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('donor', 'admin')),
  mosque_id            text REFERENCES mosques(id),
  payment_customer_id  text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE causes (
  id          text PRIMARY KEY,
  mosque_id   text NOT NULL REFERENCES mosques(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  seq         bigserial
);
CREATE INDEX causes_mosque_idx ON causes (mosque_id, seq);

CREATE TABLE favorites (
  user_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mosque_id text NOT NULL REFERENCES mosques(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, mosque_id)
);

CREATE TABLE recurring (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id),
  mosque_id         text NOT NULL REFERENCES mosques(id),
  cause_id          text,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  frequency         text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  payment_method_id text,
  next_date         timestamptz NOT NULL,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_due_idx ON recurring (next_date) WHERE active;
CREATE INDEX recurring_user_idx ON recurring (user_id);

CREATE TABLE donations (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id),
  mosque_id    text NOT NULL REFERENCES mosques(id),
  cause_id     text, -- no FK: a mosque may delete a cause, history keeps the id
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status       text NOT NULL CHECK (status IN ('succeeded', 'processing', 'failed')),
  recurring_id text REFERENCES recurring(id),
  payment_ref  text UNIQUE, -- provider payment id; uniqueness makes retried charges idempotent
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX donations_mosque_idx ON donations (mosque_id, created_at DESC);
CREATE INDEX donations_user_idx ON donations (user_id, created_at DESC);

CREATE TABLE payouts (
  id           text PRIMARY KEY,
  mosque_id    text NOT NULL REFERENCES mosques(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method       text NOT NULL CHECK (method IN ('stripe_transfer', 'ach_manual')),
  status       text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  reference    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Append-only money ledger. `key` makes every posting idempotent.
CREATE TABLE ledger_entries (
  id           text PRIMARY KEY,
  key          text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  account      text NOT NULL, -- a mosque id, or 'platform'
  type         text NOT NULL CHECK (type IN
                 ('donation', 'processing_fee', 'platform_fee', 'refund', 'dispute', 'dispute_reversal', 'payout', 'payout_reversal')),
  amount_cents bigint NOT NULL,
  donation_id  text REFERENCES donations(id),
  payout_id    text REFERENCES payouts(id)
);
CREATE INDEX ledger_account_idx ON ledger_entries (account);
CREATE INDEX ledger_donation_idx ON ledger_entries (donation_id);

CREATE FUNCTION ledger_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: post a correcting entry instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_is_append_only();

-- Supabase exposes every table in `public` through its auto-generated REST API using the public
-- "anon" key. Row Level Security with NO policies denies all of that access. Only this API server
-- (which connects as the table owner, bypassing RLS) can read or write.
ALTER TABLE mosques        ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE causes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorites      ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring      ENABLE ROW LEVEL SECURITY;
ALTER TABLE donations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
