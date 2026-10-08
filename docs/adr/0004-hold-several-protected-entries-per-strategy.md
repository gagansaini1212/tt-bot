# Hold several protected entries per strategy

Status: accepted, 2026-10-08. Amends the round seven answer "No automatic averaging down or additions to an existing position initially" in [the design interview](../design-interview.md), and the matching line of [the implementation brief](../implementation-brief.md).

Issue #16 asks for grid, DCA and AI signal strategies. The accepted design gave each position a single entry, so no strategy could add to what it held. A strategy may now hold several **protected entries** at once. Each one is an entry order with its own stop loss, take profit and holding deadline, protecting only the quantity it filled. A strategy adds to a position, including buying lower, only by opening another protected entry. Every safety rule applies to each entry and to the strategy as a whole, so adding never removes a stop, borrows allocation or outlasts a loss limit.

## Rules for every strategy kind

- **Protection.** Every entry has a stop loss and a take profit before it is submitted, and its stop protects all the quantity it fills. On an AI-managed strategy, AI may tighten an entry's stop but never loosen or remove it, and may move its target only if the customer allows it. AI never changes the exits of a standing price instruction, a DCA buy or a grid entry: those follow the customer's rules. A stop or target the market has already passed would close the entry at once: that is a close, not a change.
- **Allocation.** A strategy's allocation caps the capital of all its open entries plus the reservations of its pending ones. Each new entry is checked against what the strategy already holds. A version's rules must also fit the allocation. For a standing instruction, DCA or grid, the entries the rules can make, all at once, must cost no more than the allocation. For an AI-managed strategy, the position limit must not exceed it. The total loss limit must not exceed it either.
- **Position limit.** A strategy's position in an instrument is the sum of its entries in it. A new entry may not take that position past the strategy's position limit.
- **Entry limit.** A strategy holds a limited number of protected entries, counting pending and open ones. The limit is the lower of what its rules plan and what the exchange can protect (see below).
- **Loss limits.** Every strategy has a daily and a total loss limit, set as amounts in the accounting currency, with the daily limit no higher than the total. A dashboard may offer them as a percentage of the allocation. Both count realized results, fees, funding, and the unrealized results of open entries. The daily measure is the change since midnight UTC, the calendar day the interview settled rather than a rolling 24 hours, so yesterday's loss is not counted again today. The total runs from the strategy's first trade. Reaching either limit stops new entries, cancels pending entries, attempts to close the strategy's open entries, and pauses the strategy until the customer resumes it. A reached total limit stays reached until the customer raises it in a new version. The worker measures the limits before it plans or submits any entry, and a strategy that cannot be measured opens none. The execution checks do not measure losses themselves: they reject every entry of a paused strategy.
- **Holding deadline.** Each entry's deadline is its own first fill plus the strategy's holding period, which is from 1 minute to 90 days. Later fills of the same entry do not extend it. A new entry has its own deadline.
- **Pause and close all.** Pause cancels pending entries and opens no more, while open entries keep their exits and deadlines. Close all also attempts to close every open entry in its scope. Both leave the strategy paused.
- **Spot.** Spot entries are long and unleveraged. DCA and grid strategies trade spot only. The execution checks reject a proposal in a market kind or direction that the strategy's rules do not allow, so AI cannot open a perpetual short for a spot strategy.
- **Position ownership is unchanged.** One strategy owns an instrument's position per exchange account, and every entry in that position is its own.

The bounds in the schemas are sanity bounds. Platform maximums, set at deployment, may be lower.

## Standing price instruction

From 1 to 10 entries, each priced by the customer with its own stop and target, all sharing one explicit expiry. AI never changes them. An entry that has filled anything is never submitted again. An entry that a pause cancelled before it filled is submitted again, until the expiry.

## AI-managed strategy

This is the issue's "AI Signal bot". AI proposes each protected entry within the customer's instruments, market kind and holding period. Leverage is 1 on spot and at most 10 on perpetuals, and shorts are allowed only on perpetuals when the customer allows them. The strategy holds at most 10 entries at once. Every proposal passes the execution checks before it can trade.

## DCA strategy

