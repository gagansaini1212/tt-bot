# Name venues, markets and orders the same way on every venue

Status: accepted, 2026-10-09, for milestone M4 (issues #19, #20 and #23 part A). [ADR 0009](0009-keep-exchange-accounts-isolated-across-venues.md) builds on it: it keeps exchange accounts on different venues isolated, and makes HTX a read-only venue.

Until M4 the application spoke Binance Spot Testnet's language everywhere. Instruments were an enum of `BTC-USDT` and `ETH-USDT`. Orders, lists and fills carried Binance's numeric IDs and its `BTCUSDT` symbols. The snapshot said `provider: "binance-spot-testnet"`, and client order IDs had to match Binance's rule. A second venue would break each of these: Kraken's order IDs look like `OU22CG-KLAF2-FWUDD7`, Coinbase names markets `BTC-USD`, OKX allows no `_` in a client order ID, and HTX is a venue the product can only read.

The worker and the dashboard now see one exchange-neutral contract in `packages/exchanges`. Each venue's adapter translates between it and the venue's API. The terms below are those of [CONTEXT.md](../../CONTEXT.md).

## Venues and their capabilities

- A **venue** is named by a venue ID, such as `binance-spot-testnet`, in `VENUE_IDS` (`venues.ts`). An exchange account's `exchange` column already holds it, so no stored row changes. The worker's `EXCHANGE_PROVIDER` takes a venue ID or `fixture`, and the account snapshot says `venue` where it said `provider`.
- Every venue declares its **capabilities** explicitly, as the [architecture](../architecture-proposal.md) asks, rather than pretending all order types behave alike. They describe what the adapter does, not everything the venue offers:
  - `marketKinds`: `spot` for Binance Spot Testnet;
  - `access`: `trade`, or `read_only` with no order methods at all;
  - `funds`: `virtual` on a testnet, or `real`;
  - `orderTypes`, `timeInForce` and `orderLists` the adapter places;
  - `attachedExits`: how a protected entry's take profit and stop loss reach the venue with the entry, `opoco` on Binance, or none;
  - `stopOrders`: `exits_only`, `standalone` or `none`. A stop-limit entry is held by the worker either way ([ADR 0007](0007-hold-stop-limit-triggers-and-sell-unprotected-quantity.md));
  - `testOrders` and `lookupByClientOrderId`.
- `canPlaceOrders` is true only for a venue with `trade` access, `virtual` funds and attached exits. Every other venue is read only, however its adapter is built, so live trading stays impossible. A test fails if a venue with real funds could place orders.
- A **read-only venue**, such as HTX in M4, declares `read_only` access, `real` funds, no order types, lists or attached exits, and `stopOrders: "none"`. Read-only comes from the adapter, never from a customer setting ([ADR 0009](0009-keep-exchange-accounts-isolated-across-venues.md#4-read-only-venues)).
- The adapter interfaces follow the same split (`contract.ts`):
  - `MarketDataAdapter`: the venue's market catalogue, tickers, candles, depth and the last price. It needs no keys.
  - `AccountReader`: balances, open orders, fills, an order by its venue ID, and the account snapshot. A read-only venue implements this much.
  - `TradingAdapter`: lookups by the application's order and list IDs, and every order and cancel. Only a venue that `canPlaceOrders` implements it.
- A request that fails throws an `ExchangeError` with a venue-neutral kind: `rejected`, `unavailable`, `rate_limited` or `unknown_outcome`, plus `orderNotFound` when the venue says the order does not exist. The worker no longer reads Binance's error codes. `BinanceTestnetError` is the Binance adapter's subclass, keeping its numeric code.

## Instruments, markets and venue symbols

- An **instrument** is the venue-neutral name of what is traded, written `BASE-QUOTE`: two asset codes in capitals or digits, or letters of scripts without case, which Binance lists, joined by one hyphen. `instrumentSchema` in `packages/domain` replaces the enum. A valid name says nothing about whether a venue lists it or a customer may trade it.
- A **market** is one instrument as one venue trades it. Each venue has a **market catalogue** (`MarketCatalogue`), loaded from the venue and kept for five minutes, as the worker kept Binance's rules before. Each market holds its instrument, its **venue symbol**, its status (`trading` or `halted`), its tick size, price range, step size, quantity range, minimum and maximum notional, whether it can attach exits, and the stop orders an account may hold on it. One catalogue serves every client of a venue. A failed load is not kept, and a venue that lists one instrument or venue symbol twice is not trusted.
- The catalogue builds each instrument from the venue's base and quote asset codes, so no adapter ever splits a symbol. Each venue's `VenueSymbolCodec` turns an instrument into its venue symbol and normalizes asset codes:

  | Venue                | Venue symbol of BTC-USDT | Asset codes                                                                                        |
  | -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
  | Binance Spot Testnet | `BTCUSDT`                | As listed                                                                                          |
  | HTX (read only, #29) | `btcusdt`                | Lowercase in the API, capitals here                                                                |
  | Coinbase (example)   | `BTC-USD` for BTC-USD    | As listed                                                                                          |
  | Kraken (example)     | `XBTUSD` (altname)       | `XBT` → `BTC`, `XXBT` → `BTC`, `ZUSD` → `USD`, or `assetVersion=1`, which already says BTC and USD |
  | OKX (example)        | `BTC-USDT`               | As listed                                                                                          |

- The Binance adapter reads the whole catalogue from `GET /api/v3/exchangeInfo` without parameters. That costs a request weight of 20, where the two-symbol request cost 2, but only once per five minutes for every account together. A symbol it cannot read, such as one without a `LOT_SIZE` filter, is left out rather than failing the rest. Binance's `PRICE_FILTER`, `LOT_SIZE`, `NOTIONAL` (or `MIN_NOTIONAL`) and `MAX_NUM_ALGO_ORDERS` fill the same fields they did. `protectedEntryFilterIssues` in `order-rules.ts` reads them from the catalogue's market. Other venues map their own fields onto the same ones: Coinbase's `price_increment`, `base_increment` and `base_min_size`, Kraken's `tick_size`, `lot_decimals`, `ordermin` and `costmin`, OKX's `tickSz`, `lotSz` and `minSz`, and HTX's `market-symbols` precisions and `minoa`, `maxoa` and `minov`.
- Orders, lists and fills carry their instrument. The worker's market data routes refuse an instrument the catalogue does not list, with `unknown_market`, before asking the venue for its candles or depth. Tickers still carry the venue symbol, because the dashboard values holdings through every market the venue lists. Normalizing them is left to the first second venue that serves them.

## What an account may trade

- What an exchange account can trade is its venue's catalogue, narrowed in turn by:
  1. the account's **allowed instruments**, a new column `exchange_accounts.allowed_instruments`. It defaults to `BTC-USDT` and `ETH-USDT` (`DEFAULT_ALLOWED_INSTRUMENTS`), so nothing changes until a customer widens it. It holds at least one instrument;
  2. the account's accounting currency: in M4 a strategy trades only markets quoted in it ([ADR 0009](0009-keep-exchange-accounts-isolated-across-venues.md#3-accounting-currency-and-reporting-currency)). The same applies to dashboard orders and the assistant's proposals;
  3. a strategy's rules, and the worker's `TESTNET_MANUAL_INSTRUMENTS` for dashboard orders.
- Creating a strategy, or a new version, is refused when its venue does not list one of its instruments, or when the account cannot trade one. Every entry is checked again before it is reserved, with the account's list as it is then, so narrowing the list stops a strategy opening entries in a market it no longer allows. Its open entries keep their exits. `authorizeTradeProposal` refuses any instrument outside the policy's allowed instruments, which hold this narrowed list.
- The assistant may name any `BASE-QUOTE` instrument. The worker refuses a decision about one the account cannot trade. An AI-managed strategy's analysis is offered only the markets its rules name, the account allows and the venue lists.
- The account snapshot, Open orders and fills cover the account's tradable instruments. The Markets page and the backtest offer the default allowed instruments, and the strategy editor offers the account's tradable instruments that the venue lists.
- Stored strategy rules, proposals, intents and positions already name `BTC-USDT` or `ETH-USDT`, which are valid instruments, so they need no migration.

## Order IDs

- Venues' IDs for orders, order lists and fills are strings in the contract, whatever the venue uses. Binance's numeric IDs become their decimal strings, and an order list ID is null for an order in no list, where Binance says -1. `exchange_orders.exchange_order_id` and `fills.exchange_fill_id` were already text. Audit events written after this change record list IDs as strings. Cancels from the dashboard now send the order ID as the snapshot reports it, a string.
- The application keeps one venue-neutral **order ID**: the order intent's idempotency key, `ct_` and up to 30 letters, digits, `_` or `-`, or a leg or close ID derived from it by a suffix (`_en`, `_tp`, `_sl`, `_c1` to `_c9`). So it is at most 36 characters. Each adapter's `ClientOrderIdCodec` translates it to the venue's client order ID and back:
  - `toVenue` is deterministic, so a lookup after an unknown outcome finds the order a lost response placed, and a retry never makes a second one. It throws, before anything is sent, if the venue cannot carry the ID.
  - `fromVenue` returns the application's ID, or nothing for an order placed outside the application. Normalized orders carry the application's ID where it placed them, and the venue's own client ID otherwise.
- The rules for each venue, from their official API documentation, read on 2026-10-09:

  | Venue                | Client order ID rule                                                                                                                                                                             | Translation                                                                                                                                                                                                                    |
  | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Binance Spot Testnet | `^[a-zA-Z0-9-_]{1,36}$`, documented for the FIX API. The REST API states no rule, so the adapter keeps to this one.                                                                              | Unchanged. Every stored `ct_` intent keeps working, and Binance's IDs for them stay the same.                                                                                                                                  |
  | HTX (read only)      | Letters, digits, `_` and `-`, at most 64 characters.                                                                                                                                             | Unchanged, should HTX ever trade. While it is read only, `fromVenue` recognises orders the application did not place as not its own.                                                                                           |
  | Coinbase (example)   | A unique string, with no format or length stated. The issue's assumption that it must be a UUID is not what the documentation says.                                                              | Unchanged. If Coinbase enforces a format, a UUID version 5 of the order ID under a fixed namespace, recognised by recomputing it from known IDs.                                                                               |
  | Kraken (example)     | `cl_ord_id`: a UUID, with or without dashes, or free ASCII text of at most 18 characters. `userref` is a 32-bit integer and not unique. The issue's "string up to 32 characters" does not match. | A UUID version 5 of the order ID: the application's IDs exceed 18 characters. `fromVenue` recomputes it from the order IDs the worker knows, since a hash cannot be reversed. `userref` is not used, because it is not unique. |
  | OKX (example)        | `clOrdId`: letters and digits only, at most 32 characters.                                                                                                                                       | `ct` and 30 letters and digits from a hash of the order ID (base 62), recognised by recomputing it from known IDs. Dropping `_` and `-` alone could make two IDs equal.                                                        |

## Considered options

- **A `provider` string, or a growing enum of venue names in each schema.** Simple, but every schema would need editing per venue, and nothing would say what each venue can do. Rejected for venue IDs with declared capabilities.
- **Keeping Binance's numeric IDs and symbols in the contract.** Smallest change, but Coinbase, Kraken and HTX IDs would fail to parse, as #19 shows. Rejected.
- **Splitting venue symbols into instruments by known quote suffixes.** It needs no catalogue, but `BTCUSDT` could also be `BTCU` and `SDT`, and Kraken's codes need aliases anyway. Rejected: the catalogue builds instruments from the venue's own base and quote assets.
- **Normalizing order statuses and types into a new vocabulary.** The worker's reconciliation reads Binance's statuses in many places, and a venue that trades will need its own mapping anyway. Binance Spot's vocabulary (`NEW`, `PENDING_NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`, `EXPIRED`; `LIMIT`, `LIMIT_MAKER`, `MARKET`, `STOP_LOSS`) is the contract's, and other adapters translate into it.
- **The allowed instruments as worker configuration only.** It needs no migration, but a customer could never widen their own list, and every account would share one. Rejected for a per-account column with the old list as its default.

## Consequences

- A new venue adds its ID to `VENUE_IDS` and a descriptor with its capabilities and codecs, then implements `AccountReader`, or `TradingAdapter` if it may trade. HTX (#29) adds a read-only one.
- The worker shares one market catalogue between every client of a venue. Its market rules can be up to five minutes old, as before; an order that misses a change is refused by the venue.
- Fills and open orders on the dashboard show the market as BTC/USDT, where they showed Binance's `BTCUSDT`.
- Widening an account's allowed instruments has no screen yet: it is an update to `exchange_accounts.allowed_instruments`.
