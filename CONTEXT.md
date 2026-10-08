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
A customer's account at a crypto exchange, connected to the product for trading.
_Avoid_: Customer when referring to the exchange account

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
A protected entry the AI drafts for the customer to approve or reject. Approval runs every execution check again before the entry is sent, and a proposal is approved at most once, before its entry expiry.
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

**Strategy status**:
A strategy's state as the customer sees it. Running is stored as `simulation` or `active`, by trading mode, and Paused as `paused`. Completed, stored as `retired`, means its rules will open no more entries and it holds none.
_Avoid_: Stopped, finished

**Reserved budget**:
The portion of an allocation committed to pending orders and unavailable for another trade.

**Reconciliation**:
Comparing the product's recorded orders, fills, balances, and positions with the exchange's actual state to resolve discrepancies or unknown outcomes.

**Position ownership**:
The assignment of an instrument's managed position to one strategy within an exchange account, including every protected entry in it. Other strategies must wait or use a separate account.

**Accounting currency**:
The explicitly selected currency used to measure an exchange account's allocations and profit or loss. A display conversion into GBP does not change this currency.

**Standing entry expiry**:
The customer-specified time after which an unfilled standing entry instruction may no longer open a position.

**Strategy version**:
An immutable set of strategy rules. Open positions retain the version under which they were opened; changed versions require simulation before live activation.

**Account handover**:
An explicit transfer of responsibility for remaining positions to the customer when disconnecting, with positions and protective orders disclosed.
