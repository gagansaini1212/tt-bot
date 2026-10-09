-- The instruments an exchange account may trade, named BASE-QUOTE, such as
-- BTC-USDT. Its venue's market catalogue decides what exists; this list
-- decides what the customer allows, and strategy rules narrow it again.
-- Existing and new accounts start with the two markets the application
-- traded before instruments came from the venue, so nothing changes until a
-- customer widens the list. At most ten: the worker reads each one's open
-- orders and fills for every snapshot, within the venue's request weight.
ALTER TABLE exchange_accounts
  ADD COLUMN allowed_instruments text[] NOT NULL
    DEFAULT ARRAY['BTC-USDT', 'ETH-USDT']::text[]
    CONSTRAINT exchange_accounts_allowed_instruments_size
      CHECK (cardinality(allowed_instruments) BETWEEN 1 AND 10);
