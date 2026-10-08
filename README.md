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
- A local execution service with a Binance Spot Testnet adapter for balances, limit orders, cancellation, order lookup, and recent fills.
- A testnet Overview with balances, open orders, recent fills, and automatic refresh every ten seconds. Accounts lists searchable virtual asset balances. Activity lists exchange fills. Settings shows the current account connection.
- Manual development order commands with a notional cap, Binance filter validation, and an order-intent journal to prevent duplicate submission after restart.

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
4. Run `pnpm exchange check` to verify authenticated connectivity. Then run `pnpm dev:worker` and `pnpm dev` in separate terminals. Open `/accounts` to see virtual balances, open BTC/ETH orders, and recent fills. Restart the processes after changing their environment files.

The worker listens on `127.0.0.1:4001`, and on `[::1]:4001` when IPv6 is available. Its HTTP interface requires the shared token and exposes account reads only. The web app is currently a local development dashboard without customer account authentication; do not expose the connected dashboard publicly. The Overview assistant receives the displayed testnet account snapshot and cannot access exchange credentials or submit orders. The application has no demo account data or invented strategy/decision records. Strategy management and AI decision persistence are not implemented.

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

Balances, quantities, prices, and fees remain decimal strings. The account snapshot is fetched through REST and cached in the worker for at most ten seconds. Overview, Accounts, Activity, and Settings refresh every ten seconds while the tab is visible and offer a manual refresh button. Overview shows the latest ten fills across BTC/USDT and ETH/USDT; Accounts and Activity show the latest fifty. This is an account monitor, not a full trade-history import or automated execution loop.

The [official testnet documentation](https://github.com/binance/binance-spot-api-docs/blob/master/testnet/general-info.md) explains that balances are virtual and the environment resets approximately monthly. API keys survive resets, but orders and balances change. See the [Spot REST API documentation](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) for signing and order semantics.
