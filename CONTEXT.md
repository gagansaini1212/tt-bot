# Crypto trading

Customers connect their own exchange accounts and authorize automated trading within configured limits.

## Language

**Customer**:
A person or organization using the product to trade through their own exchange accounts.
_Avoid_: Account when referring to the customer

**Login**:
An email and password that signs a person in to act for one customer. A customer may have several.
_Avoid_: User, account

**Exchange account**:
A customer's account at one venue, connected to the product. Its capital and positions never fund or offset another exchange account's.
_Avoid_: Customer when referring to the exchange account

**Read-only exchange account**:
An exchange account on a venue the product can only read, such as HTX in M4. It is monitored, but never the target of a strategy, proposal or order, and its keys must not allow trading or withdrawals.
_Avoid_: Paused account, disconnected account

**Transfer**:
Moving funds between exchange accounts. The product never makes one, and it is never trading profit or loss.
_Avoid_: Rebalance

**Venue**:
A crypto exchange the product connects to through an adapter, such as Binance Spot Testnet or HTX, with its own markets, rules, credentials and limits.
_Avoid_: Provider, exchange when meaning a specific connection

**Instrument**:
The venue-neutral name of what is traded, written BASE-QUOTE, such as BTC-USDT.
_Avoid_: Symbol

**Market**:
One instrument as one venue trades it, with that venue's price tick, quantity step and minimum order. BTC-USDT on Binance and BTC-USDT on HTX are two markets.
_Avoid_: Pair when the venue matters

**Venue symbol**:
The name a venue's API uses for a market, such as `BTCUSDT` on Binance or `btcusdt` on HTX. Only adapters use it.
_Avoid_: Symbol alone, ticker

**Market catalogue**:
A venue's list of markets, with each market's venue symbol and trading rules, as last read from the venue.
_Avoid_: Exchange info, symbol list

**Live trading**:
Trading that submits real orders to a connected exchange account and uses real funds.

**Simulated trading**:
Trading with simulated orders and funds, without placing real orders in a customer's exchange account.
_Avoid_: Live trading

**Allocation**:
The total capital a customer makes available for trading across simultaneous trades, assigned per exchange account and then per strategy. A strategy's allocation caps all its protected entries together, open and pending. Strategies cannot borrow another strategy's allocation, and simulation has a separate balance.
_Avoid_: Per-trade budget, loss limit

**Protected entry**:
An entry order together with the stop loss, take profit and holding deadline that protect the quantity it fills. A strategy may hold several at once, and its position in an instrument is the sum of its protected entries there.
_Avoid_: Safety order, averaging down

**AI decision**:
The recorded conclusion of one AI analysis: a trade proposal or no trade, with the model, prompt version, input snapshot and rationale that produced it.

**Trade proposal**:
A protected entry the AI drafts on one exchange account for the customer to approve or reject. Approval runs every execution check again before the entry is sent, and a proposal is approved at most once, before its entry expiry.
_Avoid_: Signal, recommendation

**Standing price instruction**:
A customer's instruction to buy or sell a specified amount at a specified price, without allowing AI to silently override that instruction. It may list several protected entries, which expire together.
_Avoid_: AI-managed trade

**AI-managed trade**:
A trade whose asset, entry, size, and exit the AI proposes within customer-selected assets, horizons, and trading limits.

**AI-managed strategy**:
A strategy whose protected entries are AI-managed trades, proposed by AI and checked against the strategy's limits before each one can trade.
_Avoid_: AI Signal bot, signal bot

**DCA strategy**:
A spot strategy that buys a fixed amount on a schedule, up to a maximum number of buys. Each buy is a separate protected entry, and a buy that cannot be made while due is skipped.
_Avoid_: DCA bot, recurring buy

**Dip multiplier**:
A capped factor by which a DCA strategy raises a buy when the price is a set percentage below the previous buy's entry price. It never compounds.
_Avoid_: Safety order, martingale

**Grid strategy**:
A spot strategy that rests buys at the grid levels below the market within a grid range. Each buy is a protected entry that takes profit at the next level up.
_Avoid_: Grid bot

