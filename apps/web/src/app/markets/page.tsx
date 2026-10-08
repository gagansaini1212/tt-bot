import type { Metadata } from "next";

import { MarketsView } from "@/components/markets-view";
import { getMarketDepth, getMarketKlines } from "@/lib/market-data";
import { parseMarketSelection } from "@/lib/markets";
import { getTestnetAccount } from "@/lib/testnet-account";

export const metadata: Metadata = { title: "Markets" };
export const dynamic = "force-dynamic";

// Enough history for the chart; the testnet often holds less.
const CANDLE_LIMIT = 300;

export default async function MarketsPage({
  searchParams,
}: PageProps<"/markets">) {
  const selection = parseMarketSelection(await searchParams);
  const [klines, depth, account] = await Promise.all([
    getMarketKlines(
      selection.market.instrument,
      selection.interval,
      CANDLE_LIMIT,
    ),
    getMarketDepth(selection.market.instrument),
    getTestnetAccount(),
  ]);
  return (
    <MarketsView
      account={account}
      depth={depth}
      klines={klines}
      selection={selection}
    />
  );
}
