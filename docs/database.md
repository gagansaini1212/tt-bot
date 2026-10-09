# Database

PostgreSQL holds the trading state ([ADR 0003](adr/0003-own-trading-state-outside-eve-sessions.md)). The code is in `packages/database`; the execution worker is its main user. Read this before adding a table, a query, or a worker loop that touches customer data.

## Run it

```bash
pnpm db:up        # PostgreSQL 17 in Docker Compose
pnpm db:migrate   # apply pending migrations
pnpm db:seed      # dev customer, their testnet exchange account and login, DATABASE_URL's login role
```

Both commands are safe to run again. To start from an empty database, run `docker compose down -v`, which deletes the volume, then the three commands again.

| Variable             | Used by                           | Role                                                                                       |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | execution worker, web app         | A login role in `trading_worker`. Never a superuser or the owner. `pnpm db:seed` makes it. |
| `DATABASE_ADMIN_URL` | `pnpm db:migrate`, `pnpm db:seed` | The schema owner. The apps never use it.                                                   |
| `TEST_DATABASE_URL`  | `pnpm test`                       | A superuser on a server the tests may create and drop databases and roles on.              |

Without `TEST_DATABASE_URL`, the database tests skip and say why. CI runs them against a PostgreSQL service container.

The web app reads the repository's `.env` as well as its own `apps/web/.env.local`, whose values win. It uses `DATABASE_URL` for customer sign-in, and `AUTH_SECRET` to sign session cookies and the assistant's customer tokens.

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