**Grid range**:
The prices from a grid strategy's lower price to its upper price. The market rising above it, or falling to its range stop, ends the strategy.

**Grid level**:
One of the equally spaced prices across a grid range. Each level below the top is where the grid buys, and the level above it is where that buy takes profit.

**Range stop**:
The single stop loss below a grid range that protects every entry of the grid strategy. Reaching it closes the strategy's entries and completes the strategy.
_Avoid_: Grid stop loss

**Strategy horizon**:
The customer-selected maximum holding period for each of a strategy's protected entries, starting at that entry's first fill. Later fills of the same entry do not extend it; reaching the deadline triggers exit and cancellation of any unfilled entry remainder.

**Loss limit**:
A threshold that includes realized and unrealized losses, fees, and funding costs. Every strategy has a daily limit, measured since midnight UTC, and a total limit. Reaching either stops new entries, cancels pending entries, triggers attempts to close the strategy's protected entries, and pauses the strategy; it does not guarantee a maximum loss.
_Avoid_: Allocation

**Stop loss**:
A required protective exit instruction for a trade. AI may tighten it but cannot remove it or loosen it to accept a larger loss.

**Take profit**:
A required target exit instruction for a trade. The customer controls whether AI may change its target.

**Platform maximum**:
A product-enforced upper bound on a customer-configurable trading limit. AI may suggest changes to limits but cannot apply them.

**Pause**:
A trading state that stops new entries and cancels pending entries while maintaining protective exits and holding deadlines. A DCA buy that falls due during a pause is skipped.
_Avoid_: Close all

**Close all**:
A customer action that pauses entries and attempts to close all managed positions within its selected scope, every open protected entry included.
_Avoid_: Pause

**Kill switch**:
A customer action that pauses every strategy on an exchange account and runs close all for every managed position there, the customer's own protected entries included.
_Avoid_: Panic button, emergency stop

**Daily drawdown limit**:
A customer-set percentage of the allocations of all their strategies on an exchange account. When the strategies together lose it since midnight UTC, counting what each strategy's loss limits count, every strategy on that account is paused until the customer resumes it.
_Avoid_: Loss limit when referring to the portfolio

**Strategy status**:
A strategy's state as the customer sees it. Running is stored as `simulation` or `active`, by trading mode, and Paused as `paused`. Completed, stored as `retired`, means its rules will open no more entries and it holds none.
_Avoid_: Stopped, finished

**Reserved budget**:
The portion of an allocation committed to pending orders and unavailable for another trade.

**Reconciliation**:
Comparing the product's recorded orders, fills, balances, and positions with the exchange's actual state to resolve discrepancies or unknown outcomes.

**Position ownership**:
The assignment of an instrument's managed position to one strategy within an exchange account, including every protected entry in it. Other strategies must wait or use a separate account, and positions on separate accounts are never netted.

**Accounting currency**:
The explicitly selected currency used to measure an exchange account's allocations, profit or loss, and limits. Conversion into the reporting currency does not change it.
_Avoid_: Reporting currency

**Reporting currency**:
The one currency a customer chooses, USDT by default, for displaying amounts and adding them up across exchange accounts. It never changes an allocation, a limit or an execution check.
_Avoid_: Accounting currency, base currency

**Conversion route**:
The direct market, or two markets through USDT or USDC, on an exchange account's own venue whose prices convert its amounts into the reporting currency. When the route is missing or its prices are stale, the amount is shown unconverted, never as zero.
_Avoid_: FX rate, exchange rate

**Standing entry expiry**:
The customer-specified time after which an unfilled standing entry instruction may no longer open a position.

**Strategy version**:
An immutable set of strategy rules. Open positions retain the version under which they were opened; changed versions require simulation before live activation.

**Disconnection**:
Removing an exchange account from the product. Its keys are deleted and it is never read or traded again, while its history stays. It requires closure of everything the product manages there, or an account handover.
_Avoid_: Deleting an account

**Account handover**:
An explicit transfer of responsibility for remaining positions to the customer when disconnecting, with positions and protective orders disclosed.
