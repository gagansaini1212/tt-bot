# Crypto trading agent

A Binance Spot Testnet trading application built with Next.js, eve, shadcn/ui, and PostgreSQL. Displayed balances, orders, and fills come from the connected exchange account. Testnet funds are virtual; real-money trading remains disabled.

## What is implemented

- A responsive dashboard for exchange balances, open orders, and recent fills. Unimplemented strategy management and AI decision persistence are shown explicitly.
- Customer sign-in with email and password (Better Auth). Every page, server action and assistant request checks the session on the server, and acts only for the signed-in customer.
- An eve analysis assistant mounted through the Next.js app.
- A typed trade-proposal tool that cannot place orders or change limits.
- Independent execution checks for customer scope, strategy version, instrument access, leverage, protection, expiry, position size, and available allocation.
- Exact decimal arithmetic for quantities and money calculations.
- A PostgreSQL schema for customers, accounts, strategy versions, proposals, reservations, orders, fills, position ownership, deadlines, audit events, and outbox jobs, applied by a migration runner that records each migration.
- Row-level security for customer-owned records. The apps connect as a role it applies to and work in one customer's scope at a time. See [the database guide](docs/database.md).
- A local execution service with a Binance Spot Testnet adapter for balances, limit orders, cancellation, order lookup, recent fills, and public market data (24-hour tickers, candles, and order book depth).
- A testnet Overview with net worth and its 24-hour change in USDT, balances, open orders, recent fills, and automatic refresh every ten seconds. Accounts shows holdings valued in USDT with their 24-hour change and each asset's share of net worth, and can hide zero and dust balances. Activity lists exchange fills. Settings shows the current account connection.
- Markets for BTC/USDT and ETH/USDT: a candlestick chart (TradingView Lightweight Charts) marking your recent fills and open orders, the order book, and a market depth chart, refreshed every three seconds while the tab is visible.
- Manual development order commands with a notional cap, Binance filter validation, and order intents saved in PostgreSQL before anything is sent, to prevent duplicate submission after restart.
- Testnet order placement from the dashboard: limit, market and stop-limit buys with a required take profit and stop loss that Binance attaches to the entry, a pre-execution check preview, and a confirmed Cancel button on every open order.
- An execution loop in the worker that reconciles every protected entry with Binance, records its orders and fills, sells any bought quantity left without a stop loss, enforces holding deadlines, sends stop-limit entries when their stop price trades, and raises in-app notifications. See [the execution loop](#the-execution-loop).

## Requirements

- Node.js 24 or newer
- pnpm 10
- Docker with Compose

## Run locally

Install packages and start PostgreSQL:

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` creates the development customer, their Binance Spot Testnet exchange account, their login, and the login role `DATABASE_URL` names. Both commands are safe to run again. [The database guide](docs/database.md) explains the roles, migrations, sign-in and customer scoping.

Start the web app and eve agent together:

```bash
pnpm dev
```

Next.js prints the local URL. It uses another available port if port 3000 is busy. Sign in as `dev@example.com` with the password `development-password`; the sign-in page repeats this during development. The web app reads `DATABASE_URL` and `AUTH_SECRET` from `.env`. There is no sign-up: other logins are created in the database, as the seed creates this one.

The assistant needs a model connection before it can answer. Run `pnpm dev:agent` and use eve's `/login` flow to configure one for local development.

## Verify

```bash
pnpm format:check
pnpm check
pnpm test
pnpm --filter @crypto-trading/web lint
pnpm build
```

The database tests skip unless `TEST_DATABASE_URL` names a PostgreSQL superuser. They create and drop their own databases, so the Compose database works:

```bash
TEST_DATABASE_URL=postgresql://trading:trading@localhost:5432/postgres pnpm test
```

CI runs the same checks on pull requests and pushes to `main`, with PostgreSQL for the database tests.

## Repository layout

```text
agent/                eve instructions, channel, and proposal tool
apps/web/             Next.js dashboard
apps/execution/       independent execution worker
packages/domain/      trading rules and exact arithmetic
packages/database/    PostgreSQL client, migrations and development seed
docs/                 accepted product and architecture decisions
```

Live trading remains locked until the deployment prerequisites in [the implementation brief](docs/implementation-brief.md) are settled and implemented.

## Connect Binance Spot Testnet

1. Sign in at [Binance Spot Testnet](https://testnet.binance.vision/) and register an Ed25519 or RSA public key with account-read and trading permissions. Keep the corresponding private key locally. These API keys are separate from production and Demo Trading keys.
2. Copy `apps/execution/.env.example` to `apps/execution/.env` if it does not already exist. Set `BINANCE_TESTNET_API_KEY` to the API key Binance issues and `BINANCE_TESTNET_PRIVATE_KEY_PATH` to the absolute path of the private PEM file. Leave `BINANCE_TESTNET_API_SECRET` empty. For an existing HMAC API key, set its secret instead of a private-key path. Set `EXECUTION_API_TOKEN` to a random token, generated with `openssl rand -hex 32`.
3. Copy `apps/web/.env.example` to `apps/web/.env.local`. Copy the same `EXECUTION_API_TOKEN` there. Binance credentials belong only in `apps/execution/.env`, which the execution service loads. Keep both files private.
4. Run `pnpm exchange check` to verify authenticated connectivity. Then run `pnpm dev:worker` and `pnpm dev` in separate terminals. The worker needs the migrated and seeded database from [Run locally](#run-locally); market data works without it. Open `/` to see virtual balances, open BTC/ETH orders, and recent fills, and `/accounts` for holdings valued in USDT. Restart the processes after changing their environment files.

The credentials belong to the development customer's exchange account, so the worker serves account data and orders only for that customer. If you placed orders before order intents moved to PostgreSQL, the worker refuses to start while `.testnet-orders/` holds intents: run `pnpm exchange import-journal` once to copy them into the database, then delete the directory.

The worker listens on `127.0.0.1:4001`, and on `[::1]:4001` when IPv6 is available. Its HTTP interface requires the shared token. It serves the account snapshot and market data, places and cancels dashboard orders, and runs the execution loop while it is serving. **The dashboard can place and cancel orders on the connected testnet account, so it must stay on this machine.** It has no customer authentication: never expose it to a network, put it behind a proxy, or reach it through a tunnel. Its order actions refuse requests that are not from `localhost`, `127.0.0.1` or `[::1]`. The Overview assistant receives the displayed testnet account snapshot and cannot access exchange credentials or submit orders. The application has no demo account data or invented strategy/decision records. Strategy management and AI decision persistence are not implemented.

### Dashboard orders

Select **Trade** in the top bar, or in the header on a phone, to place a buy on BTC/USDT or ETH/USDT. Spot trading is long only, so the dashboard buys and never opens a short. A take profit above the entry and a stop loss below it are required. The drawer previews every pre-execution check as you type. The execution worker runs them again, with fresh account data, before it sends anything:

- account limits from `authorizeTradeProposal`, with a policy built from the worker's configuration;
- the per-order cap, `TESTNET_MAX_ORDER_NOTIONAL_USDT`;
- Binance's price, quantity and minimum value filters for the entry and both exits, plus Binance's own validation of the entry.

Each order is one Binance order list (OPOCO): a limit buy that, once it fills completely, places a limit-maker take profit and a stop-market stop loss, sized from the quantity received after fees. Either exit cancels the other. Exits are placed only when the entry has filled completely: a partly filled entry's quantity has no exits yet, and the Open orders table flags it.

- **Limit** entries rest on the book until they fill or are cancelled. Binance Spot has no good-till-date orders.
- **Market** entries are fill-or-kill limit buys at the best ask plus `TESTNET_MARKET_MAX_SLIPPAGE_PERCENT`. They fill completely at or below that price, or not at all. A plain market order cannot carry attached exits.
- **Stop-limit** entries are held by the execution worker, not Binance: Binance attaches exits only to limit working orders, and its order lists still accept no stop working order (checked against the Spot API changelog of 2026-09-18). When the market trades at or above the stop price, the worker runs every check again with fresh account data and sends a limit entry at the limit price with its exits, as one order list. The stop price must be above the best ask and the stop loss below the stop price. A held entry reserves its value in the allocation, is listed in Open orders as **Held by the worker**, and can be cancelled there until it triggers. Binance has no record of it until then.

Dashboard orders stay off until these are set in `apps/execution/.env`; they have no defaults:

| Variable                              | Meaning                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `TESTNET_MANUAL_INSTRUMENTS`          | `BTC-USDT`, `ETH-USDT` or both                                                        |
| `TESTNET_MANUAL_ALLOCATION_USDT`      | Virtual USDT that open entries and the positions their exits protect may hold at once |
| `TESTNET_MAX_ORDER_NOTIONAL_USDT`     | Per-order cap, also the largest position                                              |
| `TESTNET_MARKET_MAX_SLIPPAGE_PERCENT` | Optional, at most 5. Empty turns market orders off                                    |

The allocation counts the unfilled value of every open buy, plus the entry value of each position whose exits are still open. Holdings with no open order are outside it.

Each order gets a new `ct_` client ID in the browser. The worker saves the order intent in PostgreSQL before submitting and never submits that ID twice. If the worker cannot confirm an order, the drawer offers **Check order status**, which looks the order up by that ID, instead of letting you resend it. If an entry fills at once, the worker confirms on Binance that both exits are open and reports loudly when they are not. After that, the execution loop watches it.

### The execution loop

The worker checks every customer's orders every five seconds, whether or not the dashboard is open ([ADR 0002](docs/adr/0002-run-execution-controls-independently-of-ai.md)). Each pass:

- settles orders whose outcome was unknown, by looking them up on Binance by client ID once a minute has passed. It never resubmits one;
- sends stop-limit entries whose stop price has traded;
- reconciles each entry with Binance and keeps what Binance reports for it, its orders and fills, in PostgreSQL;
- starts the exit of entries past their holding deadline.

When an entry holds bought quantity that no stop loss protects, the worker treats it as a protection failure ([ADR 0006](docs/adr/0006-hold-stop-limit-triggers-and-sell-unprotected-quantity.md)). This happens when Binance drops or rejects the exits after the entry fills, or when a partly filled entry is cancelled outside the dashboard. The worker cancels whatever is left of the order list, sells the quantity at market, pauses the strategy if the entry has one, and raises a critical alert. A partly filled entry has no exits on Binance, so if its market falls to the stop loss, the worker sells what it bought the same way. It tries three market sells, not counting ones Binance refused only for a rate limit. If none sells the quantity, it stops and asks you to sell it yourself. If you cancel an order list from the dashboard and confirm that what it bought is left without exits, the worker hands that quantity over to you instead of selling it. If more filled before the cancel reached Binance than you confirmed, it sells all of it.

Dashboard orders have no holding deadline. Entries made from a strategy's proposals get one at their first fill, from the strategy version's holding period. When it passes, the worker cancels the entry's orders and sells what it holds. If Binance refuses that sale, the quantity has no stop loss, so it is a protection failure too. If the entry still holds anything a minute after the deadline, the exit is overdue and raises a critical alert.

The Overview shows each order whose bought quantity needs attention in red at the top, and the Open orders table lists them above the orders. The **Alerts** card lists the week's latest notifications and when the loop last checked your orders. Two workers can run at once without selling, sending or alerting twice. [The database guide](docs/database.md#the-execution-loop) has the details.

Binance cancels every order in a list together, so cancelling any leg cancels the entry and both exits. The confirmation dialog lists what will be cancelled. If the entry has already bought anything, it names the quantity that will be left without exits and needs a second, explicit confirmation.

### Manual test orders

These commands are for developer-controlled limit orders on virtual funds. They do not activate automated strategies or attach stop-loss/take-profit protection, and the execution loop does not watch them. Automatic proposal execution still requires persisted reservations.

Set `TESTNET_MAX_ORDER_NOTIONAL_USDT` to your per-order development cap. The example configuration uses 100 virtual USDT. Use a current testnet price and a quantity meeting Binance's filters; the numbers below only illustrate the command syntax.

```bash
pnpm exchange balances
pnpm exchange test-order BTC-USDT BUY 0.001 60000 ct_dev_001
pnpm exchange place-order BTC-USDT BUY 0.001 60000 ct_dev_001
pnpm exchange order BTC-USDT ct_dev_001
pnpm exchange cancel BTC-USDT ct_dev_001
pnpm exchange orders
pnpm exchange fills
```

`test-order` validates with Binance without creating an order. `place-order` validates first, saves the order intent in PostgreSQL for the development customer, then submits once. Use a unique `ct_` client ID for each new order; an ID the dashboard or CLI used before is refused. A timeout or server error can mean Binance accepted the order; query that same client ID before taking further action. Commands never automatically retry an order submission. Canceling does not reverse fills.

Balances, quantities, prices, and fees remain decimal strings. The account snapshot is fetched through REST and cached in the worker for at most ten seconds. Market data is cached for at most five seconds (tickers and candles) or one second (order book depth). Overview, Accounts, Activity, and Settings refresh every ten seconds while the tab is visible and offer a manual refresh button. Overview shows the latest ten fills across BTC/USDT and ETH/USDT; Activity shows the latest fifty. Net worth and holding values use the 24-hour tickers: available plus locked balances at last prices, with USDT counted as 1 and assets without a USDT market priced through the inverse market or BTC, ETH or BNB. Assets with no price are listed as left out, never counted as zero. Balances and fills are a monitor, not a full trade-history import.

The [official testnet documentation](https://github.com/binance/binance-spot-api-docs/blob/master/testnet/general-info.md) explains that balances are virtual and the environment resets approximately monthly. API keys survive resets, but orders and balances change. See the [Spot REST API documentation](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) for signing and order semantics.
