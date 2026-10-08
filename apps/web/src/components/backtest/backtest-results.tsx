import type { ReactNode } from "react";
import { FlaskConical, Info } from "lucide-react";
import Decimal from "decimal.js";
import type { BacktestResult } from "@crypto-trading/backtest";

import { EquityChart } from "@/components/backtest/equity-chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  dailyEquity,
  entryName,
  EXIT_REASONS,
  formatHour,
  formatPercentage,
  formatPeriod,
  formatPriceText,
  formatQuantity,
  formatSigned,
  formatUsdt,
  REJECTION_LABELS,
  STATE_LABELS,
} from "@/lib/backtest-display";
import { formatDecimal } from "@/lib/decimals";
import { changeTone } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<BacktestResult["strategyKind"], string> = {
  grid: "Grid",
  dca: "DCA",
  standing_price_instruction: "Price instruction",
  ai_managed: "AI-managed",
};

export function BacktestResults({ result }: { result: BacktestResult }) {
  const pair = result.instrument.replace("-", "/");
  const base = result.instrument.split("-")[0];
  const { metrics, baseline } = result;
  return (
    <section aria-labelledby="backtest-result" className="space-y-6">
      {result.fixture ? (
        <Alert>
          <FlaskConical />
          <AlertTitle>Recorded fixture, not AI performance</AlertTitle>
          <AlertDescription>
            {result.fixture.title}. {result.fixture.provenance}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold" id="backtest-result">
            {KIND_LABELS[result.strategyKind]} on {pair}
          </h3>
          <p className="text-sm text-muted-foreground">
            {formatPeriod(result.period)} · {result.candles} hourly candles ·
            Allocation {formatUsdt(result.allocation)} USDT
          </p>
        </div>
        <Badge variant="outline">{STATE_LABELS[result.state]}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          detail={`${formatPercentage(metrics.returnPercent)} · realized ${formatSigned(metrics.realizedPnl)}, open ${formatSigned(metrics.unrealizedPnl)}`}
          label="Net PnL"
          tone
          value={formatSigned(metrics.netPnl)}
          unit="USDT"
        />
        <Stat
          detail={`${formatPercentage(baseline.returnPercent)} · ${formatQuantity(baseline.quantity)} ${base} bought at ${formatPriceText(baseline.entryPrice)}`}
          label="Buy and hold"
          tone
          value={formatSigned(baseline.netPnl)}
          unit="USDT"
        />
        <Stat
          detail={
            metrics.maxDrawdown.troughAt === undefined
              ? "Equity never fell below an earlier peak."
              : `${formatUsdt(metrics.maxDrawdown.amount)} USDT, to ${formatHour(metrics.maxDrawdown.troughAt)} UTC. Buy and hold: ${formatPercentage(baseline.maxDrawdown.percent, { unsigned: true })}`
          }
          label="Maximum drawdown"
          value={formatPercentage(metrics.maxDrawdown.percent, {
            unsigned: true,
          })}
        />
        <Stat
          detail={`Mean hourly return over its standard deviation, × √${metrics.sharpe.periodsPerYear.toLocaleString("en-US")} hours a year. Risk-free rate ${metrics.sharpe.riskFreeRatePercent}%.`}
          label="Sharpe ratio"
          value={
            metrics.sharpe.value === null
              ? "–"
              : new Decimal(metrics.sharpe.value).toFixed(2)
          }
        />
        <Stat
          detail={
            metrics.trades.closed === 0
              ? "No trade has closed."
              : `${metrics.trades.wins} won, ${metrics.trades.losses} lost${metrics.trades.breakeven ? `, ${metrics.trades.breakeven} even` : ""}. Loss rate ${formatPercentage(metrics.trades.lossRate!, { unsigned: true })}`
          }
          label="Win rate"
          value={
            metrics.trades.winRate === null
              ? "–"
              : formatPercentage(metrics.trades.winRate, { unsigned: true })
          }
        />
        <Stat
          detail={`${metrics.trades.closed} closed, ${metrics.trades.open} open at the end`}
          label="Trades"
          value={String(metrics.trades.trades)}
        />
        <Stat
          detail={`Maker ${result.assumptions.makerFeePercent}%, taker ${result.assumptions.takerFeePercent}%, in USDT`}
          label="Fees"
          value={formatUsdt(metrics.fees)}
          unit="USDT"
        />
        <Stat
          detail={`The lower of the rules' limit and Binance's ${result.market.maxStopOrders} open stop orders per symbol`}
          label="Entries at once"
          value={String(result.entryLimit)}
        />
      </dl>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Equity</CardTitle>
          <CardDescription className="mt-1">
            The strategy&apos;s cash and open entries at each hourly close,
            against buying {base} with the whole allocation at the first open.
            Times in UTC.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <EquityChart
            allocation={result.allocation}
            equity={result.equity}
            label={pair}
          />
          <EquityTable result={result} />
        </CardContent>
      </Card>

      {result.notices.length > 0 ||
      Object.keys(result.rejections).length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>What happened</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {result.notices.map((notice, index) => (
                <li className="flex gap-3" key={index}>
                  <span className="w-28 shrink-0 text-muted-foreground tabular-nums">
                    {formatHour(notice.at)}
                  </span>
                  <span>{notice.message}</span>
                </li>
              ))}
            </ul>
            {Object.keys(result.rejections).length > 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Turned away by the execution checks or the exchange&apos;s
                filters:{" "}
                {Object.entries(result.rejections)
                  .map(
                    ([code, count]) =>
                      `${REJECTION_LABELS[code] ?? code} (${count})`,
                  )
                  .join(", ")}
                .
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Trades</CardTitle>
          <CardDescription className="mt-1">
            Every entry that filled, in the order it filled. Times are the
            hourly candle it happened in, in UTC. Open entries are valued at the
            last close.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {result.trades.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No entry filled during the period.
            </p>
          ) : (
            <TradesTable result={result} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assumptions and limitations</CardTitle>
          <CardDescription className="mt-1">
            A backtest is a simulation over past candles, not a forecast.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            <Assumption label="Fees">
              {result.assumptions.makerFeePercent}% maker,{" "}
              {result.assumptions.takerFeePercent}% taker
            </Assumption>
            <Assumption label="Slippage on taker fills">
              {result.assumptions.slippagePercent}%
            </Assumption>
            <Assumption label="Sharpe ratio">
              Hourly returns, × √{metrics.sharpe.periodsPerYear} (24 × 365),
              risk-free rate {metrics.sharpe.riskFreeRatePercent}% a year
            </Assumption>
            <Assumption label="Filters">
              Tick {result.market.tickSize}, step {result.market.stepSize},
              minimum {result.market.minNotional} USDT
            </Assumption>
          </dl>
          <ul className="space-y-2">
            {result.limitations.map((limitation) => (
              <li className="flex gap-2" key={limitation}>
                <Info
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span>{limitation}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}

function Stat({
  label,
  value,
  unit,
  detail,
  tone = false,
}: {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  tone?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1">
        <span
          className={cn(
            "text-xl font-semibold",
            tone ? changeTone(value) : undefined,
          )}
        >
          {value}
        </span>
        {unit ? (
          <span className="ml-1 text-xs text-muted-foreground">{unit}</span>
        ) : null}
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </dd>
    </div>
  );
}

function Assumption({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function EquityTable({ result }: { result: BacktestResult }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Show equity as a table
      </summary>
      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead>Time (UTC)</TableHead>
            <TableHead className="text-right">Strategy</TableHead>
            <TableHead className="text-right">Buy and hold</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dailyEquity(result).map((point) => (
            <TableRow key={point.time}>
              <TableCell>{formatHour(point.time)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUsdt(point.strategy)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUsdt(point.baseline)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </details>
  );
}

function TradesTable({ result }: { result: BacktestResult }) {
  const base = result.instrument.split("-")[0];
  // Scrolls sideways on narrow screens, so it takes keyboard focus.
  return (
    <div
      aria-label="Trades"
      className="relative w-full overflow-x-auto rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      role="region"
      tabIndex={0}
    >
      <table className="w-full caption-bottom text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>Entry</TableHead>
            <TableHead>Opened</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Quantity</TableHead>
            <TableHead className="text-right">Stop / target</TableHead>
            <TableHead>Closed</TableHead>
            <TableHead className="text-right">Exit price</TableHead>
            <TableHead className="text-right">Fees</TableHead>
            <TableHead className="text-right">PnL</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.trades.map((trade, index) => {
            const pnl = formatSigned(trade.pnl);
            return (
              <TableRow key={`${trade.key} ${index}`}>
                <TableCell className="font-medium">
                  {entryName(trade.key)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatHour(trade.entryAt)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatPriceText(trade.entryPrice)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatQuantity(trade.quantity)} {base}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatPriceText(trade.stopLossPrice)} /{" "}
                  {formatPriceText(trade.takeProfitPrice)}
                </TableCell>
                <TableCell>
                  {trade.exit ? (
                    <>
                      <span className="tabular-nums">
                        {formatHour(trade.exit.at)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {EXIT_REASONS[trade.exit.reason]}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      Open at the end
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {trade.exit ? formatPriceText(trade.exit.price) : "–"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatDecimal(trade.fees, 4)}
                </TableCell>
                <TableCell
                  className={cn("text-right tabular-nums", changeTone(pnl))}
                >
                  {pnl}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </table>
    </div>
  );
}
