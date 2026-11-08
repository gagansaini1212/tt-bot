import Decimal from "decimal.js";
import type { Instrument } from "./instruments";

export type MistakeKind =
  | "stop_loss"
  | "holding_deadline"
  | "rejected_proposal"
  | "range_stop"
  | "trailing_stop_loss";

export type TradeMistake = {
  id: string;
  instrument: Instrument;
  kind: MistakeKind;
  occurredAt: string;
  strategyId?: string;
  strategyName?: string;
  entryPrice?: string;
  exitPrice?: string;
  lossPercent?: string;
  lossAmountUsdt?: string;
  reason?: string;
  lesson: string;
  adaptiveAction: string;
};

export type AdaptiveCooldown = {
  instrument: Instrument;
  strategyId?: string;
  until: string;
  consecutiveLosses: number;
  reason: string;
};

/**
 * Derives an actionable trading lesson and concrete adaptive defense action
 * based on how the trade failed or was rejected.
 */
export function deriveLesson(
  kind: MistakeKind,
  params: {
    instrument: string;
    entryPrice?: string;
    exitPrice?: string;
    lossPercent?: string;
    reason?: string;
  },
): { lesson: string; adaptiveAction: string } {
  const pair = params.instrument.replace("-", "/");
  switch (kind) {
    case "stop_loss": {
      const lossText = params.lossPercent ? ` (-${params.lossPercent}%)` : "";
      const priceText = params.exitPrice ? ` at ${params.exitPrice}` : "";
      return {
        lesson: `Stop loss was hit on ${pair}${priceText}${lossText}. Entry at ${params.entryPrice ?? "market"} was caught in adverse momentum. Avoid entering near short-term resistance without consolidation or confirmed buy volume.`,
        adaptiveAction: `Enforced a 60-minute cooldown on ${pair}. Downsized subsequent entry capital by 50% to prevent revenge trading.`,
      };
    }
    case "holding_deadline": {
      return {
        lesson: `Holding deadline expired on ${pair} before hitting take-profit target (${params.exitPrice ?? "target"}). Trade stalled in chop or sideways consolidation. Ensure entries align with higher momentum regimes or tighter scalping targets.`,
        adaptiveAction: `Reduced maximum target distances on ${pair} to favor faster profit realization in low-volatility regimes.`,
      };
    }
    case "rejected_proposal": {
      const why = params.reason ? ` (${params.reason})` : "";
      return {
        lesson: `Trade proposal on ${pair} was rejected by the customer${why}. Avoid proposing entries under this setup formation.`,
        adaptiveAction: `AI decision prompt updated with negative reinforcement to exclude similar entry patterns on ${pair}.`,
      };
    }
    case "range_stop": {
      return {
        lesson: `Market price dropped through the lower range stop on ${pair} (${params.exitPrice ?? "stop"}). Strong bearish breakout overwhelmed the grid range.`,
        adaptiveAction: `Grid paused. Automatically require wider level spacing and confirmed trend reversal before re-deploying grid capital.`,
      };
    }
    case "trailing_stop_loss": {
      return {
        lesson: `Market pulled back from peak on ${pair} to trigger trailing stop loss. Position was closed to protect gains and prevent drawdown into negative PnL.`,
        adaptiveAction: `Recorded peak pullback characteristics to refine trailing stop distance against asset volatility.`,
      };
    }
  }
}

/**
 * Dynamically widens the DCA dip requirement by 25% per consecutive loss,
 * preventing the bot from aggressively catching falling knives during a market dump.
 */
export function calculateAdaptiveDipDrop(
  baseDropPercent: string,
  consecutiveLosses: number,
): string {
  if (consecutiveLosses <= 0) return baseDropPercent;
  const multiplier = new Decimal(1).plus(new Decimal(consecutiveLosses).times(0.25));
  return new Decimal(baseDropPercent).times(multiplier).toFixed(2);
}

/**
 * Dynamically scales down entry size after consecutive losses to protect capital.
 * Halves position size per loss (capped at a minimum of 0.25x).
 */
export function calculateAdaptivePositionMultiplier(consecutiveLosses: number): string {
  if (consecutiveLosses <= 0) return "1.0000";
  const factor = new Decimal(0.5).pow(consecutiveLosses);
  return Decimal.max(factor, new Decimal(0.25)).toFixed(4);
}
