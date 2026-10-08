-- Roles the applications use. Superusers, table owners and BYPASSRLS roles
-- skip row-level security, so the web app and the execution worker log in as
-- members of these roles instead, and 0001's customer_isolation policies
-- apply to every query they run. Roles belong to the whole cluster, so
-- another database may have created them already.
--
--   trading_app     reads and writes customer rows, one customer at a time
--                   (withCustomerScope).
--   trading_worker  trading_app, plus listing customer IDs so the execution
--                   worker can find each customer's work.
DO $$
BEGIN
  CREATE ROLE trading_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE trading_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE IN ROLE trading_app;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname IN ('trading_app', 'trading_worker')
      AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'trading_app and trading_worker must not bypass row-level security';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO trading_app;

GRANT SELECT, INSERT, UPDATE ON
  customers,
  exchange_accounts,
  strategies,
  strategy_versions,
  allocations,
  trade_proposals,
  budget_reservations,
  order_intents,
  exchange_orders,
  fills,
  position_ownership,
  holding_deadlines,
  outbox_jobs
TO trading_app;

-- The audit trail is append-only.
GRANT SELECT, INSERT ON audit_events TO trading_app;

-- The only cross-customer read. It returns IDs and nothing else; the worker
-- then reads and writes each customer's rows in that customer's scope.
CREATE FUNCTION worker_customer_ids() RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
  AS $$ SELECT id FROM public.customers ORDER BY id $$;

REVOKE ALL ON FUNCTION worker_customer_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_customer_ids() TO trading_worker;
