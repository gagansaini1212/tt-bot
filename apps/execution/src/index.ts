import { authorizeTradeProposal } from "@crypto-trading/domain";

export { authorizeTradeProposal };

const liveTradingEnabled = process.env.LIVE_TRADING_ENABLED === "true";

if (liveTradingEnabled) {
  throw new Error(
    "Live trading cannot start until deployment prerequisites and account eligibility checks are implemented.",
  );
}

console.info("Execution worker ready in simulation-only mode.");
