import type {
  Instrument,
  MarketKind,
  TradeDirection,
  TradeProposal,
} from "./trading";

/** The exchange's price tick and quantity step for an instrument. */
export type InstrumentSteps = { tickSize: string; quantityStep: string };

/**
 * A protected entry a strategy's rules want submitted: the entry order and the
 * exits that protect whatever it fills. The holding deadline is the entry's
 * first fill plus holdingPeriodSeconds.
 */
export type EntryIntent = {
  // What the entry fills within the rules: a standing entry, DCA buy or grid
  // level. A strategy holds at most one unclosed entry per key.
  key: string;
  instrument: Instrument;
  marketKind: MarketKind;
  direction: TradeDirection;
  leverage: number;
  quantity: string;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  entryExpiresAt: string;
  holdingPeriodSeconds: number;
};

/**
 * What a running strategy should do next. Planning assumes the strategy is
 * running: a paused strategy opens nothing, and every intent still passes the
 * execution checks before it can trade.
 *
 * - `enter`: submit these entries, in this order.
 * - `wait`: nothing to submit now. `until` is when the plan next changes if
 *   nothing else does. `unprotectable` means the rules' next entry cannot be
 *   protected: its amount buys less than one quantity step, or rounding to the
 *   tick leaves its stop or target at the entry price.
 * - `no_more_entries`: the rules open no more entries. Open entries keep their
 *   exits and deadlines, and the strategy is completed once none remain.
 * - `close_and_complete`: the market left a grid's range. Cancel pending
 *   entries, close open entries, and complete the strategy.
 */
export type EntryPlan =
  | { action: "enter"; intents: EntryIntent[] }
  | {
      action: "wait";
      reason:
        | "not_started"
        | "buy_made"
        | "entry_limit"
        | "entries_pending"
        | "no_free_level"
        | "unprotectable";
      until?: string;
    }
  | {
      action: "no_more_entries";
      reason: "expired" | "schedule_complete" | "all_entries_filled";
    }
  | { action: "close_and_complete"; reason: "range_stop" | "above_range" };

/** The trade proposal that submits an intent, for `authorizeTradeProposal`. */
export function entryIntentProposal(
  intent: EntryIntent,
  context: Pick<
    TradeProposal,
    | "proposalId"
    | "customerId"
    | "exchangeAccountId"
    | "strategyId"
    | "strategyVersion"
    | "sourceSnapshotId"
    | "rationale"
  >,
): TradeProposal {
  return {
    ...context,
    instrument: intent.instrument,
    marketKind: intent.marketKind,
    direction: intent.direction,
    quantity: intent.quantity,
    entryPrice: intent.entryPrice,
    stopLossPrice: intent.stopLossPrice,
    takeProfitPrice: intent.takeProfitPrice,
    leverage: intent.leverage,
    entryExpiresAt: intent.entryExpiresAt,
  };
}
