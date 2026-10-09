-- The last nonce each exchange account used on a venue that requires
-- strictly increasing nonces, such as Kraken (ADR 0009 §6, issue #21). The
-- worker sends one signed request at a time per such account, across all
-- its processes, under an advisory lock, and issues each nonce from here, so
-- a nonce is never reused, also after a restart. No venue in this build uses
-- nonces yet; PostgresNonceStore in apps/execution writes it.
CREATE TABLE exchange_account_nonces (
  exchange_account_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  last_nonce bigint NOT NULL CHECK (last_nonce > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts (customer_id, id)
);

ALTER TABLE exchange_account_nonces ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_isolation ON exchange_account_nonces
  USING (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON exchange_account_nonces TO trading_app;