The test "every table the app can use has row-level security" fails for any table `trading_app` can use without a policy. The sign-in tables are the one exception, kept from `trading_app` altogether ([ADR 0006](adr/0006-keep-sign-in-tables-outside-row-level-security.md), and [Sign-in](#sign-in) below).

## Roles and row-level security

Superusers, table owners and roles with `BYPASSRLS` skip row-level security. If the apps connected as one of them, every customer's rows would be visible. So the apps log in as roles that 0001's `customer_isolation` policies apply to:

| Role             | Created by                          | Can                                                                                    |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| owner            | your PostgreSQL setup               | Everything. Runs migrations and the seed.                                              |
| `trading_app`    | migration `…_app_roles`, `NOLOGIN`  | Read and write customer tables in one customer's scope. `audit_events` is insert-only. |
| `trading_worker` | migration `…_app_roles`, `NOLOGIN`  | Everything `trading_app` can, plus `listCustomerIds`.                                  |
| `trading_auth`   | migration `…_customer_sign_in`      | Use the sign-in tables, and nothing else. See [Sign-in](#sign-in).                     |
| login roles      | `pnpm db:seed` (dev), you (deploys) | Members of the above. `DATABASE_URL` names one.                                        |

The policies compare each row's `customer_id` with the `app.current_customer_id` setting. `withCustomerScope` sets it for one transaction only, so a pooled connection never carries it into the next query. Outside a scope, no customer rows are visible.

Before its first query, the worker runs `assertRowLevelSecurity`, which fails unless row-level security applies to its connection on every table that has it. `pnpm db:seed` runs the same check against `DATABASE_URL`.

Locally the worker and the web app share `DATABASE_URL`, so `pnpm db:seed` makes its login role a member of `trading_worker` and `trading_auth`. A deployment gives each app its own login: the worker one in `trading_worker`, the web app one in `trading_auth` (and `trading_app` once it reads customer data).

## Sign-in

Customers sign in to the web app with Better Auth, using email and password. Each **login** (`auth_users`) acts for one customer, named by its `customer_id`; a customer may have several. Better Auth also keeps sessions (`auth_sessions`), password hashes (`auth_accounts`) and one-time tokens (`auth_verifications`). `apps/web/src/lib/auth-options.ts` maps its models onto these tables, and Better Auth checks they match when it starts.

Better Auth finds a session by its token, and a login by its email, before anyone knows which customer is asking, so these tables have no `customer_isolation` policy ([ADR 0006](adr/0006-keep-sign-in-tables-outside-row-level-security.md)). Instead only `trading_auth` may use them, and `trading_app` and `trading_worker` may not, so code that handles trading data never reads passwords or session tokens. `trading_auth` cannot read trading data, create logins, change the customer a login acts for, or move a password to another login. There is no sign-up: logins are created with the schema owner's role, as `pnpm db:seed` does for the dev login.

## Scoping rules

1. Read and write customer data only inside `withCustomerScope(database, customerId, (tx) => …)`.
2. Keep each scope one short unit of work. Never wait on Binance, or any other network call, inside it: commit first, call out, then open a new scope for the result.
3. To visit every customer, as reconciliation will, call `listCustomerIds(database)`, then handle each customer in their own scopes. It needs `trading_worker` and returns IDs only. Do not add a `BYPASSRLS` role, or a `SECURITY DEFINER` function that returns customer rows, for this. [ADR 0005](adr/0005-isolate-customers-with-row-level-security.md) explains why.
4. The audit trail is append-only. Add events; never update them.

## The current customer

The web app decides which customer a request acts for, and the worker acts only for that customer.

- **Web.** `getCurrentCustomer()` in `apps/web/src/lib/current-customer.ts` is the only source of the customer: the signed-in login's customer, read from the Better Auth session in the database on every request. It returns null when nobody is signed in. The proxy (`apps/web/src/proxy.ts`) sends signed-out visitors to `/sign-in`, but every server action and data access still checks for itself, as `callWorkerForCustomer` does.
- **Fresh sign-in.** Changing exchange credentials or activating live trading needs a customer who signed in within the last ten minutes. Start such an action with `requireFreshSession(next)` from `apps/web/src/lib/fresh-session.ts`: it returns the customer, or redirects them to confirm their password, which starts a fresh session, and then back to `next`. An action that must answer instead can use `checkFreshSession()` and refuse unless it returns `fresh`.
- **Assistant.** The eve assistant runs as its own process behind `/eve`, and cannot read sessions. The proxy checks the session on every assistant request and forwards it with a one-minute token naming the customer, without the browser's cookies. `agent/lib/customer-principal.ts` turns the token into the session's principal, and tools such as `draft_trade_proposal` act only for that customer, and only in a conversation that customer started (`customerIdFrom` compares the turn's caller with the conversation's initiator). eve does not stop another signed-in customer who knows a conversation's ID from reading its stream. Only the browser that started a conversation learns its ID, so never show, log or link one where another customer could see it until conversations record their owner.
- **Web to worker.** `callWorkerForCustomer` sends the customer's ID in the `X-Customer-Id` header. The worker trusts that header because only the web server holds the worker's bearer token, and the worker refuses browser requests.
- **Assistant to worker.** The assistant's tools act for the customer `customerIdFrom` returns, and send that customer the same way, with their own token, `EXECUTION_ASSISTANT_TOKEN`. That token reaches only `POST /decisions`, and the web server's token cannot call that route.
- **Worker.** Routes built with `handler` are customer routes: the worker reads the header, then looks up the testnet exchange account in that customer's scope, then the Binance client for that account's keys. A customer who does not own the account, or a missing seed, gets `{ status: "not_configured", reason: "exchange_account" }`; a database failure gets `reason: "database"`; saved keys the worker cannot open get `reason: "credentials"`. In each case nothing is sent to Binance. The handler receives the `account` and passes it down, so every query runs in that customer's scope. `accountHandler` routes, such as the account's risk limits, need the account but no Binance client. `customerHandler` routes, such as notifications and exchange accounts, need only the customer; the exchange account routes name the account in the request and look it up in the customer's scope themselves. Market data uses `publicHandler` and needs no customer or keys.
- **Credentials.** Each exchange account has one credential set, an `exchange_credentials` row, saved from Settings → Exchange accounts ([Exchange accounts](#exchange-accounts)). The worker seals the API key, the secret or private key, and the passphrase if the venue has one, with AES-256-GCM under `CREDENTIALS_MASTER_KEY` (`apps/execution/src/secret-box.ts`), with a fresh nonce each time and the customer, account and column as associated data, so a sealed value copied to another row does not open. `key_type` says how the key signs: `hmac`, or a PEM private key, `ed25519`, `rsa` or `es256` (P-256, signing JWTs). Only the last four characters of the API key are stored in the clear, with `api_key_fingerprint`, an HMAC of the API key under a key derived from the master key, unique across customers, so one API key serves one exchange account ([ADR 0011](adr/0011-disconnect-exchange-accounts-without-deleting-them.md)). Keys never reach the browser, logs, audit details or the assistant, and the web app sends changes only after `requireFreshSession`. An account without saved keys falls back to the worker's `.env` keys, which belong to the seeded dev account only (`TESTNET_EXCHANGE_ACCOUNT_ID` in `apps/execution/src/accounts.ts`). Saved keys that do not open never fall back. The CLI acts for the dev customer with the same keys.

## Exchange accounts

A customer may hold up to ten exchange accounts (`MAX_EXCHANGE_ACCOUNTS`), on any venue the build has an adapter for. Settings → Exchange accounts lists them and adds, renames, tests, gives new keys to and removes them, through the worker's `/exchange-accounts` routes (`apps/execution/src/routes/exchange-accounts.ts`). `ExchangeAccountStore` in `apps/execution/src/exchange-accounts.ts` reads and writes them, in the customer's scope.

| Column                                                  | What it holds                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exchange`                                              | The venue ID, chosen from the registry in `packages/exchanges/src/venues.ts`.                                                                                                                                                                                                         |
| `label`                                                 | The customer's name for it, 1 to 64 characters, unique per customer, ignoring case, among accounts not removed.                                                                                                                                                                       |
| `mode`                                                  | `simulation` on a venue with virtual funds, such as a testnet; `live` only on a read-only venue, which is never traded (`accountModes`). A check refuses a `live` row unless its `supported_features` say `read_only`.                                                                |
| `accounting_currency`                                   | USDT for every account in M4 ([ADR 0009](adr/0009-keep-exchange-accounts-isolated-across-venues.md#3-accounting-currency-and-reporting-currency)): risk limits and allocations are still USDT amounts.                                                                                |
| `status`, `disconnected_at`                             | `connected` when added; the worker may set `reconciling` or `unavailable`. `disconnected`, with its time, once the customer removes it, and `handed_over` after an account handover, which M4 does not offer yet. The worker never resolves, reads or trades an account in either.    |
| `supported_features`, `supported_features_refreshed_at` | The venue adapter's declared capabilities ([ADR 0008](adr/0008-normalize-venues-markets-and-order-ids.md#venues-and-their-capabilities)), recorded when the account is added, given new keys, or passes a connection test. Null until then. Order paths still ask the adapter itself. |

- **New keys** are checked before they are saved: a key type the venue accepts, a passphrase exactly when it needs one, and keys its adapter can sign with (`prepareCredentials`). Where the adapter implements `getKeyPermissions`, the worker then asks the venue what the key may do, and refuses one that can withdraw, or, on a read-only venue, trade (`excessKeyPermissions`, [ADR 0009 §4](adr/0009-keep-exchange-accounts-isolated-across-venues.md#4-read-only-venues)). A venue that cannot say is saved with a warning that read only was not verified. A connection test asks again.
- **Removing** an account disconnects it and deletes its keys in one transaction, and is refused while the product still manages something there: a running strategy, an open or closing position, or an order intent that is held, being sent, of unknown outcome, or an entry the loop has not finished with ([ADR 0011](adr/0011-disconnect-exchange-accounts-without-deleting-them.md)).
- Adds and renames lock the customer's row, so the label and the account limit hold under concurrent requests. Each change is audited as `exchange_account.added`, `.relabelled` or `.disconnected`, and key changes as `exchange_keys.saved` and `.removed`, without the keys.

## Risk limits

`manual_risk_limits` keeps an exchange account's limits for orders placed by hand: the per-order cap, the daily risk limit and the default stop-loss percentage. The daily risk limit bounds what the day's manual orders would lose at their stops, a CLI buy counting in full (`manualOrderRisk`); it is not a strategy's loss limit. Each change from Settings inserts the next version, made from the version the customer edited, and an audit event; a change from a stale version is refused. The app role can only read and insert. The worker reads the latest version immediately before each order and lowers it to the platform maximums in `apps/execution/src/risk-limits.ts`. Without a version, dashboard and CLI orders stay off.

## Allowed instruments

`exchange_accounts.allowed_instruments` lists the instruments, named `BASE-QUOTE`, that the account's customer allows. It defaults to `BTC-USDT` and `ETH-USDT`, and holds from one to ten. Its venue's market catalogue decides what exists, and the account's accounting currency what a strategy may trade there ([ADR 0008](adr/0008-normalize-venues-markets-and-order-ids.md)). `apps/execution/src/instrument-access.ts` reads it in the customer's scope: strategy creation and every entry's reservation read it in their own transaction, and dashboard orders, the assistant's decisions and the snapshot read it through `RiskLimitStore.allowedInstruments`. There is no screen to change it yet; to widen it, update the column.

## Notifications and webhooks

`notifications` is shared: the execution worker's alerts are rows in it, written in the customer's scope. `notification_webhooks` holds a customer's Discord or Telegram URL, sealed like exchange keys. A trigger on `notifications` inserts a `notification.webhook` outbox job for each of the customer's webhooks in the same transaction as the alert. `NotificationWebhooks.deliver` handles one job: it reads the alert and URL in one scope, posts with no transaction open, and says whether the job is done, worth retrying or failed for good. The execution loop runs a delivery round after each pass, beside the next one, so a slow webhook never delays protective work: it claims each customer's due jobs of that topic with the outbox's lease and settles them with `settleDelivery`, retrying with the outbox's backoff (from 30 seconds to 15 minutes, never sooner than the destination asks) and giving up after eight attempts with an audit event. Each alert is queued once and posted once; only a worker that stops between posting and recording the post can post it again.

## Development seed

`pnpm db:seed` inserts these rows if they are missing and leaves existing ones alone.

| Row                          | ID                                     | Details                                                                                            |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Dev customer                 | `6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a01` | "Development customer"                                                                             |
| Binance Spot Testnet account | `6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a02` | `binance-spot-testnet`, mode `simulation`, USDT, status `connected`, BTC-USDT and ETH-USDT allowed |
| Dev login                    | `6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a03` | `dev@example.com`, password `development-password`, for the dev customer                           |

Sign in to the web app with the dev login. The seed never resets its password, so a changed password stays changed.

The IDs are exported from `@crypto-trading/database/dev-seed`, which imports nothing, so the web app can use them without a database client.

## How the worker handles order intents

Dashboard orders and CLI orders are the customer's own instructions, not AI proposals. Their `order_intents` row has no `proposal_id`; it names the exchange account and keeps the order exactly as it is sent in `manual_order`. An AI proposal the customer approves is placed the same way, and its intent also names the proposal (see [AI decisions and proposals](#ai-decisions-and-proposals)). The client order ID sent to Binance (the order list's ID for a dashboard order) is the intent's `idempotency_key`, which is unique across all customers. `PostgresOrderIntents` in `apps/execution/src/order-intents.ts` implements it all.

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

Nothing retries a submission. A crash between steps 2 and 4 leaves the intent `submitting` with its job due, which is how the execution loop finds it. The loop looks the order up by client order ID, never resubmits it, and completes the job once the outcome is known. If Binance has the order, the intent becomes `acknowledged`. If Binance says it has no such order, the intent becomes `rejected`, audited as `order_intent.not_found`. The job only falls due after the one-minute grace period, so by then Binance cannot still be working on the request. If the lookup fails, the job is retried later with its error in `last_error`.

Each protected entry ([ADR 0004](adr/0004-hold-several-protected-entries-per-strategy.md)) is one order intent. Its holding deadline is a `holding_deadlines` row keyed by `order_intent_id`, one per entry, so a position can hold several.

`exchange_orders` keeps what Binance last reported for each order: the entry, and each exit once Binance sizes it after the entry fills. Placements, status checks and cancels update it. Cancels are audited as `order.cancelled`.

A stop-limit entry is an intent with a `trigger` in `manual_order` and status `pending`, and nothing is sent ([ADR 0007](adr/0007-hold-stop-limit-triggers-and-sell-unprotected-quantity.md)). When its stop price trades, the loop moves it to `submitting`, queues its reconcile job, and sends it like any dashboard entry. The customer can cancel it while it is `pending`, which makes it `cancelled`.

Before PostgreSQL, intents were files in `.testnet-orders/`. The worker refuses to start or place CLI orders while that directory holds any. `pnpm exchange import-journal` copies them in for the dev customer, keeping each outcome; an unconfirmed one becomes `unknown`. Delete the directory afterwards.

## AI decisions and proposals

Every decision the analysis assistant records is an `ai_decisions` row: a trade proposal or no trade, with the model, the prompt version, the account snapshot it was based on (`source_snapshot_id`, a hash of the snapshot's content in UUID form) and the rationale. Decisions are append-only. Each carries its tool call as `idempotency_key`, so a replayed call records nothing twice. A trade proposal's details are a `trade_proposals` row with status `draft`.

A proposal the assistant drafts in conversation belongs to no strategy: its `strategy_id` and `strategy_version` are null. The customer approves or rejects each one, and the worker checks it like the customer's own dashboard order, against the manual allocation and their [risk limits](#risk-limits). A strategy's proposals name their strategy version, and their decisions name the strategy in `ai_decisions.strategy_id`. An AI-managed strategy's draft that waits for the customer is approved under the strategy's own limits instead, through [the strategy runner](#strategies); the customer may reject it like any draft.

`PostgresTradeProposals` in `apps/execution/src/trade-proposals.ts` implements it. An approval goes like a dashboard order, through the same desk and queue:

1. The worker reads the proposal. Only a draft whose entry expiry has not passed can be approved; an expired draft becomes `expired`.
2. It reads the risk limits and fresh Binance data, runs every check on the proposal as saved, then Binance's test order. No transaction is open. If a check refuses the proposal, it becomes `rejected`, with `decided_by = 'execution_checks'` and the reason. Without risk limits, nothing is decided and nothing is sent.
3. `approve` sets the draft to `approved` and saves its order intent, with `proposal_id` set and the order exactly as sent in `manual_order`, with its reconcile job, in one transaction, and commits. The update applies only to a draft, so of two approvals, from two tabs or two workers, only one finds it. The intent's client order ID comes from the proposal's ID, and a partial unique index allows one intent per proposal.
4. The worker sends the order and settles the intent as in [How the worker handles order intents](#how-the-worker-handles-order-intents). From then on the execution loop reconciles it like any dashboard entry, including selling quantity no stop loss protects. With no strategy, it has no holding deadline and pauses no strategy.

A rejection sets an assistant's draft to `rejected` with `decided_by = 'customer'` and the customer's reason, if any. The Activity page derives what the customer sees: a draft past its expiry shows as expired; an approved proposal shows as approved until Binance confirms its order, then follows the loop's `entry_reconciliations` row and the orders it saved in `exchange_orders`, as submitted, filled or cancelled, with the loop's detail line.

## The execution loop

`ExecutionLoop` in `apps/execution/src/execution-loop.ts` runs in `pnpm dev:worker` every five seconds. It visits each customer from `listCustomerIds` whose exchange account the worker trades on, in that customer's scopes, and never holds a transaction while it waits on Binance. A pass:

1. claims due `order_intent.reconcile` jobs and settles each intent, as described above;
2. sends `pending` stop-limit entries whose stop price has traded;
3. starts the exit of entries whose holding deadline has passed;
4. reconciles every `acknowledged` protected entry with Binance, recording its orders in `exchange_orders` and their fills in `fills`;
5. marks exits still held a minute after their deadline `overdue`;
6. runs the customer's [strategies](#strategies).

### Records

| Table                   | What the loop keeps there                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry_reconciliations` | One row per protected entry: its state (`working`, `partly_filled`, `awaiting_exits`, `protected`, `unprotected`, `exiting`, and the final `closed`, `not_filled`, `handed_over`, `missing`), what it filled and still holds, its first fill, why it is being sold (`exit_reason`), and a detail line for the dashboard.                                                                             |
| `order_intents`         | Each market sell closing an entry is its own intent of kind `exit`, saved before it is sent, with `closes_order_intent_id` naming the entry. Its client order ID is the entry's list ID plus `_c1` to `_c9`, so two workers cannot send the same attempt. Three refused sells stop the worker; refusals for a rate limit are counted in `entry_reconciliations.rate_limited_sells` and do not count. |
| `holding_deadlines`     | Created at an entry's first fill, for entries made from a proposal. The deadline is the first fill plus the strategy version's `holdingPeriodSeconds`. `pending` becomes `triggered`, then `satisfied` once the entry holds nothing, or `overdue`. The entry's `position_ownership` row is created or reopened then too, and closed when its last deadline is satisfied.                             |
| `notifications`         | Alerts for the customer, raised in the same transaction as the change they report.                                                                                                                                                                                                                                                                                                                   |
| `audit_events`          | `order_intent.triggered`, `order_intent.not_found`, `order.cancelled`, `entry.exit_requested`, `strategy.paused` and the intent events above.                                                                                                                                                                                                                                                        |

An entry made from a proposal is reconciled like a dashboard entry when its order intent has a `proposal_id` for a spot long proposal. Its `idempotency_key` must be the client ID of the GTC limit OPOCO list sent for it, with the legs suffixed `_en`, `_tp` and `_sl` (`protectedLegIds` in `packages/exchanges`), and its instrument, quantity and prices are the proposal's.

### Running twice

Each customer's pass holds a session advisory lock, `pg_try_advisory_lock`, so a second worker skips that customer. The lock is held by a session, not a transaction, so it locks no rows. Each step is also safe without the lock. Sells and triggers are claimed by inserting or updating an order intent, so only one worker can send each. State changes lock their `entry_reconciliations` row. A worker that finds the entry already finished, or already being sold, does nothing more. `apps/execution/src/execution-loop.test.ts` runs two loops at once both with and without the lock, against a fake Binance and a real PostgreSQL.

### For other modules

- **Stop entries.** `requestEntryExit(database, scope, orderIntentId, reason)` in `execution-store.ts` saves a request that the next pass carries out: it cancels what is open on Binance and sells what the entry holds at market. An entry that holds nothing is only cancelled. `stopStrategyEntries(database, scope, strategyId, reason)` does the same for every entry of a strategy on the account, for close all and loss limits. With reason `pause`, an entry that has filled completely keeps its exits and holding deadline. Only entries still on the book are cancelled, and what a partly filled one bought is sold, because Binance cannot protect it. Any other request, a holding deadline, or a protection failure replaces a pause. `reason` is a lowercase word such as `close_all`, and the dashboard shows it.
- **Pause a strategy.** When protection fails on an entry made from a proposal, the loop pauses its strategy through a `StrategyPauser`. The default sets `strategies.status` to `paused` and audits it. Pass your own as `pauseStrategy` to `ExecutionLoop`.
- **Deliver notifications.** Each alert is one row in `notifications`, inserted in the same transaction as the change it reports, by `raiseNotification` in `notifications.ts`. To deliver alerts elsewhere, such as to webhooks, subscribe to inserts into that table: a trigger on insert can queue each delivery in `outbox_jobs` in the same transaction, whoever writes the row. A consumer then claims due jobs with `claimDueJobs(database, customerId, topic, now)` from `outbox.ts`, delivers each one, and calls `completeJob`, or `retryJob` if delivery failed. Claimed jobs are leased for two minutes, so two consumers never handle the same job.

## Strategies

A strategy ([ADR 0004](adr/0004-hold-several-protected-entries-per-strategy.md)) is a `strategies` row, its versions in `strategy_versions`, and one `allocations` row. `StrategyStore` in `apps/execution/src/strategy-store.ts` keeps them; `StrategyRunner` in `strategy-runner.ts` runs them as the execution loop's last step.

| Table / column                                    | What it holds                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategies.status`                               | `simulation` (Running on the testnet), `paused` or `retired` (Completed). `active` is for live trading, which stays off.                                                                                                                                                                                                                                          |
| `strategies.pause_reason`, `paused_at`            | Why it is paused: `customer`, `close_all`, `loss_limit`, `drawdown`, `kill_switch` or `protection_failed`.                                                                                                                                                                                                                                                        |
| `strategies.exit_request`                         | The exit every entry of the strategy gets until the customer resumes it: `pause`, which cancels pending entries and keeps filled ones protected, or a reason that also sells, such as `close_all` or `loss_limit`. It is applied on every pass, so an entry sent while it was made is stopped too. A stronger request replaces a pause; nothing replaces another. |
| `strategies.loss_limit_reached_at`                | When the worker found a loss limit reached, so it stops the strategy and alerts once. Resuming clears it.                                                                                                                                                                                                                                                         |
| `strategies.rules_ended_at`, `rules_ended_reason` | The rules open no more entries: an expiry, a DCA schedule's end, every standing entry filled, or a grid that left its range. The strategy is retired once it holds nothing, paused or not. A new version clears it and lifts a range stop's close for new entries; a new version of a completed strategy runs it again, as a grid does to trade a new range.      |
| `strategies.next_analysis_at`                     | When an AI-managed strategy's next analysis is due. The worker claims each by moving it on, so two workers never both ask.                                                                                                                                                                                                                                        |
| `strategies.runner_note`                          | What the worker last did or is waiting for, for the card.                                                                                                                                                                                                                                                                                                         |
| `strategy_versions.rules`                         | One of the four rule schemas in `packages/domain/src/strategy-rules.ts`. Versions are never changed: an edit inserts the next one. An AI-managed version also has `proposal_approval` (`required` or `automatic`) and `analysis_interval_minutes`.                                                                                                                |
| `allocations`                                     | One row per strategy (`allocations_strategy_key`). A new version may change its amount; the audit event keeps the previous one.                                                                                                                                                                                                                                   |
| `trade_proposals.entry_key`, `entry_attempt`      | What each of a strategy's entries fills within its rules (`level:3`, `buy:12`, `entry:0`, or `ai`), and how many entries were made for that key. Unique per strategy.                                                                                                                                                                                             |
| `budget_reservations`                             | One per entry: `held` while it has filled nothing, `committed` once it has, `released` once it ends or was never placed. Each pass settles them from the entries' states.                                                                                                                                                                                         |
| `portfolio_risk_limits`                           | The customer's maximum daily drawdown for all their strategies on the account, as a percentage of their allocations. Versioned like `manual_risk_limits`; strategies start and resume only once it is set.                                                                                                                                                        |

### Placing an entry

Each of a strategy's entries is a trade proposal with an order intent, like an approved assistant proposal, but its list client order ID starts with `ct_sg` (`strategyEntryClientOrderId`). The dashboard's own limits leave such entries out: `manualExposure` skips them and the daily risk limit does not count them, and dashboard requests may not use the prefix.

1. The runner plans entries with the domain's planners, or takes an AI proposal, and checks Binance's filters, the free USDT, the stop orders left on the symbol and Binance's test order. No transaction is open.
2. `StrategyStore.reserve` locks the strategy's row and allocation, takes an advisory lock on the account's position in the instrument, settles the reservations, and refuses if the strategy is not running, already holds that key (or, for a DCA buy, ever made it), another strategy holds the market's position, or Binance's stop orders are full. It runs `authorizeTradeProposal` with a policy from `ruleLimits`, the allocation, the committed and reserved budget, the entries held and their notional per instrument, and an entry limit no higher than the stop orders left. If it passes, it saves the proposal as `authorized` (or a draft as `approved`), the `held` reservation and the order intent, with an audit event, and commits.
3. `ProtectedEntrySender.send`, shared with the dashboard's desk and in its queue, places the OPOCO list and settles the intent as in [How the worker handles order intents](#how-the-worker-handles-order-intents).

Concurrent reservations for a strategy wait for each other on its row, so they never commit more than its allocation, and a pause waits for a reservation in progress. Nothing here is retried blindly: an unknown outcome stays unknown until reconciliation, and its key stays occupied until then.

### Each pass

1. For every strategy that is not retired, whatever its losses: settle its reservations, apply its exit request to entries that do not have it yet, cancel unfilled entries past their entry expiry with the cancel-only reason `entry_expired`, and complete it if its rules ended and it holds nothing, with an info notification.
2. Measure every strategy that is not retired, and those completed since midnight UTC. Its fills, entry legs as buys and take profits, stop losses and the worker's sells as sells, become `lossLimitStatus` bookings (`strategy-pnl.ts`): realized results at each sell's time, and fees, a buy's fee in the bought asset valued at its fill price. What each entry still holds is valued at the last price. For the daily limit, what entries held at the latest midnight UTC is valued at the open of that hour's candle. A fee in another asset, or a price Binance cannot give, makes the strategy unmeasurable, and it opens nothing. A strategy that reached a limit is stopped with `loss_limit` (`lossLimitReached`): paused if it was running, its entries stopped, `loss_limit_reached_at` set, and a critical notification once.
3. Add the result since midnight UTC of every strategy measured, those completed today included. If together they have lost the portfolio's limit, as a percentage of their allocations, every running strategy is paused with `drawdown` (`drawdownReached`), with one critical notification. If any strategy cannot be measured, none opens entries.
4. Plan and place each running strategy's next entries, or ask the AI when its analysis is due (`ai-decisions.ts`: the eve assistant at `STRATEGY_AI_EVE_URL`, or the recorded fixture, whose decisions name the model `recorded-fixture`). Decisions go through `PostgresTradeProposals.record` with the strategy. A proposal waits for the customer unless the version's `proposal_approval` is `automatic`. Each entry's strategy is measured again just before it is reserved, and a limit reached since stops it.

### Customer actions

Pause, close all, resume, new versions and the kill switch are worker routes (`routes/strategies.ts`), each one transaction, audited as `strategy.paused`, `strategy.close_all`, `strategy.resumed`, `strategy.version_created` and `kill_switch.activated`. Resuming is refused while a loss limit or the portfolio's drawdown limit is still reached. The kill switch pauses every strategy with `kill_switch`, requests the exit of every protected entry on the account, strategies' and the customer's own, those still being sent included, cancels pending stop-limit entries, and raises a critical notification.
