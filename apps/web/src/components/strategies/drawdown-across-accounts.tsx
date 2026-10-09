import type { CombinedDrawdown } from "@crypto-trading/domain";

import { changeTone, formatAmount, formatChange } from "@/lib/format";
import type { WorkerState } from "@/lib/worker-client";

/**
 * The customer's strategies on all their exchange accounts together since
 * midnight UTC, in the reporting currency. It is shown only: each account's
 * own daily drawdown limit pauses that account's strategies (ADR 0009).
 */
export function DrawdownAcrossAccounts({
  state,
}: {
  state: WorkerState<{ drawdown: CombinedDrawdown; accounts: number }>;
}) {
  if (state.status !== "connected")
    return (
      <p className="border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
        Your strategies across all your exchange accounts cannot be shown now.{" "}
        {state.message}
      </p>
    );
  const { drawdown } = state;
  const { currency } = drawdown;
  const pnl = formatChange(drawdown.pnl);
  return (
    <section
      aria-labelledby="drawdown-across-accounts"
      className="space-y-1 border-t border-border pt-3 text-sm"
    >
      <h3
        className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
        id="drawdown-across-accounts"
      >
        All {state.accounts} trading accounts · {currency}
      </h3>
      {drawdown.counted > 0 ? (
        <p>
          <span className={`font-medium tabular-nums ${changeTone(pnl) ?? ""}`}>
            {pnl} {currency}
          </span>{" "}
          on {formatAmount(drawdown.allocation)} {currency} allocated, a
          drawdown of {formatAmount(drawdown.drawdownPercent)}%
          {drawdown.complete
            ? "."
            : ` across the ${drawdown.counted === 1 ? "account" : `${drawdown.counted} accounts`} counted.`}
        </p>
      ) : (
        <p className="text-muted-foreground">
          No account&apos;s strategies could be counted.
        </p>
      )}
      {drawdown.leftOut.map((account) => (
        <p
          className="text-xs leading-5 text-muted-foreground"
          key={account.exchangeAccountId}
        >
          Not counted: {account.label}. {account.reason}
        </p>
      ))}
      <p className="text-xs leading-5 text-muted-foreground">
        Shown only: this total pauses nothing. Each account&apos;s own daily
        drawdown limit, in its own currency, pauses that account&apos;s
        strategies.
      </p>
    </section>
  );
}
