export const strategies = [
  {
    name: "BTC momentum",
    version: 3,
    status: "Simulating",
    allocated: "6,000",
    used: 42,
    horizon: "6 hours",
  },
  {
    name: "ETH range",
    version: 1,
    status: "Paused",
    allocated: "4,000",
    used: 18,
    horizon: "2 days",
  },
];

export const positions = [
  {
    instrument: "BTC-USDT",
    type: "Spot",
    strategy: "BTC momentum v3",
    quantity: "0.038 BTC",
    entry: "63,142.20",
    price: "64,811.90",
    pnl: "+63.45",
    positive: true,
    deadline: "3h 18m",
  },
  {
    instrument: "ETH-USDT",
    type: "Perpetual · 2×",
    strategy: "ETH range v1",
    quantity: "0.72 ETH",
    entry: "2,641.80",
    price: "2,618.10",
    pnl: "−17.06",
    positive: false,
    deadline: "19h 42m",
  },
];

export const decisions = [
  {
    time: "10:36:18",
    title: "No trade",
    detail: "BTC spread exceeded the strategy entry threshold.",
    tone: "secondary" as const,
  },
  {
    time: "10:31:04",
    title: "Protection checked",
    detail: "Stop and target cover the full BTC filled quantity.",
    tone: "outline" as const,
  },
  {
    time: "10:22:51",
    title: "Proposal rejected",
    detail: "ETH entry would have exceeded available allocation.",
    tone: "destructive" as const,
  },
];

export const fixtureSnapshot = {
  capturedAt: "2026-09-29T10:36:18Z",
  dataKind: "deterministic fixture",
  account: {
    customer: "Alex",
    venue: "Binance mock",
    quoteCurrency: "USDT",
    portfolioValue: "24860.42",
    todaysPnl: "184.20",
    availableAllocation: "6920.00",
    openPositions: 2,
    liveTradingLocked: true,
  },
  positions,
  strategies,
  recentDecisions: decisions,
};
