# Connect HTX accounts read only

Status: accepted, 2026-10-09, for milestone M4 (#29). It carries out [ADR 0009](0009-keep-exchange-accounts-isolated-across-venues.md) §4 for HTX, through [ADR 0008](0008-normalize-venues-markets-and-order-ids.md)'s contract, [ADR 0010](0010-serve-every-exchange-account-from-one-worker.md)'s venue registry and [ADR 0011](0011-disconnect-exchange-accounts-without-deleting-them.md)'s exchange accounts. What HTX's API documents is in [docs/venues/htx.md](../venues/htx.md).

HTX shut its spot testnet down, so every HTX account holds real funds, and with live trading disabled the product can only read it. A customer can now connect HTX accounts beside their Binance Spot Testnet accounts. One worker serves both venues, and the dashboard shows each account's balances, open orders and recent fills.

## Decisions

- **HTX is the venue `htx`, read only.** Its capabilities say `read_only` access, `real` funds, no order types, lists or attached exits. Its adapter, `HtxSpot`, implements `AccountReader` and nothing more: it has no order, cancel or withdrawal code, and its signer signs GET requests only. Its client order ID codec refuses to translate an ID, since the application sends HTX no orders, which amends ADR 0008's HTX row. `canTrade` is false for every HTX client, so every order path refuses an HTX account, and its accounts are `live`, never `simulation`.
- **Keys are an Access Key and a Secret Key (HMAC), with no passphrase.** Before saving keys, and when the customer tests the connection, the worker asks HTX what they may do (`GET /v2/user/uid`, then `GET /v2/user/api-key`). It refuses a key that can trade or withdraw. A permission HTX has not documented counts as trade.
- **A key HTX will not describe needs the customer's confirmation.** HTX answers the permission report for a main account's key only, and refuses it for a sub-account's. ADR 0009 saved such a key with a note that read only was not verified. Now, on a read-only venue, the worker refuses an unverified key unless the request carries `confirmReadOnly`. Settings sends that when the customer ticks "This key has read permission only: it can neither trade nor withdraw." The audit event for saved keys records `readOnly: "verified"` or `"confirmed"`. A key HTX reports as read only needs no confirmation.
- **HTX's limits stay with HTX, and its per-user limits with one account.** HTX's clients share one `VenueLimits`, which no Binance client sees. HTX counts its private endpoints' rate limits per user (UID). So its documented rate-limit codes (`1006`, `frequent-invoke`) on a signed request hold back only that account's signed requests. An HTTP 429 without one of those codes, and any limit on public data, holds back the whole venue, as an unknown 429 does on Binance. Without a Retry-After the wait is 10 seconds: HTX's documented windows are one to two seconds, and no HTX request is urgent for a read-only account.
- **HTX's clock is HTX's.** Signed requests carry HTX's time, from `GET /v1/common/timestamp`, read once a minute and shared by every HTX client. HTX reports a stale timestamp the same way as a wrong signature (`api-signature-not-valid`). So on that answer the adapter reads HTX's time again and sends the GET once more, at most once a minute per account, so one key HTX refuses for good never keeps the clock every HTX account shares busy. A second refusal is a rejection, as for a wrong key. A failure to read the time makes the account `unavailable`.
- **Market data keeps HTX's names.** Tickers carry HTX's lowercase symbols (`btcusdt`). The worker's ticker filter accepts a venue's symbols in capitals or in lowercase, never mixed. Holdings are valued, and counted in totals, with HTX's own tickers through each instrument's HTX symbol. HTX's ticker opens at midnight Singapore time, not 24 hours back, so the dashboard shows no 24-hour change for HTX holdings rather than a wrong one.
- **The dashboard lists the other accounts.** The Overview still acts on one account: the customer's oldest that trades. Under it, each other account the worker reads shows its own balances, open orders and recent fills, with no cancel buttons. On a read-only current account, the Overview says so and shows its orders without cancel buttons. The account switcher and combined views are #25's.

## Considered options

- **Saving an unverified key with a warning, as ADR 0009 said.** It needs no extra step. But the product would hold a key that might trade or withdraw real funds, and the customer would not have said otherwise. Rejected for an explicit confirmation.
- **Requiring the confirmation for every HTX key.** It is simpler to explain. But HTX checks a main account's key itself, and a checked key is the stronger guarantee. Rejected.
- **Holding back every HTX request after any rate limit.** It is the simplest rule, but one busy account would pause its neighbours' reads, which ADR 0010 rejected for Binance's order counts. An unknown 429 still holds back the venue.
- **Treating `api-signature-not-valid` as clock skew, or as an outage.** Either would make a wrong key look like a passing fault and keep retrying it. Rejected for a single retry after reading the time again.

## Consequences

- `VENUE_IDS` has `htx`, and the worker registers `htxVenue()` beside `binanceSpotTestnetVenue()`.
- The add-account and replace-keys requests take an optional `confirmReadOnly: true`.
- `venueTickerSymbolSchema` replaces Binance's capitals-only symbol check in the worker's ticker route.
- `@crypto-trading/exchanges/fixtures/fake-htx` is a fake HTX for tests: a `fetch` that checks each signature and refuses anything but a GET.
