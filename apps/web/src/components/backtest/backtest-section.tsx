import { BacktestRunner } from "@/components/backtest/backtest-runner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** The Strategies page's backtest runner, self-contained. */
export function BacktestSection() {
  return (
    <Card aria-labelledby="backtest-title" className="mt-6" role="region">
      <CardHeader>
        <CardTitle>
          <h2 id="backtest-title">Backtest</h2>
        </CardTitle>
        <CardDescription className="mt-1">
          Replay a strategy&apos;s rules over up to 30 days of hourly candles,
          with the same entry planners, execution checks and loss limits as a
          live strategy. History comes from Binance&apos;s public spot market;
          nothing is traded.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <BacktestRunner />
      </CardContent>
    </Card>
  );
}
