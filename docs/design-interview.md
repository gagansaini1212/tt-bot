# Trading agent design interview

## Stated requirements

- Build with eve.
- Support multiple crypto exchanges.
- Support spot and futures trading.
- Let users specify capital allocation and trade amounts.
- Support buying and selling at user-specified prices.
- Support stop loss and take profit instructions.
- Trigger buys and sells when a trading opportunity is detected.

These requirements describe the intended product. Release sequencing and exact behavior remain open.

## Round one answers

- Customers connect their own exchange accounts.
- The agent trades automatically within configured limits.
- AI interprets market data and news, potentially combined with explicit rules.
- Intended holding periods include minutes, hours, and days.
- A mock exchange and Binance are tentative initial integrations; UK is the initial location mentioned.
- Both simulation and live trading are wanted.

## Round two answers

- Spot and futures must both be in the first release. Round three resolves product eligibility policy.
- Customers control their limits. Round three resolves platform maximums and AI authority.
- Allocation is total capital available across simultaneous trades, with separate position and loss limits. Allocation is not an acceptable-loss amount.
- Customers select permitted assets and strategy horizons. AI proposes assets, entry prices, sizes, and exits within those selections. Code checks every proposed order against limits before submission.
- Standing price instructions and AI-managed trades are distinct. AI cannot silently override a standing price instruction.
- Each strategy has a customer-selected horizon. AI cannot silently convert a short trade into a long-term holding.
- Initially, the agent manages only positions it opens and has no withdrawal permission. Customers may explicitly assign existing holdings in a later scope.

## Round three answers

- Offer simulated futures to all product users; enable live futures only for verified eligible customers and exchange accounts. Specific launch countries and verification process remain open.
- Customers set limits beneath platform maximums. AI may suggest limit changes but cannot apply them.
- Customers assign separate budgets per exchange account and then per strategy. Simulation has a separate balance. Strategies cannot borrow from each other.
- Loss limits count realized and unrealized losses, including fees and funding. On breach, stop new entries, cancel pending entry orders, and attempt to close affected positions. A loss limit triggers action; it does not guarantee a maximum loss.
- Every trade requires a stop loss and take profit before entry. AI may tighten a stop but cannot remove it or loosen it to accept a larger loss. Customers choose whether profit targets may change.
- The strategy horizon is a firm exit deadline. Round four defines the clock start; outage behavior remains open.
- Provide a web dashboard for accounts, budgets, positions, pause, and close controls. Chat explains activity and drafts trading instructions; show the exact effects of changes before activation.

## Round four answers

- Protect every filled entry amount immediately. If protection cannot be established, cancel the unfilled entry, attempt to close the filled amount, pause the strategy, and alert the customer. This is required behavior, not a claim that placement is atomic or guaranteed.
- Pause stops new entries and cancels pending entry orders while maintaining protective exits and holding deadlines. Close all additionally attempts to close managed positions. Resuming after a loss-limit breach requires customer action.
- First-release futures are perpetual contracts using isolated margin. Customers select leverage beneath a platform maximum; AI cannot increase it. Exact contracts and numeric caps remain open.
- Include daily and total strategy loss limits. Define the daily boundary explicitly later. Crossing into a new day does not automatically resume a strategy paused by a breach.
- Profits do not automatically raise allocation. Losses reduce available capital, and pending orders reserve budget to prevent double spending.
- The holding clock starts at the first fill. Later fills do not extend it; cancel any unfilled entry remainder at the deadline.
- Profit targets are fixed by default. Customers may enable AI adjustment per strategy, without extending the deadline or loosening the stop.
- Prefer dedicated trading subaccounts where supported. Otherwise, unexpected balance or position changes pause affected strategies for reconciliation. The agent does not automatically replace holdings sold manually.

## Round five answers

- One strategy owns an instrument's position per exchange account initially. Another strategy requires a separate account or waits.
- Stop new entries during uncertain execution outcomes, stale market data, or exchange outages. Reconcile actual orders and positions before retrying; preserve existing protection. Missed exits remain pending and trigger alerts. Automatic resumption requires successful reconciliation, except loss-limit breaches and protection failures require customer action.
- Initially use exchange market data and selected timestamped news sources, excluding social media. Retain sources behind decisions and allow no-trade decisions.
- Run scheduled AI analysis by strategy horizon, plus relevant news or price events. Order monitoring, protective exits, and deadlines operate independently of AI calls. Frequencies and spending caps remain open.
- Simulation uses the same trading rules and execution checks as live trading, modeling fees, spread, slippage, partial fills, funding, and liquidation. Include historical replay and simulation against live market data.
- Customers test a strategy in simulation before explicitly activating its account, allocation, limits, and version for live trading. Passing simulation checks establishes operational readiness, not future profitability. Exact activation criteria remain open.
- Provide in-app history and email alerts for protection failures, loss-limit breaches, missed exits, and account disconnections. Routine trades may be summarized in a digest.
- Launch as an invite-only pilot. Customer count, operating budget, and hosting preference were not supplied by the blanket acceptance and remain open.

## Round six answers

