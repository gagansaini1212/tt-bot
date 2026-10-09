import type { Depth, Kline } from "@crypto-trading/exchanges";

import { CandlestickChart } from "@/components/candlestick-chart";
import { DepthChart } from "@/components/depth-chart";
import styles from "@/components/market-colors.module.css";
import { MarketRefresh } from "@/components/market-refresh";
import { OrderBook } from "@/components/order-book";
import { PageHeader } from "@/components/page-header";
import { SegmentedLinks } from "@/components/segmented-links";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  candlePriceDigits,
  fillMarkers,
  orderLines,
  toCandles,
  type OrderLine,
} from "@/lib/candles";
import { fractionDigits, formatDecimal } from "@/lib/decimals";
import {
  chartIntervals,
  markets,
  marketsHref,
  type MarketSelection,
} from "@/lib/markets";
import { orderBook } from "@/lib/order-book";
import type { TestnetAccountState } from "@/lib/testnet-account";
import type { WorkerState } from "@/lib/worker-client";

// The worker caches depth for 1 s, so the order book and depth chart are at
// most 4 s old. Candles (5 s) and the account (10 s) refresh with the page and
// usually come from the worker's cache.
const MARKETS_REFRESH_SECONDS = 3;
const BOOK_ROWS = 10;

export function MarketsView({
  selection,
  klines,
  depth,
  account,
}: {
  selection: MarketSelection;
  klines: WorkerState<{ klines: Kline[] }>;
  depth: WorkerState<{ depth: Depth }>;
  account: TestnetAccountState;
}) {
  const { market, interval } = selection;
  const book = depth.status === "connected" ? orderBook(depth.depth) : null;
  const depthMessage = depth.status === "connected" ? null : depth.message;
  return (
    <div className={styles.colors}>
      <PageHeader
        action={<MarketRefresh seconds={MARKETS_REFRESH_SECONDS} />}
        description={`Candles, order book, and market depth from Binance Spot Testnet, with your recent fills and open orders marked. Refreshes every ${MARKETS_REFRESH_SECONDS} seconds while this tab is visible.`}
        title="Markets"
      />

      <SegmentedLinks
        className="mt-6"
        items={markets.map((item) => ({
          href: marketsHref({ market: item, interval }),
          label: item.label,
          current: item.instrument === market.instrument,
        }))}
        label="Market"
      />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(340px,1fr)]">
        <PriceCard account={account} klines={klines} selection={selection} />

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Order book</CardTitle>
            <CardDescription className="mt-1">
              The {BOOK_ROWS} best levels on each side. Total is the cumulative
              quantity from the best price.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {book ? (
              <OrderBook
                base={market.base}
                book={book}
                quote="USDT"
                rows={BOOK_ROWS}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{depthMessage}</p>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 xl:col-span-2">
          <CardHeader>
            <CardTitle>Market depth</CardTitle>
            <CardDescription className="mt-1">
              Cumulative {market.base} bid and asked around the mid price, from
              the 100 best levels on each side.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {book ? (
              <DepthChart
                base={market.base}
                curve={book.curve}
                label={market.label}
                mid={book.spread?.mid}
                priceDigits={book.priceDigits}
                quantityDigits={book.quantityDigits}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{depthMessage}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PriceCard({
  selection,
  klines,
  account,
}: {
  selection: MarketSelection;
  klines: WorkerState<{ klines: Kline[] }>;
  account: TestnetAccountState;
}) {
  const { market, interval } = selection;
  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{market.label} price</CardTitle>
            <CardDescription className="mt-1">
              {interval} candles, times in UTC.
            </CardDescription>
          </div>
          <SegmentedLinks
            items={chartIntervals.map((item) => ({
              href: marketsHref({ market, interval: item }),
              label: item,
              current: item === interval,
            }))}
            label="Candle interval"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {klines.status !== "connected" ? (
          <p className="text-sm text-muted-foreground">{klines.message}</p>
        ) : klines.klines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Binance Spot Testnet has no {interval} candles for {market.label}{" "}
            yet.
          </p>
        ) : (
          <Candles
            account={account}
            klines={klines.klines}
            selection={selection}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The chart with the customer's fills and open orders on this market. */
function Candles({
  selection: { market, interval },
  klines,
  account,
}: {
  selection: MarketSelection;
  klines: Kline[];
  account: TestnetAccountState;
}) {
  const priceDigits = candlePriceDigits(klines);
  const connected = account.status === "connected";
  const fills = connected
    ? account.snapshot.fills.filter(
        ({ instrument }) => instrument === market.instrument,
      )
    : [];
  const { markers, outside } = fillMarkers(fills, klines);
  const groups = connected
    ? orderLines(account.snapshot, market.instrument)
    : [];
  const orders = groups.flatMap(({ lines }) => lines);
  const price = (value: string) =>
    formatDecimal(value, Math.max(priceDigits, fractionDigits([value])));
  // "Entry buy 0.002 BTC at 81,000.00", "Stop loss sell triggers at 80,000.00, waiting for entry"
  const describe = (line: OrderLine) =>
    [
      line.label === "Buy" || line.label === "Sell"
        ? line.label
        : `${line.label} ${line.side.toLowerCase()}`,
      line.quantity ? ` ${line.quantity} ${market.base}` : "",
      line.stop ? " triggers at " : " at ",
      price(line.price),
      line.pending ? ", waiting for entry" : "",
    ].join("");

  return (
    <>
      <CandlestickChart
        candles={toCandles(klines)}
        dataKey={`${market.instrument} ${interval}`}
        label={`${market.label} ${interval} candles`}
        markers={markers}
        orders={orders}
        priceDigits={priceDigits}
      />
      {connected ? (
        <div className="space-y-2 text-xs text-muted-foreground">
          {markers.length > 0 || orders.length > 0 ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              <li className="flex items-center gap-1.5">
                <Arrow side="BUY" />
                Your buys
              </li>
              <li className="flex items-center gap-1.5">
                <Arrow side="SELL" />
                Your sells
              </li>
              <li className="flex items-center gap-1.5">
                <span className="w-3 border-t-2 border-dashed border-(--market-up)" />
                <span className="w-3 border-t-2 border-dashed border-(--market-down)" />
                Your open buy and sell orders
              </li>
              {orders.some(({ stop }) => stop) ? (
                <li className="flex items-center gap-1.5">
                  <span className="w-4 border-t-2 border-dotted border-muted-foreground" />
                  Stop triggers
                </li>
              ) : null}
            </ul>
          ) : null}
          <p>{fillSummary(fills.length, outside, market.label)}</p>
          {groups.length === 0 ? (
            <p>No open orders on {market.label}.</p>
          ) : (
            <div>
              <p>Open orders:</p>
              <ul className="mt-1 space-y-1">
                {groups.map(({ key, orderListId, lines }) => (
                  <li key={key}>
                    {orderListId === undefined
                      ? describe(lines[0])
                      : `Order list ${orderListId}: ${lines.map(describe).join(" · ")}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Your fills and open orders are not shown. {account.message}
        </p>
      )}
      {/* The attribution notice the chart library's licence asks for. */}
      <p className="text-xs text-muted-foreground">
        TradingView Lightweight Charts™ Copyright (c) 2025 TradingView, Inc.{" "}
        <a
          className="underline underline-offset-2 hover:text-foreground"
          href="https://www.tradingview.com/"
          rel="noreferrer"
          target="_blank"
        >
          https://www.tradingview.com/
        </a>
      </p>
    </>
  );
}

function fillSummary(count: number, outside: number, label: string) {
  const fills = count === 1 ? "fill" : "fills";
  if (count === 0) return `No recent fills on ${label}.`;
  if (outside === 0)
    return `Your ${count} recent ${label} ${fills} ${count === 1 ? "is" : "are"} marked.`;
  const marked = count - outside;
  return `${marked} of your ${count} recent ${label} ${fills} ${marked === 1 ? "is" : "are"} marked; ${outside} ${outside === 1 ? "falls" : "fall"} outside these candles.`;
}

function Arrow({ side }: { side: "BUY" | "SELL" }) {
  return (
    <svg
      aria-hidden
      className={
        side === "BUY"
          ? "fill-(--market-up)"
          : "rotate-180 fill-(--market-down)"
      }
      height={10}
      viewBox="0 0 10 10"
      width={10}
    >
      <path d="M5 1 9.5 9h-9z" />
    </svg>
  );
}
