# Hold stop-limit triggers in the worker, and sell unprotected quantity

Status: accepted, 2026-10-08, for issues #42 and #43.

## Stop-limit entries

Every entry must carry its stop loss and take profit before it trades. Binance attaches exits to an entry only through an order list: OTO, OTOCO, OPO and OPOCO. All four accept only a `LIMIT` or `LIMIT_MAKER` working order. This is still true in the [Spot API documentation](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#order-lists) and its changelog of 2026-09-18, so Binance offers no list that holds a stop-limit entry with its exits.

The execution worker holds the trigger instead. A stop-limit entry is saved as an order intent with status `pending` and nothing is sent to Binance. On each pass, the worker reads the last traded price, which is also the price Binance triggers stops on. Once the price is at or above the stop price, the worker claims the intent, runs every check again with fresh account data, and sends a limit OPOCO entry at the limit price. The claim moves the intent from `pending` to `submitting` in one statement, so only one worker can send it. A worker that stops after the claim but before sending leaves the intent to reconciliation, which rejects it once Binance confirms it never received it. Nothing resends it.

A held entry reserves its value in the allocation, so the checks at trigger time pass unless the account changed.

Considered options:

- **An unprotected stop-limit order on Binance, with exits added when it fills.** The entry fills without a stop loss, and if the worker is down then, nothing protects it. Rejected.
- **A stop-limit working order in an order list.** Binance does not accept one.

The cost is that triggering depends on the worker running, unlike a stop order resting on Binance. A stop-limit entry that triggers while the worker is down is sent late, at the next pass, still as a limit order that pays at most its limit price. Protection does not depend on the worker: once sent, the entry's exits are on Binance like any other.

## Unprotected quantity

The brief says that protection failure triggers cancellation, attempted closure, a strategy pause, and an alert. The loop does exactly that when an entry holds bought quantity that no open stop loss covers: it cancels what is left of the order list, sells the quantity at market as a new exit intent saved before it is sent, pauses the entry's strategy, and raises a critical notification.

CONTEXT.md allows a stop loss to be tightened but never loosened, so placing new exits would be allowed at the same stop price or a tighter one. The worker does not do this. Binance drops exits when their size fails a filter, when the symbol's limit on stop orders (`MAX_NUM_ALGO_ORDERS`) is full, or when the market has already passed the stop. The same exits would fail again for each of these reasons, and a tighter stop would change the customer's instruction. Selling ends the exposure in every case.

A partly filled entry has no exits on Binance until it fills completely. The worker watches its market, and if the last price reaches the entry's stop loss, it cancels the rest of the entry and sells what it bought. This acts as a stop loss only for that partly filled quantity. It does not replace the exchange-held stops that ADR 0004 requires once the entry has filled.

The customer can cancel a partly filled entry, or an entry's exits, from the dashboard after confirming that the quantity is left without exits. The worker then hands that quantity over instead of selling it, because selling would override an explicit customer instruction. Cancels made anywhere else count as protection failure.
