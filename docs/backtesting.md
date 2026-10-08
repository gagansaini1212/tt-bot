# Backtesting

A backtest replays a strategy's rules over up to 30 days of past hourly candles and reports what they would have done. It runs the same code as a live strategy: the planners `planGridEntries`, `planDcaBuy` and `planStandingEntries`, the execution checks in `authorizeTradeProposal`, Binance's filters through `protectedEntryFilterIssues`, and `lossLimitStatus`. It never places an order.

The runner is on the Strategies page. The simulator is `packages/backtest`, and the history client is `packages/exchanges/src/binance-spot-history.ts`.

## History

The testnet keeps only about a day of candles, so history comes from Binance's live spot market at `https://data-api.binance.vision`. That host serves public market data only: it takes no API key and has no account or order endpoints, so nothing can be traded through it ([Binance: market data only](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md)). The client sends unsigned GET requests for `/api/v3/klines` and `/api/v3/exchangeInfo`, and no credentials.

`/api/v3/klines` returns at most 1,000 candles a request, oldest first from `startTime` and never past `endTime` ([Binance: klines](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#klinecandlestick-data)). Thirty days of hourly candles is 720, so a backtest needs one request per gap in the cache. The client still pages from just after the last candle until the range is covered. A 429 or 418 makes it wait for `Retry-After` seconds before asking again.

`SpotHistoryCache` keeps what it downloads as JSON, one file per market and UTC day, under `MARKET_HISTORY_CACHE_DIR` or `.market-history` in the web app's working directory. Only a day that has ended with all 24 candles is kept, since its candles are final. A damaged or incomplete file is downloaded again. Filters are kept for the UTC day they were read. Delete the directory to start afresh.

A backtest uses only candles that have closed. The tick size, lot step, minimum order value and stop-order limit are today's, from `exchangeInfo`.

## The simulator

The simulator walks the candles on a virtual clock. It is deterministic: the same input always gives the same result.

At each candle's open, in this order:

1. At midnight UTC, it records the unrealized result of open entries, where the daily loss limit starts.
2. Pending entries past their expiry are cancelled.
3. Open entries past their holding deadline are sold at the open, less slippage.
4. Loss limits are measured with open entries at the open. If either is reached, pending entries are cancelled, open entries are sold at the open less slippage, and the strategy is paused for the rest of the run.
5. A running strategy's planner proposes entries. Each passes `authorizeTradeProposal`, with a policy built from `ruleLimits` and the entries the strategy holds, then Binance's filters. An entry priced at or above the ask (the open plus slippage) buys at once at the ask, as a taker. Any other entry rests on the book.

During the candle, in the worst order its open, high, low and close allow:

- A resting buy fills, at its own price, as a maker, only when the low trades through it: touching is not enough.
- A stop loss triggers when the low reaches it and sells at the stop, less slippage, as a taker. If the candle opened at or below the stop, it sells from the open.
- A take profit fills, at its price, as a maker, only when the high trades through it.
- When a candle reaches both a stop and a target, the stop fills.
- An entry that filled after the candle opened can be stopped out in that candle, but takes no profit until the next one: the high may have come before the fill.
- An entry whose expiry falls inside a candle does not fill in it.
- A grid whose candle reaches the range stop or rises above the range closes what remains at the close and completes.

At the close, loss limits are measured again, with open entries at the close and the clock at the candle's last millisecond, so a loss in a day's last hour counts against that day. Equity is cash plus open entries at each close.

Fills and exits are timed to the candle they happen in. An entry bought at the open starts its holding period then. One that fills during a candle starts it at the candle's close, the latest it could have filled, so it is never closed before its deadline, though it can be closed up to an hour after. A strategy completes once its rules open no more entries and it holds none.

### What it enforces

- **Protection.** Every entry has its stop loss and take profit from the moment it fills.
- **Allocation, position and entry limits**, through `authorizeTradeProposal`, counting pending and open entries.
- **Binance's stop-order limit.** Each entry's stop is one of the `MAX_NUM_ALGO_ORDERS` (5) stop orders Binance allows an account per symbol ([Binance: filters](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md#max_num_algo_orders)). As ADR 0004 says, the entry limit is the lower of the rules' limit and that one. A grid rests buys at the five nearest levels, and a DCA skips buys while five are open.
- **Range stops and range exits** for grids, **holding deadlines** from each entry's first fill, and **daily and total loss limits** with `lossLimitStatus`.
- **Skipped DCA buys** are never made up, and the result says why each was skipped.

### Costs

Fees default to Binance Spot's regular rate, 0.1% for makers and takers, without the BNB discount. Slippage defaults to 0.05% on taker fills. All three can be changed per run, up to 1% for fees and 5% for slippage. Fees are charged in USDT on each fill's value.

## AI-managed strategies

A backtest cannot run the AI over the past, so an AI-managed strategy replays recorded proposals instead. A fixture holds an AI-managed strategy's rules, a market, a period, an allocation and proposals in the shape the `draft_trade_proposal` tool records, each with its time. Each proposal is submitted at the first candle open at or after its time, through the same checks as any entry. The result is labelled as a fixture, and the run says nothing about how the AI trades.

The repository's only fixture, `packages/backtest/src/fixtures/sample-ai-proposals.json`, was written by hand to exercise the replay. Replays of real recorded decisions can use the same format once decisions are stored.

## Metrics

- **Net PnL**: final equity less the allocation, after fees. Open entries count at the last close, without a sell fee.
- **Fees**: every fee paid, in USDT.
- **Maximum drawdown**: the largest fall in equity from an earlier peak, as a percentage of that peak, with its amount.
- **Sharpe ratio**: the mean hourly return above the risk-free rate, over the sample standard deviation of hourly returns, times √8,760 (hours in a 365-day year, as crypto trades every hour). The risk-free rate is 0% a year. With fewer than two returns, or none that differ, there is no ratio.
- **Win and loss rate**: the share of closed trades that made or lost money after fees.
- **Trades**: entries that filled, closed and open.
- **Buy and hold**: the baseline the docs require. It buys with the whole allocation at the first open, as a taker with slippage and the taker fee, and holds to the end.

## Limitations

Every result lists the limitations that apply to it. In short:

- Candles give only each hour's open, high, low and close. The worst-order rules above can be wrong both ways.
- Fills are all-or-nothing at the order's price. Queue position, partial fills and book depth are not modelled.
- Slippage is a fixed percentage. Real slippage depends on liquidity and can be much larger.
- Binance takes a buy's fee in the asset bought, so live exits sell slightly less than the simulator's.
- The strategy acts once an hour, and measures loss limits at each open and close. An exit can come up to an hour late, and a loss can pass a limit within the hour before it is measured.
- Within a candle, resting entries fill first, then each entry's stop or target. Orders never compete for liquidity.
- Equity, drawdown and the Sharpe ratio use hourly closes, so a fall and recovery within an hour does not show, and the Sharpe ratio counts the step across a missing hour as one return.
- A strategy paused by a loss limit stays paused. A customer could resume it.
- The stop-order limit assumes no other orders on the symbol use it.
- Filters are today's and may have differed during the period.
- Perpetuals are not simulated: funding, margin and liquidation are out of scope, so backtests cover spot rules only.
- Past results do not predict future ones, and passing tests is not evidence of profitable trading.

## Tests

`packages/backtest` tests the fill rules, fees, slippage, deadlines, loss limits, stop-order limit, metrics and baseline on small candle sets with hand-worked values. `golden.test.ts` runs a grid, a DCA and the sample fixture over BTCUSDT's recorded candles for 4–10 September 2026 (`fixtures/btcusdt-1h-2026-09-04.json`) and compares every number with `fixtures/golden-runs.json`. After a deliberate change, run it with `UPDATE_GOLDEN=1`, review the diff, and format the file with Prettier.
