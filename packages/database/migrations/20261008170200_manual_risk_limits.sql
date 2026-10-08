-- The customer's limits for orders they place by hand, from the dashboard or
-- the worker's CLI, on one exchange account. Each change adds a version and
-- never edits an earlier one. The worker reads the latest version
-- immediately before each order, so a change applies to new orders only.
-- Amounts are in the exchange account's accounting currency.
CREATE TABLE manual_risk_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_account_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  -- The largest order, which is also the largest position.
  max_order_notional numeric(38, 18) NOT NULL CHECK (max_order_notional > 0),
  -- The most the day's orders, since midnight UTC, may lose at their stop
  -- losses, a CLI buy, which has no stop, counting in full. Reaching it only
  -- refuses new orders: it is not a strategy's loss limit.
  max_daily_risk numeric(38, 18) NOT NULL CHECK (max_daily_risk > 0),
  -- How far below the entry price the order drawer suggests a stop loss.
  default_stop_loss_percent numeric(7, 4) NOT NULL
    CHECK (default_stop_loss_percent > 0 AND default_stop_loss_percent < 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_account_id, version),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts (customer_id, id)
);

ALTER TABLE manual_risk_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_isolation ON manual_risk_limits
  USING (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

-- Versions are immutable.
GRANT SELECT, INSERT ON manual_risk_limits TO trading_app;
