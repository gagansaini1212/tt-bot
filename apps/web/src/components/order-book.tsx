import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BookRow, OrderBookView } from "@/lib/order-book";

/**
 * The best `rows` asks and bids, asks highest first so both best prices meet
 * at the spread. A wash behind each row shows its total against the largest
 * total listed.
 */
export function OrderBook({
  book,
  base,
  quote,
  rows,
}: {
  book: OrderBookView;
  base: string;
  quote: string;
  rows: number;
}) {
  const asks = book.asks.slice(0, rows);
  const bids = book.bids.slice(0, rows);
  const askTotals = book.curve.asks.slice(0, rows).map(({ total }) => total);
  const bidTotals = book.curve.bids.slice(0, rows).map(({ total }) => total);
  const largest = Math.max(0, ...askTotals, ...bidTotals);
  const width = (total: number) =>
    largest > 0 ? `${((total / largest) * 100).toFixed(1)}%` : "0%";

  return (
    <Table className="text-xs tabular-nums">
      <caption className="sr-only">
        The {rows} best asks and bids. Total is the cumulative quantity from the
        best price.
      </caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 text-xs">Price ({quote})</TableHead>
          <TableHead className="h-8 text-right text-xs">
            Quantity ({base})
          </TableHead>
          <TableHead className="h-8 text-right text-xs">
            Total ({base})
          </TableHead>
        </TableRow>
      </TableHeader>
      <Side
        label="Asks · sell orders"
        rows={asks
          .map((row, index) => ({ row, width: width(askTotals[index]) }))
          .reverse()}
        wash="var(--market-down-wash)"
      />
      <TableBody>
        <TableRow className="hover:bg-transparent">
          <TableCell className="py-2 text-muted-foreground" colSpan={3}>
            {book.spread ? (
              <>
                Spread{" "}
                <span className="text-foreground">{book.spread.value}</span> (
                {book.spread.percent}%) · Mid{" "}
                <span className="text-foreground">{book.spread.mid}</span>
              </>
            ) : (
              "No spread: one side of the book is empty."
            )}
          </TableCell>
        </TableRow>
      </TableBody>
      <Side
        label="Bids · buy orders"
        rows={bids.map((row, index) => ({
          row,
          width: width(bidTotals[index]),
        }))}
        wash="var(--market-up-wash)"
      />
    </Table>
  );
}

function Side({
  label,
  rows,
  wash,
}: {
  label: string;
  rows: { row: BookRow; width: string }[];
  wash: string;
}) {
  return (
    <TableBody>
      <TableRow className="hover:bg-transparent">
        <TableHead
          className="h-7 text-xs text-muted-foreground"
          colSpan={3}
          scope="rowgroup"
        >
          {label}
        </TableHead>
      </TableRow>
      {rows.map(({ row, width }) => (
        <TableRow
          className="border-0"
          key={row.price}
          style={{
            backgroundImage: `linear-gradient(to left, ${wash} ${width}, transparent ${width})`,
          }}
        >
          <TableCell className="py-1">{row.price}</TableCell>
          <TableCell className="py-1 text-right">{row.quantity}</TableCell>
          <TableCell className="py-1 text-right">{row.total}</TableCell>
        </TableRow>
      ))}
      {rows.length === 0 ? (
        <TableRow className="hover:bg-transparent">
          <TableCell className="py-1 text-muted-foreground" colSpan={3}>
            None
          </TableCell>
        </TableRow>
      ) : null}
    </TableBody>
  );
}
