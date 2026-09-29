# Crypto trading agent

A simulation-first trading application built with Next.js, eve, shadcn/ui, and PostgreSQL. The current build uses deterministic fixtures and cannot submit real exchange orders.

## What is implemented

- A responsive dashboard for allocations, positions, protection, deadlines, and recent decisions.
- An eve analysis assistant mounted through the Next.js app.
- A typed trade-proposal tool that cannot place orders or change limits.
- Independent execution checks for customer scope, strategy version, instrument access, leverage, protection, expiry, position size, and available allocation.
- Exact decimal arithmetic for quantities and money calculations.
- A PostgreSQL schema for customers, accounts, strategy versions, proposals, reservations, orders, fills, position ownership, deadlines, audit events, and outbox jobs.
- Row-level security policies for customer-owned records.
- A simulation-only execution worker that refuses to start if live trading is enabled.

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
pnpm check
pnpm test
pnpm --filter @crypto-trading/web lint
pnpm build
```

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