- Build locally first and exercise ten simulated customers. Hosting and a real operating budget are decisions for deployment, not assumed spending authorization.
- Encrypt customer exchange credentials and make them accessible only to the execution service, excluding them from model context and logs. Administrators can suspend trading but cannot raise customer limits or place discretionary trades. Infrastructure access still requires a separately designed operational security boundary.
- Each exchange account has an explicit accounting currency, matching collateral where possible. Daily loss measurement resets at midnight UTC; a breach pause does not automatically reset. GBP is a separate display conversion. Deposits and withdrawals are not profit or loss.
- Hard execution limits override standing price instructions. Every standing entry instruction requires an explicit expiry.
- Reducing allocation below committed capital presents a conflict: the customer chooses immediate position reduction or stopping entries while positions exit. Do not show the lower allocation as enforced while exposure exceeds it.
- Build mock and Binance integrations. Disable live activation for every unverified account or product. Launch jurisdictions and eligibility checks must be settled before live customer admission.
- The assistant researches and proposes technical architecture as a whole. Trading behavior, spending commitments, and launch scope remain customer decisions.

## Current decision frontier

Confirm the consolidated local implementation brief captures the shared understanding. No further product choices block the agreed local build; explicit deployment decisions remain deferred, not implicitly accepted.

## Round seven answers

- Accept the local architecture: TypeScript, Next.js dashboard, eve analysis/chat service, separate execution worker, PostgreSQL, and Better Auth.
- Initially support BTC and ETH spot and supported stablecoin-settled perpetual contracts. Simulation settings are explicit fixtures; live instruments, leverage caps, and monetary limits need separate configuration before activation.
- Use price-bounded entries with expiry. No automatic averaging down or additions to an existing position initially. Protective and deadline exits prioritize closing over the original target price; record actual slippage and distinguish requested exits from confirmed fills.
- Strategy versions are immutable. Existing positions retain their original strategy rules; edited strategies return to simulation before live activation. Existing customer/platform risk controls and emergency actions continue to apply.
- Validation covers execution failures, recovery, customer isolation, and performance evaluation after fees/funding. Profitability criteria remain a separate live-launch decision.
- On disconnection, offer closing managed positions first or an explicit handover listing remaining positions and protective orders. External credential revocation marks management unavailable and alerts the customer, without claiming positions closed.

## Explicit deployment decisions

Hosting, real customer capacity, operating budget, paid data/model access, launch jurisdictions, verified product/account eligibility, numeric live limits, and production retention requirements are deferred to deployment. These must not silently inherit simulated settings. The implementation should keep live activation unavailable until they are resolved.

## Remaining design branches

Exact platform limits, supported assets, launch jurisdictions and eligibility checks, specific data providers, strategy evaluation criteria, simulation assumptions, deployment, onboarding, credentials, audit retention, and release validation remain to be discussed. Exchange research establishes some execution constraints but not current account eligibility or uniform support across exchanges.

## Exchange execution research

- Binance spot OTOCO activates its protective OCO pair only after its entry fully fills. It cannot by itself satisfy protection of partial fills. [Official spot API docs](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#new-order-list---otoco-trade).
- Binance futures closePosition closes the relevant current position side, not a strategy-specific allocation. Inference: independent strategy budgets do not establish isolated position ownership on the exchange. [Official futures trade docs](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).
- A spot timeout or certain futures 503 responses can leave execution status unknown. Check order status before resubmission. [Spot REST docs](https://developers.binance.com/en/docs/products/spot/rest-api), [futures general information](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info).
- Binance's UK onboarding suspension notice is historical; no verified newer announcement establishing resumed onboarding has been found. Current account eligibility remains unresolved. [Binance UK notice](https://www.binance.com/en-GB/blog/all/update-on-binance-for-uk-users-937596818854026589).

## Research affecting scope

The FCA retains restrictions on retail cryptoasset derivatives. UK retail futures cannot be assumed to be a supported live product. See [FCA statement](https://www.fca.org.uk/news/press-releases/fca-lift-ban-crypto-exchange-traded-notes) and [COBS 22.6](https://handbook.fca.org.uk/handbook/cobs22/cobs22s6?timeline=true). Binance account eligibility and current UK spot API availability remain unverified.

## Original first-round questions

- Intended users and account ownership.
- Agent authority to place and manage orders.
- Meaning of opportunity and intended trading horizon.
- Initial exchanges and users' countries of residence.
- First release: simulation, live trading, or both.

Later questions depend on those answers:

- Account ownership → credentials, isolation, permissions, onboarding.
- Trading authority → approval lifecycle, expiry, emergency controls.
- Opportunity definition → data sources, strategy rules, evaluation criteria.
- Exchanges and countries → available products, order types, integration constraints.
- Release mode → validation requirements and live activation criteria.
- All of the above → allocation, exposure, loss limits, futures margin and leverage.
- Execution constraints → partial fills, retries, reconciliation, protective orders, outages.

## Documentation approach

Record settled domain terms in CONTEXT.md as they are agreed. Record consequential architecture decisions in docs/adr/ after their alternatives and trade-offs are discussed. Recommendations in the interview are proposals, not accepted decisions.
