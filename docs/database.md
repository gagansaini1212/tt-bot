# Database

PostgreSQL holds the trading state ([ADR 0003](adr/0003-own-trading-state-outside-eve-sessions.md)). The code is in `packages/database`; the execution worker is its main user. Read this before adding a table, a query, or a worker loop that touches customer data.

## Run it

```bash
pnpm db:up        # PostgreSQL 17 in Docker Compose
pnpm db:migrate   # apply pending migrations
pnpm db:seed      # dev customer, their testnet exchange account, DATABASE_URL's login role
```

Both commands are safe to run again. To start from an empty database, run `docker compose down -v`, which deletes the volume, then the three commands again.

| Variable             | Used by                           | Role                                                                                       |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | execution worker                  | A login role in `trading_worker`. Never a superuser or the owner. `pnpm db:seed` makes it. |
| `DATABASE_ADMIN_URL` | `pnpm db:migrate`, `pnpm db:seed` | The schema owner. The apps never use it.                                                   |
| `TEST_DATABASE_URL`  | `pnpm test`                       | A superuser on a server the tests may create and drop databases and roles on.              |

Without `TEST_DATABASE_URL`, the database tests skip and say why. CI runs them against a PostgreSQL service container.

## Add a migration

1. Create `packages/database/migrations/<UTC timestamp>_<description>.sql`, for example `20261009143000_strategy_settings.sql`. Get the timestamp from `date -u +%Y%m%d%H%M%S`. Use lowercase letters, digits and underscores. `0001_initial.sql` predates the convention and always runs first.
2. Write plain SQL. The runner wraps each file in a transaction, so leave out `BEGIN`/`COMMIT`, and avoid statements that cannot run in one, such as `CREATE INDEX CONCURRENTLY`.
3. Run `pnpm db:migrate`.

The runner applies every file not recorded in `schema_migrations`, in name order, each in its own transaction together with its record. A failing migration rolls back completely and stops the run. An advisory lock lets concurrent runs proceed safely. Each record keeps a checksum, and editing a migration that has been applied is an error: add a new one instead. A database first set up with the old psql-based `db:migrate` is recognised, and `0001_initial.sql` is recorded instead of run again.

Branches add migrations in parallel, so a database can apply them out of timestamp order. A migration must not depend on another branch's unmerged migration. `pnpm db:migrate` warns about applied migrations missing from your checkout, usually ones from another branch.

A new table that holds customer data needs, in the same migration:

- a `customer_id uuid NOT NULL REFERENCES customers(id)` column;
- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and a `customer_isolation` policy like 0001's;
- `GRANT SELECT, INSERT, UPDATE … TO trading_app`, and only what the apps need.

The test "every table the app can use has row-level security" fails for any table `trading_app` can use without a policy.

## Roles and row-level security

Superusers, table owners and roles with `BYPASSRLS` skip row-level security. If the apps connected as one of them, every customer's rows would be visible. So the apps log in as roles that 0001's `customer_isolation` policies apply to:

| Role             | Created by                          | Can                                                                                    |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| owner            | your PostgreSQL setup               | Everything. Runs migrations and the seed.                                              |
| `trading_app`    | migration `…_app_roles`, `NOLOGIN`  | Read and write customer tables in one customer's scope. `audit_events` is insert-only. |
| `trading_worker` | migration `…_app_roles`, `NOLOGIN`  | Everything `trading_app` can, plus `listCustomerIds`.                                  |
| login roles      | `pnpm db:seed` (dev), you (deploys) | Members of one of the above. `DATABASE_URL` names one.                                 |

The policies compare each row's `customer_id` with the `app.current_customer_id` setting. `withCustomerScope` sets it for one transaction only, so a pooled connection never carries it into the next query. Outside a scope, no customer rows are visible.

Before its first query, the worker runs `assertRowLevelSecurity`, which fails unless row-level security applies to its connection on every table that has it. `pnpm db:seed` runs the same check against `DATABASE_URL`.

## Scoping rules

1. Read and write customer data only inside `withCustomerScope(database, customerId, (tx) => …)`.
2. Keep each scope one short unit of work. Never wait on Binance, or any other network call, inside it: commit first, call out, then open a new scope for the result.
3. To visit every customer, as reconciliation will, call `listCustomerIds(database)`, then handle each customer in their own scopes. It needs `trading_worker` and returns IDs only. Do not add a `BYPASSRLS` role, or a `SECURITY DEFINER` function that returns customer rows, for this. [ADR 0005](adr/0005-isolate-customers-with-row-level-security.md) explains why.
4. The audit trail is append-only. Add events; never update them.

