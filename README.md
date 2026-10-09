# Crypto trading agent

A Binance Spot Testnet trading application built with Next.js, eve, shadcn/ui, and PostgreSQL. Displayed balances, orders, and fills come from the connected exchange account. Testnet funds are virtual; real-money trading remains disabled.

## What is implemented

- A responsive dashboard for exchange balances, open orders, and recent fills.
- Strategies: grid, DCA, AI-managed (the issue's AI Signal bot) and standing price instruction strategies, each with its own allocation and loss limits, created from forms that show their exact effects before they start. The execution worker runs them, checks every entry, reserves its budget and places it as a protected order list. Each strategy's card shows its status, allocation against current value, unrealized and realized PnL, and Pause, Resume, Edit limits and Close all. A kill switch in the top bar stops everything, and a portfolio daily drawdown limit pauses every strategy. See [Strategies](#strategies).
- Customer sign-in with email and password (Better Auth). Every page, server action and assistant request checks the session on the server, and acts only for the signed-in customer.
- An eve analysis assistant mounted through the Next.js app.
- Assistant tools that draft trade proposals and record decisions not to trade. The execution worker saves them in PostgreSQL with the model, prompt version, input snapshot and rationale. The tools cannot place orders or change limits.
- Customer approval of AI proposals: each proposal card shows its size, risk and reward, with **Approve & submit order** and **Reject**. The worker runs every check again before it places an approved proposal, and places it at most once.
- Independent execution checks for customer scope, strategy version, instrument access, leverage, protection, expiry, position size, and available allocation.
- Exact decimal arithmetic for quantities and money calculations.
- A PostgreSQL schema for customers, accounts, strategy versions, proposals, reservations, orders, fills, position ownership, deadlines, audit events, and outbox jobs, applied by a migration runner that records each migration.
- Row-level security for customer-owned records. The apps connect as a role it applies to and work in one customer's scope at a time. See [the database guide](docs/database.md).
- A local execution service with a Binance Spot Testnet adapter for balances, limit orders, cancellation, order lookup, recent fills, and public market data (24-hour tickers, candles, and order book depth).
- A testnet Overview with net worth and its 24-hour change across your exchange accounts in your reporting currency (USDT unless you choose another), naming any account or holding it could not convert, plus balances, open orders, recent fills, and automatic refresh every ten seconds. Accounts shows holdings valued in the reporting currency with their 24-hour change and each asset's share of the account's value, and can hide zero and dust balances. Activity lists the assistant's decisions, with each proposal's status, outcome and order list, and exchange fills.
- Settings, in three tabs. **Exchange accounts** lists the customer's exchange accounts and adds, renames, tests and removes them, each with its own API keys, which the worker checks with the venue, stores encrypted and never shows again. **Risk limits** sets the per-order cap, a daily risk limit and a default stop loss for orders placed by hand, as versions under platform maximums. **Notifications** lists the worker's in-app alerts and posts them to an optional Discord or Telegram webhook.
- Markets for the default allowed instruments, BTC/USDT and ETH/USDT: a candlestick chart (TradingView Lightweight Charts) marking your recent fills and open orders, the order book, and a market depth chart, refreshed every three seconds while the tab is visible.
- Manual development order commands with a notional cap, Binance filter validation, and order intents saved in PostgreSQL before anything is sent, to prevent duplicate submission after restart.
- Backtesting on Strategies: run a grid, DCA or standing price instruction over up to 30 days of hourly candles, or replay a fixture of recorded AI proposals, with the same planners, execution checks and loss limits as a live strategy. Results show net PnL, fees, maximum drawdown, Sharpe ratio, win and loss rates, trades, an equity curve against buying and holding, and the simulator's limitations. History is read from Binance's public market data and cached on disk. See [Backtesting](docs/backtesting.md).
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
packages/exchanges/   the exchange-neutral venue contract, market catalogue, and Binance adapters: testnet trading, and read-only history
packages/backtest/    deterministic backtest simulator and metrics
packages/database/    PostgreSQL client, migrations and development seed
docs/                 accepted product and architecture decisions
```

Live trading remains locked until the deployment prerequisites in [the implementation brief](docs/implementation-brief.md) are settled and implemented.

## Connect Binance Spot Testnet

1. Sign in at [Binance Spot Testnet](https://testnet.binance.vision/) and register an Ed25519 or RSA public key with account-read and trading permissions. Keep the corresponding private key locally. These API keys are separate from production and Demo Trading keys.
2. Copy `apps/execution/.env.example` to `apps/execution/.env` if it does not already exist. Set `CREDENTIALS_MASTER_KEY` to the output of `openssl rand -base64 32`, and `EXECUTION_API_TOKEN` to a random token, generated with `openssl rand -hex 32`.
3. Copy `apps/web/.env.example` to `apps/web/.env.local`. Copy the same `EXECUTION_API_TOKEN` there. Keep both files private.
4. To let the assistant save its proposals, generate a second token with `openssl rand -hex 32` and set it as `EXECUTION_ASSISTANT_TOKEN` in the repository's `.env`, which both the worker and eve load. It must differ from `EXECUTION_API_TOKEN`. With it the assistant can only record decisions: it cannot read the account or place orders.
5. Run `pnpm dev:worker` and `pnpm dev` in separate terminals. The worker needs the migrated and seeded database from [Run locally](#run-locally); market data works without it. Open **Settings → Exchange accounts**, select **Replace keys** on the Binance Spot Testnet account, enter the API key with its private key (Ed25519 or RSA) or HMAC secret key, save, and select **Test connection**. Then set your **Risk limits**. Open `/` to see virtual balances, open orders and recent fills on the account's markets, and `/accounts` for holdings valued in USDT. Restart the processes after changing their environment files.

The worker seals saved keys with AES-256-GCM under `CREDENTIALS_MASTER_KEY`, binding each to its customer and exchange account. Keys are never sent back to the browser, logged, or given to the assistant: Settings shows the last four characters of the API key and when it changed. Keep the master key with your backups; without it, saved keys cannot be opened, and the worker refuses to use the account rather than fall back to other keys. Changing or removing keys needs a fresh session: if you signed in more than 10 minutes ago, you confirm your password first.

Keys in `apps/execution/.env` still work: `BINANCE_TESTNET_API_KEY`, with `BINANCE_TESTNET_PRIVATE_KEY_PATH` (the absolute path of the private PEM file) or `BINANCE_TESTNET_API_SECRET`. The worker uses them until keys are saved in Settings, and again if the saved keys are removed. `pnpm exchange check` verifies connectivity with whichever keys the worker would use.

The `.env` keys belong to the development customer's exchange account only; every other account uses the keys saved for it. The worker serves every exchange account of every customer on the venues it has an adapter for, each with its own keys, and the dashboard acts on the customer's oldest account that trades. If you placed orders before order intents moved to PostgreSQL, the worker refuses to start while `.testnet-orders/` holds intents: run `pnpm exchange import-journal` once to copy them into the database, then delete the directory.

The worker listens on `127.0.0.1:4001`, and on `[::1]:4001` when IPv6 is available. Its HTTP interface requires the shared token. It serves the account snapshot and market data, places and cancels dashboard orders, and runs the execution loop while it is serving. **The dashboard can place and cancel orders on the connected testnet account, so it must stay on this machine.** It has no customer authentication: never expose it to a network, put it behind a proxy, or reach it through a tunnel. Its order actions refuse requests that are not from `localhost`, `127.0.0.1` or `[::1]`. The Overview assistant receives the displayed testnet account snapshot and cannot access exchange credentials or submit orders. The application has no demo account data or invented strategy/decision records. AI-managed strategies replay a recorded fixture when no model is configured, and label every such decision as one.

### Markets and venues

The worker talks to each exchange through an adapter for its **venue**, such as `binance-spot-testnet`, which declares what it can do: Binance Spot Testnet trades spot with attached exits, on virtual funds, and a read-only venue only reads. Markets are named by instrument, `BASE-QUOTE` such as `BTC-USDT`, whatever the venue calls them; each adapter translates them to its venue symbol (`BTCUSDT` on Binance) and reads each market's tick size, step size, minimum and maximum quantity, minimum notional and status from the venue's market catalogue, refreshed every five minutes. See [ADR 0008](docs/adr/0008-normalize-venues-markets-and-order-ids.md).

An exchange account trades the markets its venue lists that are among its **allowed instruments** and quoted in its accounting currency, USDT here. The allowed instruments start as BTC-USDT and ETH-USDT; a customer widens them in the database for now (see [the database guide](docs/database.md#allowed-instruments)). A strategy, dashboard order or assistant proposal on any other market is refused.

### Dashboard orders

Select **Trade** in the top bar, or in the header on a phone, to place a buy on one of the markets your account trades (see [Markets and venues](#markets-and-venues)). Spot trading is long only, so the dashboard buys and never opens a short. A take profit above the entry and a stop loss below it are required. The drawer previews every pre-execution check as you type. The execution worker runs them again, with fresh account data, before it sends anything:

- account limits from `authorizeTradeProposal`, with a policy built from the worker's configuration;
- your risk limits from **Settings → Risk limits**, read immediately before each order: the per-order cap, and a daily risk limit that refuses an order whose loss at its stop, added to that of the day's earlier manual orders since 00:00 UTC, would go over it;
- Binance's price, quantity and minimum value filters for the entry and both exits, plus Binance's own validation of the entry.

Each order is one Binance order list (OPOCO): a limit buy that, once it fills completely, places a limit-maker take profit and a stop-market stop loss, sized from the quantity received after fees. Either exit cancels the other. Exits are placed only when the entry has filled completely: a partly filled entry's quantity has no exits yet, and the Open orders table flags it.

- **Limit** entries rest on the book until they fill or are cancelled. Binance Spot has no good-till-date orders.
- **Market** entries are fill-or-kill limit buys at the best ask plus `TESTNET_MARKET_MAX_SLIPPAGE_PERCENT`. They fill completely at or below that price, or not at all. A plain market order cannot carry attached exits.
- **Stop-limit** entries are held by the execution worker, not Binance: Binance attaches exits only to limit working orders, and its order lists still accept no stop working order (checked against the Spot API changelog of 2026-09-18). When the market trades at or above the stop price, the worker runs every check again with fresh account data and sends a limit entry at the limit price with its exits, as one order list. The stop price must be above the best ask and the stop loss below the stop price. A held entry reserves its value in the allocation, is listed in Open orders as **Held by the worker**, and can be cancelled there until it triggers. Binance has no record of it until then.

The drawer suggests a stop loss at your default percentage below the entry price, rounded up to the price tick, until you type one.

Dashboard orders stay off until you set your risk limits in Settings, and until these are set in `apps/execution/.env`; they have no defaults:

| Variable                              | Meaning                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `TESTNET_MANUAL_INSTRUMENTS`          | Markets the dashboard may buy, as `BASE-QUOTE`, such as `BTC-USDT,ETH-USDT`. Only those the account also allows are offered |
| `TESTNET_MANUAL_ALLOCATION_USDT`      | Virtual USDT that open entries and the positions their exits protect may hold at once                                       |
| `TESTNET_MARKET_MAX_SLIPPAGE_PERCENT` | Optional, at most 5. Empty turns market orders off                                                                          |

The allocation counts the unfilled value of every open buy, plus the entry value of each position whose exits are still open. Holdings with no open order are outside it.

Each order gets a new `ct_` client ID in the browser. The worker saves the order intent in PostgreSQL before submitting and never submits that ID twice. If the worker cannot confirm an order, the drawer offers **Check order status**, which looks the order up by that ID, instead of letting you resend it. If an entry fills at once, the worker confirms on Binance that both exits are open and reports loudly when they are not. After that, the execution loop watches it.

### The execution loop

The worker checks every exchange account's orders every five seconds, whether or not the dashboard is open ([ADR 0002](docs/adr/0002-run-execution-controls-independently-of-ai.md)), with the keys each account trades with: those saved in Settings, or the worker's `.env` keys for the development account. An account without keys the worker can use is skipped. Accounts are checked side by side, and a venue that is slow, rate limited or out of sync for one account never holds up another ([ADR 0010](docs/adr/0010-serve-every-exchange-account-from-one-worker.md)). While an account's venue cannot serve it, its entries wait and its exits keep trying; you get one alert when that starts and one when it ends. A read-only account, such as on HTX, is only monitored. Each pass:

- settles orders whose outcome was unknown, by looking them up on Binance by client ID once a minute has passed. It never resubmits one;
- sends stop-limit entries whose stop price has traded;
- reconciles each entry with Binance and keeps what Binance reports for it, its orders and fills, in PostgreSQL;
- starts the exit of entries past their holding deadline;
- runs the customer's strategies: measures their loss limits and the portfolio's drawdown, and plans, checks and places their next entries (see [Strategies](#strategies)).

When an entry holds bought quantity that no stop loss protects, the worker treats it as a protection failure ([ADR 0007](docs/adr/0007-hold-stop-limit-triggers-and-sell-unprotected-quantity.md)). This happens when Binance drops or rejects the exits after the entry fills, or when a partly filled entry is cancelled outside the dashboard. The worker cancels whatever is left of the order list, sells the quantity at market, pauses the strategy if the entry has one, and raises a critical alert. A partly filled entry has no exits on Binance, so if its market falls to the stop loss, the worker sells what it bought the same way. It tries three market sells, not counting ones Binance refused only for a rate limit. If none sells the quantity, it stops and asks you to sell it yourself. If you cancel an order list from the dashboard and confirm that what it bought is left without exits, the worker hands that quantity over to you instead of selling it. If more filled before the cancel reached Binance than you confirmed, it sells all of it.

Dashboard orders have no holding deadline. Entries made from a strategy's proposals get one at their first fill, from the strategy version's holding period. When it passes, the worker cancels the entry's orders and sells what it holds. If Binance refuses that sale, the quantity has no stop loss, so it is a protection failure too. If the entry still holds anything a minute after the deadline, the exit is overdue and raises a critical alert.

The Overview shows each order whose bought quantity needs attention in red at the top, and the Open orders table lists them above the orders. The **Alerts** card lists the week's latest notifications and when the loop last checked your orders. Two workers can run at once without selling, sending or alerting twice. [The database guide](docs/database.md#the-execution-loop) has the details.

Binance cancels every order in a list together, so cancelling any leg cancels the entry and both exits. The confirmation dialog lists what will be cancelled. If the entry has already bought anything, it names the quantity that will be left without exits and needs a second, explicit confirmation.

### Risk limits and alerts

**Settings → Risk limits** keeps each change as a new version, audited, and never edits an earlier one. A change applies to orders placed after it; open orders keep the limits they were placed under. The platform maximums are 1,000 USDT for the per-order cap and for the daily risk limit, and a default stop loss from 0.1% to 50% below the entry. The daily risk limit counts each dashboard entry's loss if its stop fills at its price, and each CLI buy, which has no stop, at its full value. A stop-market exit can fill lower and fees are extra, so it is not a guaranteed maximum. Reaching it refuses new orders and nothing more: unlike a strategy's loss limit, it measures no realized or unrealized results and pauses nothing. A held stop-limit entry counts its risk while it waits, and when its stop trades it meets the latest per-order cap and daily risk limit, counting its own risk once, or is rejected unsent. Exits are never held back by any of these limits: the sells the execution loop sends to protect or close a position, and CLI sells, are not checked against them. Strategies' entries do not count against these limits: each strategy has its own allocation and loss limits.

The same tab sets the **maximum daily drawdown** of your strategies together on the exchange account, as a percentage of their allocations, from 0.1% to 100%, also kept as versions. Strategies start only once it is set. When their combined result since midnight UTC reaches it, the worker pauses every strategy and cancels their pending entries; open entries keep their exits.

**Settings → Notifications** lists the in-app alerts the execution worker raises, newest first. An optional Discord webhook URL, or a Telegram `https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat ID>` URL, receives each new alert: the worker queues one outbox job per alert, posts it from the execution loop, and retries failed posts with backoff, from 30 seconds up to 15 minutes, for eight attempts. **Send test** posts straight away. The URL holds a token, so it is stored encrypted like exchange keys and never logged.

### AI proposals

The analysis assistant on the Overview drafts a trade with `draft_trade_proposal`, or records a decision not to trade with `record_no_trade_decision`. Both act only for the signed-in customer who started the conversation. Its tools send each decision to the execution worker, which checks it and saves it for that customer with the model, prompt version, the ID of the account snapshot it was based on, and the rationale. The assistant has its own worker token, which records decisions and does nothing else. It never reaches the database or Binance.

The assistant sees each of your exchange accounts labelled with its venue and account, with its own snapshot and snapshot ID, and it says which account each fact comes from. Exchange accounts are isolated ([ADR 0009](docs/adr/0009-keep-exchange-accounts-isolated-across-venues.md)): a proposal names the one account it trades on (`exchangeAccountId`), and the worker saves it only if you own that account, it can trade (never a read-only account, such as HTX), the worker serves it, and that account's own free balance pays for the entry. Capital on another account never does.

A proposal is a long spot limit buy, on a market the account trades, with a stop loss, a take profit and an entry expiry. Its card in the conversation, and its row on Activity, show the entry, the size in USDT, each exit's distance from the entry, and the risk to reward. Proposals drafted in conversation belong to no strategy. The customer approves each one like their own dashboard order:

- **Approve & submit order** runs every dashboard check again with fresh account data and the latest risk limits: `authorizeTradeProposal` on the proposal as saved, under the manual allocation and instruments, then the per-order cap, the daily risk limit, Binance's filters, the free balance and Binance's own test. If they pass, the worker approves the proposal and saves its order intent in one transaction, then places it as an OPOCO order list, like a dashboard order, with the same journal and no-retry rules. The execution loop then watches it like any dashboard entry, and sells quantity no stop loss protects. If a check fails, the proposal is rejected with the reason and nothing is sent.
- A proposal is approved at most once. The approval only applies to a draft, in the database, and its order list's client ID comes from the proposal, so a double click, a second tab or a second worker cannot send it twice.
- A proposal can no longer be approved after its entry expiry. Binance Spot has no good-till-date orders, so an approved entry rests until it fills or is cancelled, like a dashboard limit order.
- **Reject** asks for an optional reason and saves it.

Activity shows each proposal as draft, approved, rejected, submitted, filled, cancelled or expired. Approved means Binance has not confirmed the order yet. Submitted, filled and cancelled follow the execution loop's reconciliation of the entry, with its detail line.

### Strategies

**Strategies** lists every strategy on the account, newest first, and lets you start one. Each kind follows [ADR 0004](docs/adr/0004-hold-several-protected-entries-per-strategy.md):

- **Grid**: limit buys at the levels of a price range below the market, nearest first, each taking profit at the level above and stopped by the range stop. Leaving the range closes everything and completes it.
- **DCA**: a buy of a fixed amount at the best ask on a schedule, with an optional dip multiplier. A buy that cannot be made while it is due is skipped.
- **AI-managed** (the AI Signal bot): on its schedule, the worker asks the AI for one proposal or a decision not to trade, and records it on Activity. By default you approve each proposal there; you can choose instead to let the worker place each one that passes the strategy's limits. With no model configured, the worker replays a recorded fixture, `apps/execution/src/recorded-decisions.json`, and every decision it records says so. Set `STRATEGY_AI_EVE_URL` in `apps/execution/.env` to a local eve dev server (`pnpm dev:agent`) with a model configured to ask the analysis assistant instead.
- **Standing price instruction**: up to ten limit buys at your prices, each with your stop loss and take profit, expiring together.

A strategy needs the portfolio's daily drawdown limit first, in **Settings → Risk limits**. Fill in the form, then **Review effects**: it lists what the strategy can commit, how many entries it can hold, its loss limits and holding period, and every entry it can make with its exact price, size, take profit and stop loss, rounded to Binance's steps as the worker will place it. **Start strategy** sends exactly that. **Backtest these rules** hands the form's rules to the backtest below.

On every pass, every five seconds, the worker:

- measures each strategy's daily loss since midnight UTC and its total loss, counting realized results, fees and the unrealized results of open entries. Reaching either limit cancels its pending entries, sells its open entries at market and pauses it, with a critical alert. It stays paused until you resume it, which it refuses while a limit is still reached: the total limit until a new version raises it, the daily one until midnight UTC or a new version. A strategy the worker cannot measure, such as one charged fees in BNB, opens no entries;
- adds every strategy's result on the exchange account since midnight UTC and pauses every strategy there once together they have lost the account's daily drawdown limit, as a percentage of their allocations. With more than one trading account, or a reporting currency other than the account's, the page also shows your strategies on all accounts together in the reporting currency; that total pauses nothing;
- plans each running strategy's next entries, checks each with Binance's filters and test order and with `authorizeTradeProposal` against the strategy's version, allocation, reserved budget and limits, reserves its budget in the same transaction that saves its order intent, then places it as an OPOCO order list exactly as a dashboard order is placed. The execution loop then watches it like any other entry, with the strategy's holding period;
- cancels entries that pass their entry expiry unfilled, and completes a strategy whose rules open no more entries once it holds nothing.

Binance lets an account hold five open stop orders on a symbol (`MAX_NUM_ALGO_ORDERS`), and every entry's stop loss is one, together with your dashboard orders there. A strategy waits rather than open an entry it could not protect. One strategy owns a market's position on the account: another strategy in that market waits until it holds nothing there. A strategy belongs to one exchange account for its whole life, and its allocation and loss limits are in that account's accounting currency. The same market on another account is a separate position, owned by its own strategy and never netted against this one.

Each card shows the strategy's status (**Running**, **Paused** or **Completed**), its allocation against its current value, its unrealized PnL and its realized PnL after fees, its loss limits, its entries and what the worker last did. **Pause** stops new entries and cancels pending ones; open entries keep their take profit, stop loss and holding deadline. **Close all** also sells what the open entries hold. **Edit limits** saves a new version: open entries keep the version they were made under. A completed strategy offers **New version**, which runs it again, as a grid does to trade a new range. Strategies' entries count against their own allocations, not the dashboard's, and their order list IDs start with `ct_sg`.

The **Kill switch** in the top bar, behind a confirmation, pauses every strategy, cancels every entry the worker manages, strategies' and your own dashboard orders, sells what they hold at market, and cancels stop-limit entries the worker holds. Orders placed with the CLI are left alone. It is audited and raises a critical alert.

### Manual test orders

These commands are for developer-controlled limit orders on virtual funds. They do not activate automated strategies or attach stop-loss/take-profit protection, and the execution loop does not watch them.

They use the per-order cap and daily risk limit from **Settings → Risk limits**, which the worker reads before each order. `TESTNET_MAX_ORDER_NOTIONAL_USDT` is no longer read. A CLI buy has no stop loss, so all of its value counts against the daily risk limit; a sell is never refused for it. Use a current testnet price and a quantity meeting Binance's filters; the numbers below only illustrate the command syntax.

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

Balances, quantities, prices, and fees remain decimal strings. The account snapshot is fetched through REST and cached in the worker for at most ten seconds. Market data is cached for at most five seconds (tickers and candles) or one second (order book depth). Overview, Accounts, Activity, and Settings refresh every ten seconds while the tab is visible and offer a manual refresh button. Overview shows the latest ten fills across the account's markets; Activity shows the latest fifty. Net worth and holding values use each account's own venue's 24-hour tickers: available plus locked balances at last prices, converted into the reporting currency through one market between the two currencies, in either direction, or else two markets through USDT, then USDC ([ADR 0009](docs/adr/0009-keep-exchange-accounts-isolated-across-venues.md)). No currency counts as another, stablecoins included. A route uses the first markets the venue lists. An asset without such a route, whose market has no price, or whose market last traded more than 60 seconds ago, is listed as left out with the reason, never counted as zero, and the total says it is incomplete. Every account the worker serves is read and counted, each with its own snapshot; one it does not serve, or whose venue cannot serve it now, is named and left out of the total. The reporting currency only changes what the dashboard shows: allocations and limits stay in each account's accounting currency. Balances and fills are a monitor, not a full trade-history import.

The [official testnet documentation](https://github.com/binance/binance-spot-api-docs/blob/master/testnet/general-info.md) explains that balances are virtual and the environment resets approximately monthly. API keys survive resets, but orders and balances change. See the [Spot REST API documentation](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) for signing and order semantics.
