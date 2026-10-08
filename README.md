# Crypto trading agent

A Binance Spot Testnet trading application built with Next.js, eve, shadcn/ui, and PostgreSQL. Displayed balances, orders, and fills come from the connected exchange account. Testnet funds are virtual; real-money trading remains disabled.

## What is implemented

- A responsive dashboard for exchange balances, open orders, and recent fills. Unimplemented strategy management and AI decision persistence are shown explicitly.
- An eve analysis assistant mounted through the Next.js app.
- A typed trade-proposal tool that cannot place orders or change limits.
- Independent execution checks for customer scope, strategy version, instrument access, leverage, protection, expiry, position size, and available allocation.
- Exact decimal arithmetic for quantities and money calculations.
- A PostgreSQL schema for customers, accounts, strategy versions, proposals, reservations, orders, fills, position ownership, deadlines, audit events, and outbox jobs.
- Row-level security policies for customer-owned records.
- A local execution service with a Binance Spot Testnet adapter for balances, limit orders, cancellation, order lookup, recent fills, and public market data (24-hour tickers, candles, and order book depth).
- A testnet Overview with net worth and its 24-hour change in USDT, balances, open orders, recent fills, and automatic refresh every ten seconds. Accounts shows holdings valued in USDT with their allocation and 24-hour change, and can hide zero and dust balances. Activity lists exchange fills. Settings shows the current account connection.
- Manual development order commands with a notional cap, Binance filter validation, and an order-intent journal to prevent duplicate submission after restart.
- Testnet order placement from the dashboard: limit and market buys with a required take profit and stop loss that Binance attaches to the entry, a pre-execution check preview, and a confirmed Cancel button on every open order.

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
```

Start the web app and eve agent together:

```bash
pnpm dev
```

Next.js prints the local URL. It uses another available port if port 3000 is busy.

The assistant needs a model connection before it can answer. Run `pnpm dev:agent` and use eve's `/login` flow to configure one for local development.

## Verify

```bash
pnpm format:check
pnpm check
pnpm test
pnpm --filter @crypto-trading/web lint
pnpm build
```

CI runs the same checks on pull requests and pushes to `main`.

## Repository layout

```text
agent/                eve instructions, channel, and proposal tool
apps/web/             Next.js dashboard
apps/execution/       independent execution worker
packages/domain/      trading rules and exact arithmetic
packages/database/    PostgreSQL client and migrations
docs/                 accepted product and architecture decisions
```

Live trading remains locked until the deployment prerequisites in [the implementation brief](docs/implementation-brief.md) are settled and implemented.

## Connect Binance Spot Testnet

1. Sign in at [Binance Spot Testnet](https://testnet.binance.vision/) and register an Ed25519 or RSA public key with account-read and trading permissions. Keep the corresponding private key locally. These API keys are separate from production and Demo Trading keys.
2. Copy `apps/execution/.env.example` to `apps/execution/.env` if it does not already exist. Set `BINANCE_TESTNET_API_KEY` to the API key Binance issues and `BINANCE_TESTNET_PRIVATE_KEY_PATH` to the absolute path of the private PEM file. Leave `BINANCE_TESTNET_API_SECRET` empty. For an existing HMAC API key, set its secret instead of a private-key path. Set `EXECUTION_API_TOKEN` to a random token, generated with `openssl rand -hex 32`.
3. Copy `apps/web/.env.example` to `apps/web/.env.local`. Copy the same `EXECUTION_API_TOKEN` there. Binance credentials belong only in `apps/execution/.env`, which the execution service loads. Keep both files private.
4. Run `pnpm exchange check` to verify authenticated connectivity. Then run `pnpm dev:worker` and `pnpm dev` in separate terminals. Open `/` to see virtual balances, open BTC/ETH orders, and recent fills, and `/accounts` for holdings valued in USDT. Restart the processes after changing their environment files.

The worker listens on `127.0.0.1:4001`, and on `[::1]:4001` when IPv6 is available. Its HTTP interface requires the shared token. It serves the account snapshot and market data, and places and cancels dashboard orders. **The dashboard can place and cancel orders on the connected testnet account, so it must stay on this machine.** It has no customer authentication: never expose it to a network, put it behind a proxy, or reach it through a tunnel. Its order actions refuse requests that are not from `localhost`, `127.0.0.1` or `[::1]`. The Overview assistant receives the displayed testnet account snapshot and cannot access exchange credentials or submit orders. The application has no demo account data or invented strategy/decision records. Strategy management and AI decision persistence are not implemented.

### Dashboard orders

Select **Trade** in the top bar, or in the header on a phone, to place a buy on BTC/USDT or ETH/USDT. Spot trading is long only, so the dashboard buys and never opens a short. A take profit above the entry and a stop loss below it are required. The drawer previews every pre-execution check as you type. The execution worker runs them again, with fresh account data, before it sends anything:

- account limits from `authorizeTradeProposal`, with a policy built from the worker's configuration;
- the per-order cap, `TESTNET_MAX_ORDER_NOTIONAL_USDT`;
- Binance's price, quantity and minimum value filters for the entry and both exits, plus Binance's own validation of the entry.

Each order is one Binance order list (OPOCO): a limit buy that, once it fills completely, places a limit-maker take profit and a stop-market stop loss, sized from the quantity received after fees. Either exit cancels the other. Exits are placed only when the entry has filled completely: a partly filled entry's quantity has no exits yet, and the Open orders table flags it.

- **Limit** entries rest on the book until they fill or are cancelled. Binance Spot has no good-till-date orders.
- **Market** entries are fill-or-kill limit buys at the best ask plus `TESTNET_MARKET_MAX_SLIPPAGE_PERCENT`. They fill completely at or below that price, or not at all. A plain market order cannot carry attached exits.
- **Stop-limit** entries are not offered. Binance attaches exits only to limit entries, so a filled stop-limit buy would have none until something else placed them.

Dashboard orders stay off until these are set in `apps/execution/.env`; they have no defaults:

| Variable                              | Meaning                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `TESTNET_MANUAL_INSTRUMENTS`          | `BTC-USDT`, `ETH-USDT` or both                                                        |
| `TESTNET_MANUAL_ALLOCATION_USDT`      | Virtual USDT that open entries and the positions their exits protect may hold at once |
| `TESTNET_MAX_ORDER_NOTIONAL_USDT`     | Per-order cap, also the largest position                                              |
| `TESTNET_MARKET_MAX_SLIPPAGE_PERCENT` | Optional, at most 5. Empty turns market orders off                                    |

The allocation counts the unfilled value of every open buy, plus the entry value of each position whose exits are still open. Holdings with no open order are outside it.

Each order gets a new `ct_` client ID in the browser. The worker records it in `.testnet-orders/` before submitting and never submits it twice. If the worker cannot confirm an order, the drawer offers **Check order status**, which looks the order up by that ID, instead of letting you resend it. If an entry fills at once, the worker confirms on Binance that both exits are open and reports loudly when they are not.

Binance cancels every order in a list together, so cancelling any leg cancels the entry and both exits. The confirmation dialog lists what will be cancelled. If the entry has already bought anything, it names the quantity that will be left without exits and needs a second, explicit confirmation.

### Manual test orders

These commands are for developer-controlled limit orders on virtual funds. They do not activate automated strategies or attach stop-loss/take-profit protection. Automatic proposal execution still requires persisted reservations, position ownership, protection, deadlines, and reconciliation.

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

`test-order` validates with Binance without creating an order. `place-order` validates first, writes intent to `.testnet-orders/`, then submits once. Use a unique `ct_` client ID for each new order. Preserve the journal across restarts. A timeout or server error can mean Binance accepted the order; query that same client ID before taking further action. Commands never automatically retry an order submission. Canceling does not reverse fills.

Balances, quantities, prices, and fees remain decimal strings. The account snapshot is fetched through REST and cached in the worker for at most ten seconds. Market data is cached for at most five seconds (tickers and candles) or one second (order book depth). Overview, Accounts, Activity, and Settings refresh every ten seconds while the tab is visible and offer a manual refresh button. Overview shows the latest ten fills across BTC/USDT and ETH/USDT; Activity shows the latest fifty. Net worth and holding values use the 24-hour tickers: available plus locked balances at last prices, with USDT counted as 1 and assets without a USDT market priced through the inverse market or BTC, ETH or BNB. Assets with no price are listed as left out, never counted as zero. This is an account monitor, not a full trade-history import or automated execution loop.

The [official testnet documentation](https://github.com/binance/binance-spot-api-docs/blob/master/testnet/general-info.md) explains that balances are virtual and the environment resets approximately monthly. API keys survive resets, but orders and balances change. See the [Spot REST API documentation](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) for signing and order semantics.