## The current customer

The web app decides which customer a request acts for, and the worker acts only for that customer.

- **Web.** `getCurrentCustomer()` in `apps/web/src/lib/current-customer.ts` is the only source of the customer. Until customer sign-in (#35), it returns the seeded dev customer; #35 replaces its body with a Better Auth session lookup. It returns null when nobody is signed in, and callers already handle that.
- **Web to worker.** `callWorkerForCustomer` sends the customer's ID in the `X-Customer-Id` header. The worker trusts that header because only the web server holds the worker's bearer token, and the worker refuses browser requests.
- **Worker.** Routes built with `handler` are customer routes: the worker reads the header, then looks up the exchange account its Binance credentials belong to, in that customer's scope. A customer who does not own it, or a missing seed, gets `{ status: "not_configured", reason: "exchange_account" }`; a database failure gets `reason: "database"`. Either way nothing is sent to Binance. The handler receives the `account` and passes it down, so every query runs in that customer's scope. Market data uses `publicHandler` and needs no customer.
- **Credentials.** The worker's testnet credentials belong to the seeded dev exchange account (`TESTNET_EXCHANGE_ACCOUNT_ID` in `apps/execution/src/accounts.ts`) until exchange accounts keep their own. The CLI acts for the dev customer.

## Development seed

`pnpm db:seed` inserts these rows if they are missing and leaves existing ones alone.

| Row                          | ID                                     | Details                                                             |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| Dev customer                 | `6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a01` | "Development customer"                                              |
| Binance Spot Testnet account | `6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a02` | `binance-spot-testnet`, mode `simulation`, USDT, status `connected` |

The IDs are exported from `@crypto-trading/database/dev-seed`, which imports nothing, so the web app can use them without a database client.

## How the worker handles order intents

Dashboard orders and CLI orders are the customer's own instructions, not AI proposals. Their `order_intents` row has no `proposal_id`; it names the exchange account and keeps the order exactly as it is sent in `manual_order`. The client order ID sent to Binance (the order list's ID for a dashboard order) is the intent's `idempotency_key`, which is unique across all customers. `PostgresOrderIntents` in `apps/execution/src/order-intents.ts` implements it all.

1. The worker runs its checks with fresh Binance data. No transaction is open.
2. `record` saves the intent with status `submitting`, an `order_intent.reconcile` outbox job due one minute later, and an audit event, in one transaction, and commits. If the client order ID was used before, by anyone, the order is a duplicate and nothing is sent.
3. The worker sends the order to Binance. No transaction is open.
4. `settle` records the answer in a new transaction:

| Binance's answer                   | Intent         | Reconcile job                    |
| ---------------------------------- | -------------- | -------------------------------- |
| Accepted, or found by client ID    | `acknowledged` | completed                        |
| Refused (rejected or rate limited) | `rejected`     | completed                        |
| No confirmation, and not found     | `unknown`      | stays due, with `last_error` set |

5. **Check order status** finds the intent by client order ID, then asks Binance by that ID. If Binance has the order, an `unknown` intent becomes `acknowledged`. If Binance has no such order, the page says so, but the intent stays `unknown` and its ID stays used: only reconciliation may decide that an unknown outcome failed.

Nothing retries a submission. A crash between steps 2 and 4 leaves the intent `submitting` with its job due, which is how reconciliation (#42) finds it. A consumer of `order_intent.reconcile` jobs looks the order up by client order ID, never resubmits it, and completes the job once the outcome is known.

Each protected entry (ADR 0004, from the rules work in #44) is one order intent. Its holding deadline is a `holding_deadlines` row keyed by `order_intent_id`, one per entry, so a position can hold several.

`exchange_orders` keeps what Binance last reported for each order: the entry, and each exit once Binance sizes it after the entry fills. Placements, status checks and cancels update it. Cancels are audited as `order.cancelled`.

Before PostgreSQL, intents were files in `.testnet-orders/`. The worker refuses to start or place CLI orders while that directory holds any. `pnpm exchange import-journal` copies them in for the dev customer, keeping each outcome; an unconfirmed one becomes `unknown`. Delete the directory afterwards.
