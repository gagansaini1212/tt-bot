# Crypto trading agent implementation brief

Status: consolidated from accepted interview answers Q1–47; awaiting final shared-understanding confirmation before implementation.

> **Amended 2026-10-08 by [ADR 0004](adr/0004-hold-several-protected-entries-per-strategy.md).** One strategy may hold several protected entries, which allows DCA, grid and AI-managed strategies. "No additions or averaging down initially" no longer holds: an addition is a new protected entry with its own stop loss, take profit and holding deadline, within the strategy's allocation, position limit and entry limit. Holding deadlines start at each entry's first fill. One strategy still owns an instrument's position per exchange account. The rest of this brief is unchanged.

> **Amended 2026-10-09 by [ADR 0009](adr/0009-keep-exchange-accounts-isolated-across-venues.md).** Customers may connect exchange accounts on several venues. Each account is isolated: its capital never funds, and its positions never offset, another account's, and every proposal and strategy targets exactly one account. Each account keeps its accounting currency for allocation and limits. A customer reporting currency, USDT by default, is for display and cross-account totals only, converted with each venue's own market prices and shown as missing rather than zero when no fresh route exists. Read-only accounts, such as HTX in M4, are monitored but never traded. One venue's rate limit, clock skew or outage never pauses another. Credentials stay per account and in the execution worker, with one signed request at a time on nonce-based venues. The rest of this brief is unchanged.

## Product

Build a local-first, multi-customer trading application using eve. Customers connect their own exchange accounts, assign capital per account and strategy, choose assets and holding horizons, and authorize automated trading within their own limits beneath platform maximums.

The first release covers BTC and ETH spot plus supported stablecoin-settled perpetual contracts with isolated margin. Include a mock exchange and Binance adapters, historical replay, live-data simulation, and live execution capability. Live activation remains disabled until the deployment prerequisites below are resolved. Verify local behavior with ten simulated customers, not ten real trading accounts.

## Customer experience

Provide a web dashboard for accounts, allocation, strategies, positions, order history, decisions, and pause/close controls. Chat explains activity and drafts changes; show exact effects before activating customer changes. Distinguish standing price instructions from AI-managed trades. All entry instructions remain subject to hard execution limits.

Send critical notifications to in-app history and email; local verification uses a captured email sink. No production messaging provider or paid service is provisioned by this brief.

## Trading contract

- Allocation is a total capital budget, not a permitted loss. Reserve pending entry funds and prevent borrowing across strategies. Profits do not automatically increase allocation.
- Daily and total strategy loss limits include realized/unrealized losses, fees, and funding. Use the account's explicit accounting currency and a midnight UTC daily boundary. Transfers are not trading profit or loss.
- Breaches stop new entries, cancel pending entries, and attempt to close affected positions. Customer action is required to resume; midnight does not resume trading.
- Require stop loss and take profit before entry, and protect each filled amount. Protection failure triggers cancellation, attempted closure, a strategy pause, and an alert.
- AI may tighten stops but cannot loosen or remove them. Targets are fixed unless the customer enables adjustments. AI cannot apply limit changes.
- Start holding deadlines at the first fill. Later fills do not extend them. Entries are price-bounded and expire; no additions or averaging down initially.
- Assign one strategy per instrument position per exchange account. Manage only agent-opened positions initially; prefer dedicated trading subaccounts where supported.
- Pause preserves protection and deadlines. Close all also attempts closure. Unknown outcomes require reconciliation before retry; unexpected manual changes pause affected strategies.
- Strategy edits create new versions and require simulation before live activation. Existing positions retain their original strategy version, subject to ongoing risk controls.
- Disconnection requires closure or explicit handover. Lost credentials mean management is unavailable, not that positions closed.

## Architecture

Use TypeScript, Next.js, Better Auth, an eve analysis/chat service, a separate execution worker, and PostgreSQL. See [the accepted architecture](architecture-proposal.md) and [ADRs](adr/).

Keep credentials in the execution service, outside AI context, logs, and workflow history. Derive customer identity from authenticated sessions; authorize ownership of every session, stream, command, and job. Administrators may suspend trading but cannot raise customer limits or place discretionary trades through the application.

Use typed market/news/model provider interfaces. Begin local verification with deterministic fixtures; real model access and paid news require explicit configuration and a spending budget. Shared market/news ingestion can reduce duplicate work while customer portfolios and mandates remain isolated.

## Implementation sequence

1. Scaffold services, development identities, tenant isolation, database migrations, exact monetary arithmetic, and versioned policies.
2. Implement mock exchange, virtual clock, budget reservation, position ownership, order lifecycle, protection, deadlines, and reconciliation.
3. Add eve proposal tools and source-backed analysis using recorded fixtures, with independent execution checks.
4. Build dashboard, chat drafts, simulation reports, pause/close controls, handover, and captured notifications.
5. Add Binance spot/perpetual adapters and capability checks, without enabling real orders by default.
6. Exercise historical replay, live-data simulation, restart recovery, failure injection, and the complete customer flow.

## Completion evidence for the local build

Demonstrate ten isolated simulated customers, including concurrent orders competing for budgets. Verify no cross-customer access, duplicate submissions after recovery, double-spent allocations, or silently ignored exits.

Cover partial fills, failed protection, unknown acknowledgments, disconnections, stale data, manual account changes, daily loss boundaries, funding, liquidation, and overdue exits. Verify mock balances and positions reconcile after recovery. A fixture-driven analysis demo must be labeled as such, not presented as real AI performance.

Operational verification and historical strategy evaluation are distinct. Report fees, funding, drawdown, baselines, and historical-data limitations; do not interpret passing software tests as evidence of profitable trading.

## Prerequisites for live deployment

- Approved hosting, production capacity, workflow persistence/recovery, and operating budget.
- Selected model/news providers, licensed data usage, analysis frequencies, and spending caps.
- Launch jurisdictions and an established eligibility process, including current exchange account/product access.
- Explicit live instruments, leverage and monetary limits, valuation/freshness thresholds, and slippage policy. No automatic reuse of simulation fixtures.
- Accepted strategy-promotion criteria and account activation checks.
- Production credential/key management, backups, restore drills, audit retention/deletion policy, and notification delivery.

These are deferred deployment decisions. Local development must expose missing configuration and keep live activation disabled, rather than silently filling it with defaults.
