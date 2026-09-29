# Crypto trading

Customers connect their own exchange accounts and authorize automated trading within configured limits.

## Language

**Customer**:
A person or organization using the product to trade through their own exchange accounts.
_Avoid_: Account when referring to the customer

**Exchange account**:
A customer's account at a crypto exchange, connected to the product for trading.
_Avoid_: Customer when referring to the exchange account

**Live trading**:
Trading that submits real orders to a connected exchange account and uses real funds.

**Simulated trading**:
Trading with simulated orders and funds, without placing real orders in a customer's exchange account.
_Avoid_: Live trading

**Allocation**:
The total capital a customer makes available for trading across simultaneous trades, assigned per exchange account and then per strategy. Strategies cannot borrow another strategy's allocation, and simulation has a separate balance.
_Avoid_: Per-trade budget, loss limit

**Standing price instruction**:
A customer's instruction to buy or sell a specified amount at a specified price, without allowing AI to silently override that instruction.
_Avoid_: AI-managed trade

**AI-managed trade**:
A trade whose asset, entry, size, and exit the AI proposes within customer-selected assets, horizons, and trading limits.

**Strategy horizon**:
The customer-selected maximum holding period for a strategy, starting at the first fill. Later fills do not extend it; reaching the deadline triggers exit and cancellation of any unfilled entry remainder.

**Loss limit**:
A threshold that includes realized and unrealized losses, fees, and funding costs. Reaching it stops new entries, cancels pending entries, and triggers attempts to close affected positions; it does not guarantee a maximum loss.
_Avoid_: Allocation

**Stop loss**:
A required protective exit instruction for a trade. AI may tighten it but cannot remove it or loosen it to accept a larger loss.

**Take profit**:
A required target exit instruction for a trade. The customer controls whether AI may change its target.

**Platform maximum**:
A product-enforced upper bound on a customer-configurable trading limit. AI may suggest changes to limits but cannot apply them.

**Pause**:
A trading state that stops new entries and cancels pending entries while maintaining protective exits and holding deadlines.
_Avoid_: Close all

**Close all**:
A customer action that pauses entries and attempts to close all managed positions within its selected scope.
_Avoid_: Pause

**Reserved budget**:
The portion of an allocation committed to pending orders and unavailable for another trade.

**Reconciliation**:
Comparing the product's recorded orders, fills, balances, and positions with the exchange's actual state to resolve discrepancies or unknown outcomes.

**Position ownership**:
The assignment of an instrument's managed position to one strategy within an exchange account. Other strategies must wait or use a separate account.

**Accounting currency**:
The explicitly selected currency used to measure an exchange account's allocations and profit or loss. A display conversion into GBP does not change this currency.

**Standing entry expiry**:
The customer-specified time after which an unfilled standing entry instruction may no longer open a position.

**Strategy version**:
An immutable set of strategy rules. Open positions retain the version under which they were opened; changed versions require simulation before live activation.

**Account handover**:
An explicit transfer of responsibility for remaining positions to the customer when disconnecting, with positions and protective orders disclosed.
