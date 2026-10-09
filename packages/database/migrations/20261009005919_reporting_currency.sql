-- The customer's reporting currency (ADR 0009): the one currency the
-- dashboard shows amounts in and adds them up in across exchange accounts.
-- It is for display only. Allocations, reservations, loss limits and the
-- daily drawdown limit stay in each exchange account's accounting currency,
-- and a change here changes none of them. Every account in M4 accounts in
-- USDT, and every venue lists USDT markets, so USDT is the default.
ALTER TABLE customers
  ADD COLUMN reporting_currency text NOT NULL DEFAULT 'USDT'
    CONSTRAINT customers_reporting_currency_check
      CHECK (reporting_currency ~ '^[A-Z0-9]{1,20}$');
