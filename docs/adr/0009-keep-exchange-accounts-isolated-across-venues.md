# Keep exchange accounts isolated across venues

Status: accepted, 2026-10-09, for milestone M4 (issues #23 parts B and C, #26 and #29). It builds on ADR 0008, which defines the exchange-neutral venue, market and adapter types, and it keeps [ADR 0004](0004-hold-several-protected-entries-per-strategy.md)'s position ownership. It amends the [design interview](../design-interview.md)'s "GBP is a separate display conversion": the default reporting currency is now USDT, and GBP waits for a conversion route.

In M4 a customer can connect exchange accounts on more than one **venue**: Binance Spot Testnet, which trades, and HTX, which the product only reads (#29). Each exchange account stands alone. Its capital, positions, limits, credentials and failures stay inside it, and nothing about one account funds, offsets, measures or pauses another. Figures across accounts are added together only for display, in the customer's **reporting currency**. We chose isolation because the product cannot move money between venues, and because a rule that spans venues is only as safe as the least available venue in it.

## 1. Exchange isolation

- Capital on one exchange account never funds an order on another, and a position on one never offsets a position on another. This holds for two accounts on the same venue as well as on different venues.
- Every trade proposal, strategy, standing price instruction and dashboard order targets exactly one exchange account, named by its ID. The execution checks read balances, reservations, positions and limits from that account only. A proposal with no account, or an account the customer does not own, is rejected.
- AI may see snapshots of several exchange accounts, but each one is labelled with its account, and the AI draft tool requires the target account. The AI's instructions say that capital on one account cannot pay for an order on another (#26).
- Moving funds between exchange accounts is a **transfer**. The product never makes one. A transfer that the customer makes outside the product is a deposit or withdrawal on each account: it is not trading profit or loss, and on an account with running strategies it is an unexpected balance change, handled by reconciliation as before.
- One exchange account in the product is one account at the venue. Where the venue reports an account identifier when keys are connected, connecting a second exchange account to the same venue account is refused, because the two would count the same capital twice.

## 2. Positions across accounts

- A strategy belongs to one exchange account for its whole life. A new strategy version cannot change the account. To trade the same rules elsewhere, the customer creates a separate strategy there.
- The same instrument may be held on two exchange accounts by two different strategies. They are two positions, each owned by its own strategy, with its own protected entries, stops, deadlines, allocation and loss limits.
- There is no netting across exchange accounts. A long BTC position on one account does not reduce the risk, margin, loss or entry limit of a BTC position on another, and closing one never touches the other.
- This is ADR 0004's rule unchanged: one strategy owns an instrument's position per exchange account. Position ownership is keyed by exchange account and market (`UNIQUE (exchange_account_id, instrument)` today), so `authorizeTradeProposal` deliberately does not look at other accounts (#23 part C). The exchange's stop-order limit in ADR 0004 is already per account and symbol.
- The dashboard may show a customer's combined holding of an asset across accounts, in the reporting currency, as information only.

## 3. Accounting currency and reporting currency

- **Accounting currency.** Each exchange account keeps its explicit accounting currency. Allocations, reservations, loss limits and the daily drawdown limit of that account are set and measured in it. In M4, a strategy trades only markets quoted in its account's accounting currency, so its allocation and loss limits never depend on a conversion. A fee charged in an asset that the worker cannot value on the same venue makes the strategy unmeasurable, and it opens no entries, as today.
- **Reporting currency.** Each customer has one reporting currency, used only to display amounts and to add them up across exchange accounts. The default is **USDT**: every account in M4 accounts in USDT, and both venues list USDT markets, so totals need no outside price feed. A customer may choose another currency only when a conversion route to it exists for their accounts. GBP, which the interview named, has no market on Binance Spot Testnet (checked on 2026-10-09), so it is not offered until a venue market or an FX feed provides a route.
- **The daily drawdown limit stays per exchange account.** The limit from #52 is a percentage of the allocations of all strategies on one exchange account, measured in its accounting currency (`portfolio_limits` is keyed by `exchange_account_id`). "Portfolio" in the dashboard means the strategies on one account. With HTX read-only, every strategy in M4 is on Binance, so the per-account limit covers them all. The customer-wide drawdown across accounts is shown in the reporting currency, but it does not pause anything.
- **Conversion route.** An amount held on an exchange account is converted with prices from that account's own venue, never from another venue. The route is chosen in this order, and the first that exists is used:
  1. no conversion, when the amount is already in the reporting currency;
  2. one market between the two currencies, in either direction (for example USDC to USDT through `USDCUSDT`);
  3. two markets through USDT, then through USDC (for example EUR to USDC through `EURUSDT` and `USDCUSDT`).

  Longer routes are not used. Each market's price is the same mark the worker uses to value the account's holdings. The converted figure records its route, prices and observation times. Stablecoins and fiat are never assumed equal: USDC, USDT and USD convert through a market like any other currency. Arithmetic uses exact decimals, rounded only for display.

- **Missing or stale conversions.** A conversion is missing when no route exists on the account's venue, and stale when any of its prices is older than the valuation freshness threshold. The local build uses 60 seconds, and live thresholds remain a deployment decision, as the brief says. A missing or stale conversion is never shown as zero, never estimated from another venue, and never filled with an older price. The dashboard shows the amount in its own currency, says that the conversion is missing or stale and since when, and marks any total that needs it as incomplete, naming the accounts it leaves out.
- **Conversions never change an account.** A reporting figure never changes an allocation, a reservation, a loss limit, a drawdown measure or any execution check. A change of reporting currency changes only what the dashboard shows.
- **FX feeds.** A paid or external FX feed, such as one that would convert USD to GBP, is a deployment decision, like the other paid providers in the brief. M4 uses venue markets only.

## 4. Read-only venues

- A **read-only exchange account** is one whose venue adapter cannot place orders. In M4 that is every HTX account. HTX shut down its spot testnet, so any HTX account is a real account, and with live trading disabled it can only be read. Read-only comes from the adapter, not from a customer setting.
- The product monitors a read-only account: balances, open orders, recent fills, and its value in the reporting currency. It can never be the target of a strategy, trade proposal, standing price instruction or dashboard order, and the kill switch and close all have nothing to act on there. The execution checks reject any of these that names a read-only account, whatever the dashboard or AI sent. A read-only account has no allocation and no loss limits.
- Its API keys must have no trade or withdraw permission. Where the venue reports a key's permissions, the worker checks it when keys are connected or replaced and refuses a key with either one. On HTX this is `GET /v2/user/api-key`, whose `permission` field lists `readOnly`, `trade` and `withdraw`. HTX answers it for a parent user's key, so a sub-user's key cannot check itself. When the venue cannot report permissions, the connection says that read-only was not verified, and the adapter still sends no trading or withdrawal requests.
- Keys for an account that trades must not have withdraw permission either, as the interview settled. The worker checks this where the venue allows it. On live Binance that would be `enableWithdrawals` from `GET /sapi/v1/account/apiRestrictions`. Spot Testnet does not serve that endpoint (it answered 404 on 2026-10-09) and has no withdrawals, so nothing is checked there.

## 5. Venue failures stay isolated

- Rate limits, retry-after times, clock offsets and connection health are tracked per venue. Request queues, nonces and order-count limits are tracked per exchange account. A rate limit, clock-skew error or outage on one venue never pauses, delays or slows requests to another, and a slow or failing account never holds up another account's pass, its exits most of all.
- When a venue cannot serve an exchange account, the account is `unavailable`. This applies to an outage, maintenance, a rate limit the worker must wait out, or clock skew it cannot correct. Then:
  - **Entries wait.** No entry is submitted, held stop-limit entries stay pending, and a DCA buy that falls due is skipped, as ADR 0004 already says of a buy that cannot be made. The account's strategies keep their status: an outage is not a pause, and the customer does not have to resume them.
  - **Exits keep trying.** Holding-deadline exits, protection-failure sales, cancels, close all and the kill switch keep retrying with backoff and respect the venue's retry-after. Stops that are already on the exchange keep protecting. Overdue exits raise alerts as before.
  - **Measurement fails closed.** A strategy whose losses cannot be measured opens no entries, as ADR 0004 says.
  - **Recovery reconciles first.** When the venue answers again, the worker reconciles orders, fills and balances on that account before it submits any entry. Strategies then continue without customer action, unless a loss limit, the drawdown limit or a protection failure paused them while they were unavailable.
  - The customer gets one notification when an account becomes unavailable and one when it recovers. They are not repeated each pass.
- In portfolio totals, an unavailable account's figures are not counted. Its last known value is shown separately with its time, and the total is marked incomplete, naming the account. Other accounts' figures and limits are unaffected.

## 6. Credentials per venue

- Venues sign requests differently: a key and secret (HMAC), a key, secret and passphrase, or a key pair (RSA, Ed25519, or ES256 signing a JWT). Each exchange account has its own credential set of the venue's kind, sealed at rest with AES-256-GCM as in #50, with every part sealed: key, secret, passphrase and private key. A credential set belongs to one exchange account and is never shared between accounts.
- Credentials stay in the execution worker. They are never in AI context, logs, workflow history, error messages, notifications or audit details. The web app sees only masked state, such as the last four characters. Signed tokens such as an ES256 JWT are made in the worker for each request and are as secret as the key.
- For venues that require strictly increasing nonces, the worker sends one signed request at a time per exchange account, across all worker processes. Each nonce is greater than the last one the account used, including after a restart, so the last nonce is persisted. The customer is told to create a key used only by this product, because another program using the same key would break the sequence. A nonce error on an order request is handled like any other uncertain outcome: reconciliation comes before any retry.

## Considered options

- **Netting positions or sharing capital across accounts.** This would let a strategy span venues and use spare capital elsewhere, but the product cannot move funds. A hedge or margin that relies on another venue fails when that venue is down, and a stop on one venue cannot protect quantity on another. Rejected.
- **One strategy across several accounts.** This is simpler to configure for the same rules on two venues. But allocation, loss limits, entry limits, ownership and the kill switch are all per account, and an outage on one venue would leave the strategy half running. Rejected: the customer creates one strategy per account.
- **A customer-wide drawdown limit in the reporting currency.** It would bound losses across all accounts. To fail closed, a missing or stale conversion, or one venue's outage, would have to stop entries on every account, which breaks venue isolation. With one trading venue in M4, it would also measure the same strategies as the per-account limit. Left out for M4. If it is added later, it may only add pauses, and it must say how a missing conversion affects accounts on other venues.
- **Converting with another venue's prices, or treating stablecoins as equal to USD.** Both fill gaps, but they report a value the account could not get on its own venue, and they hide a depeg. Rejected: a missing conversion is shown as missing.
- **Letting customers mark any account read-only.** A key without trade permission does the same job, and the adapter rule covers venues that cannot trade. Left out.

## Consequences

- Trade proposals, including the AI draft tool's input, carry `exchangeAccountId`, and the execution checks resolve every balance and limit from it.
- The worker keeps rate limiters, clock offsets and health per venue, and request queues and nonces per exchange account (#21, #22). The order journal is partitioned by venue and account.
- Exchange accounts record whether their adapter can trade. Every order path rejects a read-only account, not just the dashboard.
- Credential storage gains key kinds beyond `hmac`, `ed25519` and `rsa` only when a venue needs them, such as `es256`, and a nonce counter per account for nonce-based venues.
- Customers gain a reporting currency setting, default USDT. Converted figures carry their route and price times, so the dashboard can show missing and stale conversions.
