BEGIN;
CREATE TABLE IF NOT EXISTS sat_rules (
  company text NOT NULL,
  branch integer NOT NULL,
  enabled boolean NOT NULL,
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 0 AND 10000),
  minimum_cents bigint NOT NULL CHECK (minimum_cents >= 0),
  maximum_cents bigint NOT NULL CHECK (maximum_cents > 0),
  delay_days integer NOT NULL CHECK (delay_days BETWEEN 0 AND 365),
  validity_days integer NOT NULL CHECK (validity_days BETWEEN 1 AND 3650),
  starts_on date NOT NULL,
  redemption_limit_cents bigint CHECK (redemption_limit_cents > 0),
  redemption_basis_points integer CHECK (redemption_basis_points BETWEEN 1 AND 10000),
  PRIMARY KEY (company, branch)
);
CREATE TABLE IF NOT EXISTS sat_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  branch integer NOT NULL,
  customer integer NOT NULL,
  sale_date date NOT NULL,
  sale_id integer NOT NULL,
  sale_cents bigint NOT NULL CHECK (sale_cents > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  kind text NOT NULL CHECK (kind IN ('credit','reversal')),
  source text NOT NULL CHECK (source IN ('manual','automatic')),
  actor uuid NOT NULL,
  available_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > available_at),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company, sale_date, sale_id, kind)
);
CREATE INDEX IF NOT EXISTS sat_ledger_customer_idx ON sat_ledger(company,customer,branch,created_at DESC);
CREATE INDEX IF NOT EXISTS sat_ledger_branch_idx ON sat_ledger(company,branch,created_at DESC);
CREATE OR REPLACE FUNCTION sat_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sat_ledger accepts compensating entries only';
END;
$$;
DROP TRIGGER IF EXISTS sat_ledger_immutable ON sat_ledger;
CREATE TRIGGER sat_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON sat_ledger
FOR EACH STATEMENT EXECUTE FUNCTION sat_ledger_immutable();
CREATE TABLE IF NOT EXISTS sat_consent (
  company text NOT NULL,
  customer integer NOT NULL,
  promotional boolean NOT NULL DEFAULT false,
  transactional boolean NOT NULL DEFAULT false,
  opted_out boolean NOT NULL DEFAULT false,
  phone text,
  PRIMARY KEY(company,customer)
);
CREATE TABLE IF NOT EXISTS sat_consent_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  customer integer NOT NULL,
  actor uuid NOT NULL,
  promotional boolean NOT NULL,
  transactional boolean NOT NULL,
  opted_out boolean NOT NULL,
  phone text,
  evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sat_redemption_demo (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  branch integer NOT NULL,
  customer integer NOT NULL,
  order_reference text NOT NULL,
  order_cents bigint NOT NULL CHECK (order_cents > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  actor uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company,branch,order_reference)
);
CREATE TABLE IF NOT EXISTS sat_campaigns (
  id uuid PRIMARY KEY,
  company text NOT NULL,
  actor uuid NOT NULL,
  branches integer[],
  name text NOT NULL,
  template text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('promotional','transactional')),
  schedule_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sat_campaigns_actor_idx ON sat_campaigns(company,actor,created_at DESC);
CREATE TABLE IF NOT EXISTS sat_message_queue (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign uuid NOT NULL REFERENCES sat_campaigns(id),
  customer integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','failed','skipped','unknown')),
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL,
  attempted_at timestamptz,
  provider_id text,
  provider_status text,
  ledger_id bigint REFERENCES sat_ledger(id),
  automation_event text,
  UNIQUE(campaign,customer)
);
CREATE INDEX IF NOT EXISTS sat_message_queue_ready_idx ON sat_message_queue(next_at,id) WHERE status='queued';
CREATE INDEX IF NOT EXISTS sat_message_queue_attempted_idx ON sat_message_queue(campaign,attempted_at DESC) WHERE attempted_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS sat_automations (
  company text NOT NULL,
  event text NOT NULL CHECK (event IN ('granted','released','expiring','expired','inactive','birthday')),
  enabled boolean NOT NULL,
  days integer NOT NULL CHECK (days BETWEEN 1 AND 3650),
  template text NOT NULL,
  actor uuid NOT NULL,
  active_since timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY(company,event)
);
CREATE TABLE IF NOT EXISTS sat_automation_events (
  company text NOT NULL,
  event text NOT NULL,
  event_key text NOT NULL,
  PRIMARY KEY(company,event,event_key)
);
COMMIT;
