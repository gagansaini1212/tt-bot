# Local architecture proposal

Status: accepted in interview Q43. Implementation follows the final shared-understanding checkpoint. Deployment, purchases, and real orders are outside the current local build scope.

## Components

Use a TypeScript repository with a Next.js web dashboard, an eve agent service, a separate execution worker, and PostgreSQL. Run the services locally, with PostgreSQL in a container. Exercise ten simulated customers; do not treat this as a measured production capacity.

The web app authenticates customers, displays positions and decisions, and submits explicit configuration commands. Use Better Auth with server-side session checks and fresh authentication for credentials and live activation. Enforce customer ownership on every API, stream, session, job, and database query; authentication alone is insufficient.

eve handles conversation, source-backed market/news analysis, and typed trade proposals. It receives customer-scoped data and opaque account references, never exchange secrets. Disable general-purpose shell, arbitrary network tools, and self-modification in the trading agent. External news is untrusted data and cannot grant tool authority.

The execution worker owns credentials, order authorization, budget reservation, exchange submission, reconciliation, protection, and deadlines. It rechecks current limits and strategy versions immediately before submission. AI can submit a proposal but cannot directly submit an exchange order or edit executable rules.

PostgreSQL stores customers, account metadata, versioned policies, allocations, reservations, proposals, orders, fills, position ownership, deadlines, valuation snapshots, and audit events. Use exact decimal arithmetic for money and exchange quantities. Reserve budget transactionally, and use an outbox plus durable work records to recover pending operations after a restart. Do not hold database locks while waiting on exchange HTTP responses.

## Execution flow

1. Ingest timestamped market data and approved news; preserve source and observation times.
2. A scheduled or event-triggered eve run proposes a trade or no trade, referencing a strategy version and input snapshot.
3. The worker checks ownership, eligibility, instrument capability, freshness, limits, deadline, available funds, and protective exits.
4. Atomically reserve budget and persist an order intent with a stable identifier.
5. Submit through an exchange adapter. Treat uncertain responses as unknown outcomes, not rejected orders.
6. Reconcile orders and fills; protect each filled amount and enforce deadlines independently of AI.
7. Record decisions and execution results, and enqueue customer notifications.

An order identifier is not a claim of exactly-once exchange execution. Reconciliation and exchange-specific identifier rules are required to prevent blind retries.

## Exchange adapters and simulation

Implement a shared contract for mock and Binance spot/perpetual adapters, with explicit capabilities rather than pretending all order types behave alike. Instrument precision, minimum order sizes, protection semantics, position mode, margin mode, and API errors belong to the adapter.

The mock exchange supports a virtual clock, historical replay, live-data paper trading, partial fills, fees, spread, slippage, funding, liquidation, disconnects, and ambiguous acknowledgments. Reuse the execution policies in every mode. Historical news must be available at the simulated decision time; do not backtest against later news or revised data. Clearly label model training-data leakage and incomplete historical execution data as evaluation limitations.

Keep simulated credentials, balances, instrument settings, and limits separate from live settings. Live activation remains disabled until the deployment decisions in the interview notes are resolved.

## AI and data providers

Put market data, news, and model calls behind typed provider interfaces. Use deterministic recorded model/news fixtures by default for local verification, with an explicitly configured real model for interactive evaluation. Record model identifier, prompt/policy version, input sources, and structured decision rationale; do not depend on hidden model reasoning.

The initial model and paid news provider remain subject to quality, latency, licensing, and approved cost constraints. Scheduling must deduplicate shared market/news work and limit event bursts. Exhausting an AI budget stops new analysis, not protective execution.

## Verification

Exercise tenant isolation, concurrent budget reservations, duplicate jobs, restart recovery, ambiguous submissions, partial fills, rejected stops, stale data, overdue exits, manual exchange changes, daily boundaries, fees/funding, and liquidation. Compare recorded balances and positions against adapter state after every recovery scenario. Test the full dashboard/chat/configuration flow with simulated accounts.

Strategy evaluation must include held-out periods, costs, drawdown, and a no-trade/baseline comparison. Passing operational checks does not establish strategy profitability. Exact live promotion criteria require a separate accepted policy.

## Sources and technical constraints

- eve 0.68.0 bundled docs, inspected from a temporary package extraction at `/tmp/crypto-eve-docs.wAD8Qb/package/docs/`: `README.md`, `tools/overview.mdx`, `guides/auth-and-route-protection.md`, and `guides/deployment/overview.md`. The package requires Node.js 24 or newer. Re-read relevant installed-version guides before implementation.
- eve route authentication does not automatically enforce session ownership. The local Workflow world uses filesystem state under `.eve/.workflow-data`, separately from the trading database; persist this directory for local restart tests. Interrupted work can repeat, so application deduplication is mandatory. The production workflow backend and recovery guarantees need verification before deployment.
- [PostgreSQL row locking](https://www.postgresql.org/docs/17/explicit-locking.html) supports serializing conflicting allocation updates inside transactions.
- [Better Auth session management](https://better-auth.com/docs/concepts/session-management) documents cookie-backed sessions and session freshness.
- Exchange constraints and official source links are recorded in `design-interview.md`.