- **Schedule.** There are `maxBuys` buys, at most 1,000, one every interval: 1 hour, 4 hours, 12 hours, 1 day or 1 week, starting at `startsAt`. Each buy is due from its own time until the next buy's. A buy that cannot be made while it is due is skipped and never made up. This happens when the strategy is paused, at its entry limit, short of allocation or past a loss limit. The schedule therefore ends `maxBuys` intervals after it starts.
- **Each buy** is a limit buy of `amountPerBuy` at the best ask, and it expires when the next buy is due. Its stop loss and take profit are percentages of its entry price, from 0.1% to 50% for the stop and from 0.1% to 1,000% for the target. Both are rounded up to the price tick, so the stop never risks more than its percentage. If rounding puts the stop or target at the entry price, the buy is skipped.
- **Dip multiplier.** This is optional. If the ask is at least `dropPercent` (0.1% to 50%) below the previous buy's entry price when a buy is due, the buy spends `amountPerBuy × multiplier`. The multiplier is above 1 and at most 2. It never compounds, so a buy on a further dip still spends at most twice `amountPerBuy`.
- **Exposure bound.** `maxBuys × amountPerBuy × multiplier` is what the DCA would hold if every buy were a dip buy and none had exited. It must fit the allocation.

## Grid strategy

- **Grid range and levels.** `levelCount` levels, from 2 to 100, are spaced equally from `lowerPrice` to `upperPrice` at an exact decimal step. Every level below the top is a buy level. A price off the exchange's tick rounds conservatively: the buy down, the target and the range stop up. A level whose rounded stop or target reaches its buy price is not traded.
- **A sell at one level is the take profit of the buy at the level below it.** A buy at level i is a protected entry spending `amountPerLevel` that takes profit at level i + 1. Once it closes, level i is free to buy again.
- **Buys rest only below the market.** The grid places buys at free levels strictly below the price, nearest first. It never buys at or above the market, so it starts holding nothing. It never buys up front to stock the upper levels, and never sells what it has not bought.
- **Range stop.** A single stop price below the lowest level is every grid entry's stop loss. When the market reaches it, the grid cancels its pending entries, closes whatever remains, and completes. Leaving the range upwards does the same: by then every level's take profit should have filled, and the grid cancels its resting buys, closes anything left, and completes instead of waiting for the price to return. To trade a new range, the customer creates a new version, which returns to simulation before live activation like any edit. A grid should be activated only while the market is inside its range.
- **Expiry.** The grid opens no entries after `entryExpiresAt`.
- **Exposure bound.** `(levelCount − 1) × amountPerLevel` is what the grid holds with every buy level filled at once. It must fit the allocation.

## The exchange's stop-order limit

Binance Spot lets an account hold at most a few open stop orders on a symbol. This is the `MAX_NUM_ALGO_ORDERS` filter in the [official filters documentation](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md#max_num_algo_orders), and it was 5 for BTCUSDT on the testnet on 2026-10-08. Each protected entry's stop is one such order, so an account can protect at most 5 entries per symbol at once, including any manual orders on that symbol. The worker sets a strategy's entry limit to the lower of its rules' limit and the exchange's. A grid or DCA waits instead of submitting an entry it could not protect. So a grid wider than five levels rests buys at the five nearest levels below the market, and a DCA whose earlier buys are all still open skips buys until one exits.

## Strategy status

The issue's badges map onto the stored statuses. **Running** is `simulation` or `active`, **Paused** is `paused`, and **Completed** is `retired`. A strategy completes once its rules will open no more entries and it holds no open ones. Its rules stop opening entries when a standing instruction or grid expires, a DCA schedule ends, a range stop is reached, or the market leaves a grid's range. Until it holds nothing, the strategy is running and its open entries keep their exits.

## Considered options

- **One stop for all of a DCA's or grid's holdings.** This fits the exchange's stop-order limit. But each entry would lose its own deadline and target, and Binance locks the quantity of every resting sell order, so one resting stop and per-level take profits could not both hold the same coins. Rejected, because the customer's definition gives every DCA buy its own protection.
- **Stops held by the worker instead of the exchange.** This avoids the exchange limit, but protection would depend on the worker running. Rejected for the same reason ADR 0002 keeps protection independent of AI calls.
- **A grid that buys inventory for its upper levels up front, or sells short on perpetuals.** Grid products elsewhere often do this, but it holds unprotected inventory or adds short exposure. Rejected for now.
- **Making up skipped DCA buys, or a compounding dip multiplier.** Both turn a drawdown into a burst of larger buys. Rejected.
- **Geometric grid spacing.** Its levels are not exact decimals. Left out.

## Consequences

Holding deadlines, reservations and exits attach to protected entries rather than positions, and a position's notional is the sum of its entries. `strategy_versions.rules` stores one of the four rule schemas in `packages/domain/src/strategy-rules.ts`. That module also derives the execution policy's limits and checks the rules against the allocation. The planners `planStandingEntries`, `planDcaBuy` and `planGridEntries` say what to submit next. Every intent still passes `authorizeTradeProposal`, and `lossLimitStatus` decides whether the strategy may open entries at all.
