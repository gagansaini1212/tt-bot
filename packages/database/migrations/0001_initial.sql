CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exchange_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange text NOT NULL,
  label text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('simulation', 'live')),
  accounting_currency text NOT NULL,
  status text NOT NULL CHECK (status IN ('connected', 'reconciling', 'unavailable', 'handed_over')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id)
);

CREATE TABLE strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_account_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('simulation', 'active', 'paused', 'retired')),
  current_version integer NOT NULL CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts(customer_id, id)
);

CREATE TABLE strategy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  strategy_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  rules jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_id, version),
  FOREIGN KEY (customer_id, strategy_id)
    REFERENCES strategies(customer_id, id)
);

CREATE TABLE allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_account_id uuid NOT NULL,
  strategy_id uuid,
  currency text NOT NULL,
  amount numeric(38, 18) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts(customer_id, id),
  FOREIGN KEY (customer_id, strategy_id)
    REFERENCES strategies(customer_id, id)
);

CREATE TABLE trade_proposals (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_account_id uuid NOT NULL,
  strategy_id uuid NOT NULL,
  strategy_version integer NOT NULL,
  source_snapshot_id uuid NOT NULL,
  instrument text NOT NULL,
  market_kind text NOT NULL CHECK (market_kind IN ('spot', 'perpetual')),
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  quantity numeric(38, 18) NOT NULL CHECK (quantity > 0),
  entry_price numeric(38, 18) NOT NULL CHECK (entry_price > 0),
  stop_loss_price numeric(38, 18) NOT NULL CHECK (stop_loss_price > 0),
  take_profit_price numeric(38, 18) NOT NULL CHECK (take_profit_price > 0),
  leverage integer NOT NULL CHECK (leverage > 0),
  entry_expires_at timestamptz NOT NULL,
  rationale text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'rejected', 'authorized', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts(customer_id, id),
  FOREIGN KEY (customer_id, strategy_id)
    REFERENCES strategies(customer_id, id),
  FOREIGN KEY (strategy_id, strategy_version)
    REFERENCES strategy_versions(strategy_id, version)
);

CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  allocation_id uuid NOT NULL,
  proposal_id uuid NOT NULL UNIQUE,
  amount numeric(38, 18) NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('held', 'committed', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  FOREIGN KEY (customer_id, allocation_id)
    REFERENCES allocations(customer_id, id),
  FOREIGN KEY (customer_id, proposal_id)
    REFERENCES trade_proposals(customer_id, id)
);

CREATE TABLE order_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  proposal_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'submitting', 'unknown', 'acknowledged', 'rejected', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id),
  FOREIGN KEY (customer_id, proposal_id)
    REFERENCES trade_proposals(customer_id, id)
);

CREATE TABLE exchange_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_intent_id uuid NOT NULL,
  exchange_order_id text,
  client_order_id text NOT NULL,
  status text NOT NULL,
  requested_quantity numeric(38, 18) NOT NULL CHECK (requested_quantity > 0),
  filled_quantity numeric(38, 18) NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  average_fill_price numeric(38, 18),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id),
  UNIQUE (customer_id, client_order_id),
  FOREIGN KEY (customer_id, order_intent_id)
    REFERENCES order_intents(customer_id, id)
);

CREATE TABLE fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_order_id uuid NOT NULL,
  exchange_fill_id text NOT NULL,
  quantity numeric(38, 18) NOT NULL CHECK (quantity > 0),
  price numeric(38, 18) NOT NULL CHECK (price > 0),
  fee numeric(38, 18) NOT NULL DEFAULT 0,
  fee_currency text NOT NULL,
  filled_at timestamptz NOT NULL,
  UNIQUE (exchange_order_id, exchange_fill_id),
  FOREIGN KEY (customer_id, exchange_order_id)
    REFERENCES exchange_orders(customer_id, id)
);

CREATE TABLE position_ownership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_account_id uuid NOT NULL,
  strategy_id uuid NOT NULL,
  strategy_version integer NOT NULL,
  instrument text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closing', 'closed', 'handed_over')),
  first_fill_at timestamptz NOT NULL,
  UNIQUE (customer_id, id),
  UNIQUE (exchange_account_id, instrument),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts(customer_id, id),
  FOREIGN KEY (strategy_id, strategy_version)
    REFERENCES strategy_versions(strategy_id, version)
);

CREATE TABLE holding_deadlines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  position_ownership_id uuid NOT NULL UNIQUE,
  deadline_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'triggered', 'satisfied', 'overdue')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, position_ownership_id)
    REFERENCES position_ownership(customer_id, id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  topic text NOT NULL,
  deduplication_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);

CREATE INDEX allocations_customer_id_idx ON allocations(customer_id);
CREATE INDEX proposals_customer_status_idx ON trade_proposals(customer_id, status);
CREATE INDEX orders_customer_status_idx ON exchange_orders(customer_id, status);
CREATE INDEX audit_customer_time_idx ON audit_events(customer_id, occurred_at DESC);
CREATE INDEX outbox_pending_idx ON outbox_jobs(available_at) WHERE completed_at IS NULL;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_isolation ON customers
  USING (id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'exchange_accounts',
    'strategies',
    'strategy_versions',
    'allocations',
    'trade_proposals',
    'budget_reservations',
    'order_intents',
    'exchange_orders',
    'fills',
    'position_ownership',
    'holding_deadlines',
    'audit_events',
    'outbox_jobs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY customer_isolation ON %I USING (customer_id = nullif(current_setting(''app.current_customer_id'', true), '''')::uuid) WITH CHECK (customer_id = nullif(current_setting(''app.current_customer_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;
