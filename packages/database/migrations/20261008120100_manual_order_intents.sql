-- Orders a customer enters by hand, on the dashboard or with the worker's CLI,
-- are not AI proposals. Their intent names the exchange account and keeps the
-- order exactly as it is sent, so it can be looked up by its client order ID
-- (the intent's idempotency_key) and is never sent twice.
ALTER TABLE order_intents
  ALTER COLUMN proposal_id DROP NOT NULL,
  ADD COLUMN exchange_account_id uuid,
  ADD COLUMN manual_order jsonb,
  ADD CONSTRAINT order_intents_exchange_account_fkey
    FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts (customer_id, id),
  ADD CONSTRAINT order_intents_source_check CHECK (
    CASE
      WHEN proposal_id IS NULL
        THEN manual_order IS NOT NULL AND exchange_account_id IS NOT NULL
      ELSE manual_order IS NULL
    END
  );
