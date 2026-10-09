import { instrumentLabel } from "@crypto-trading/domain";
import type { ExchangeFill } from "@crypto-trading/exchanges";

import { Badge } from "@/components/ui/badge";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatAge,
  formatAmount,
  formatDecimal,
  formatUtc,
} from "@/lib/format";
import { fillTotal } from "@/lib/portfolio";

/**
 * Exchange fills, newest first. Ages are measured from `now`, the account
 * snapshot's time, so they match between server and browser and move on
 * with each refresh.
 */
export function FillsTable({
  fills,
  now,
  showFillId = false,
}: {
  fills: ExchangeFill[];
  now: string;
  showFillId?: boolean;
}) {
  const reference = Date.parse(now);
  // A focusable region, so keyboard users can scroll a table wider than the screen.
  return (
    <div
      aria-label="Fills"
      className="relative w-full overflow-x-auto"
      role="region"
      tabIndex={0}
    >
      <table className="w-full caption-bottom text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Market / side</TableHead>
            <TableHead>Quantity</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Total · USDT</TableHead>
            <TableHead>Fee</TableHead>
            <TableHead>Order ID</TableHead>
            {showFillId ? <TableHead>Fill ID</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {fills.map((fill) => {
            const utc = formatUtc(fill.time);
            const total = fillTotal(fill);
            return (
              <TableRow key={`${fill.instrument}-${fill.id}`}>
                <TableCell className="whitespace-nowrap text-xs">
                  <time
                    dateTime={new Date(fill.time).toISOString()}
                    title={utc}
                  >
                    {formatAge(fill.time, reference)}
                  </time>
                  <span className="sr-only">, {utc}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="font-medium">
                    {instrumentLabel(fill.instrument)}
                  </span>
                  <Badge
                    className="ml-2"
                    variant={fill.isBuyer ? "secondary" : "outline"}
                  >
                    {fill.isBuyer ? "BUY" : "SELL"}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {formatDecimal(fill.qty)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {formatDecimal(fill.price, { cents: true })}
                </TableCell>
                <TableCell className="font-mono text-xs" title={total}>
                  {formatAmount(total)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatDecimal(fill.commission)} {fill.commissionAsset}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {fill.orderId}
                </TableCell>
                {showFillId ? (
                  <TableCell className="font-mono text-xs">{fill.id}</TableCell>
                ) : null}
              </TableRow>
            );
          })}
          {fills.length === 0 ? (
            <TableRow>
              <TableCell colSpan={showFillId ? 8 : 7}>No fills yet.</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </table>
    </div>
  );
}
