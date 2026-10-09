import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessEntry,
  EXIT_PLACEMENT_GRACE_MS,
  type EntryObservation,
  type LegState,
} from "./entry-assessment";

const now = new Date("2026-10-08T12:00:00Z");
const leg = (
  suffix: string,
  status: string,
  origQty: string,
  executedQty = "0",
): LegState => ({
  clientOrderId: `ct_a_${suffix}`,
  orderId: "1",
  orderListId: "7",
  status,
  origQty,
  executedQty,
});
const observe = (changes: Partial<EntryObservation>): EntryObservation => ({
  entry: leg("en", "NEW", "0.001"),
  closes: [],
  baseFee: "0",
  stepSize: "0.00001",
  lastFillAt: null,
  stopLossPrice: "58000",
  customerAccepted: null,
  exitReason: null,
  now,
  ...changes,
});
const filled = leg("en", "FILLED", "0.001", "0.001");

test("an entry on the book holds nothing, or what has filled until it fills completely", () => {
  assert.equal(assessEntry(observe({})).state, "working");
  const partial = assessEntry(
    observe({
      entry: leg("en", "PARTIALLY_FILLED", "0.001", "0.0004"),
      baseFee: "0.0000004",
      lastPrice: "59000",
    }),
  );
  assert.equal(partial.state, "partly_filled");
  assert.equal(partial.held, "0.0003996");
  assert.equal(partial.exitReason, null);
});

test("a partly filled entry whose market reaches its stop loss is cancelled, then sold", () => {
  const reached = assessEntry(
    observe({
      entry: leg("en", "PARTIALLY_FILLED", "0.001", "0.0004"),
      lastPrice: "58000",
    }),
  );
  assert.equal(reached.exitReason, "stop_loss");
  assert.equal(reached.cancelList, true);
  assert.equal(reached.sell, undefined);
  const cancelled = assessEntry(
    observe({
      entry: leg("en", "CANCELED", "0.001", "0.0004"),
      exitReason: "stop_loss",
    }),
  );
  assert.equal(cancelled.state, "exiting");
  assert.equal(cancelled.sell, "0.0004");
});

test("a filled entry is protected when its stop loss covers what it holds", () => {
  const verdict = assessEntry(
    observe({
      entry: filled,
      takeProfit: leg("tp", "NEW", "0.00099"),
      stopLoss: leg("sl", "NEW", "0.00099"),
    }),
  );
  assert.equal(verdict.state, "protected");
  assert.equal(verdict.held, "0.00099");
});

test("exits Binance has not placed yet are awaited briefly, then treated as missing", () => {
  const pending = observe({
    entry: filled,
    takeProfit: leg("tp", "PENDING_NEW", "0"),
    stopLoss: leg("sl", "PENDING_NEW", "0"),
    baseFee: "0.000001",
    lastFillAt: new Date(now.getTime() - 5_000),
  });
  assert.equal(assessEntry(pending).state, "awaiting_exits");
  const late = assessEntry({
    ...pending,
    lastFillAt: new Date(now.getTime() - EXIT_PLACEMENT_GRACE_MS),
  });
  assert.equal(late.state, "unprotected");
  // The list is still executing, so it is cancelled before anything is sold.
  assert.equal(late.cancelList, true);
  assert.equal(late.sell, undefined);
});

test("dropped or missing exits leave the filled quantity unprotected, to be sold", () => {
  for (const [takeProfit, stopLoss] of [
    [leg("tp", "EXPIRED", "0.00099"), leg("sl", "EXPIRED", "0.00099")],
    [leg("tp", "REJECTED", "0"), leg("sl", "REJECTED", "0")],
    [leg("tp", "MISSING", "0"), leg("sl", "MISSING", "0")],
    // A take profit without its stop loss does not protect.
    [leg("tp", "NEW", "0.00099"), leg("sl", "CANCELED", "0.00099")],
  ]) {
    const verdict = assessEntry(
      observe({ entry: filled, takeProfit, stopLoss, baseFee: "0.000001" }),
    );
    assert.equal(verdict.state, "unprotected", takeProfit.status);
    assert.equal(verdict.exitReason, "protection_failed");
    assert.match(verdict.finding, /did not keep its exits/);
  }
  const dropped = assessEntry(
    observe({
      entry: filled,
      takeProfit: leg("tp", "EXPIRED", "0.00099"),
      stopLoss: leg("sl", "EXPIRED", "0.00099"),
    }),
  );
  assert.equal(dropped.sell, "0.00099");
  assert.equal(dropped.cancelList, false);
});

test("a partly filled entry cancelled elsewhere is unprotected; from the dashboard it is handed over", () => {
  const cancelled = observe({
    entry: leg("en", "CANCELED", "0.001", "0.0004"),
    baseFee: "0.0000004",
  });
  const verdict = assessEntry(cancelled);
  assert.equal(verdict.state, "unprotected");
  assert.equal(verdict.sell, "0.0003996");
  assert.match(verdict.finding, /canceled after 0.0004 filled/);
  assert.equal(
    assessEntry({ ...cancelled, customerAccepted: "0.0004" }).state,
    "handed_over",
  );
  // More filled than the customer accepted: protection failure after all.
  assert.equal(
    assessEntry({
      ...cancelled,
      entry: leg("en", "CANCELED", "0.001", "0.0008"),
      customerAccepted: "0.0004",
    }).state,
    "unprotected",
  );
  // The same for a filled entry whose exits the customer cancelled.
  assert.equal(
    assessEntry(
      observe({
        entry: filled,
        takeProfit: leg("tp", "CANCELED", "0.00099"),
        stopLoss: leg("sl", "CANCELED", "0.00099"),
        customerAccepted: "0.00099",
      }),
    ).state,
    "handed_over",
  );
});

test("a take profit that partly filled after Binance cancelled the stop loss is finished at market", () => {
  const verdict = assessEntry(
    observe({
      entry: filled,
      takeProfit: leg("tp", "PARTIALLY_FILLED", "0.00099", "0.0005"),
      stopLoss: leg("sl", "CANCELED", "0.00099"),
    }),
  );
  assert.equal(verdict.state, "exiting");
  assert.equal(verdict.exitReason, "take_profit");
  assert.equal(verdict.held, "0.00049");
  assert.equal(verdict.cancelList, true);
});

test("an exit under way waits for a sale in flight and closes once nothing is held", () => {
  const exiting = observe({
    entry: filled,
    takeProfit: leg("tp", "EXPIRED", "0.00099"),
    stopLoss: leg("sl", "EXPIRED", "0.00099"),
    exitReason: "protection_failed",
  });
  for (const intentStatus of ["submitting", "unknown"] as const) {
    const verdict = assessEntry({
      ...exiting,
      closes: [{ clientOrderId: "ct_a_c1", intentStatus }],
    });
    assert.equal(verdict.state, "unprotected");
    assert.equal(verdict.sell, undefined);
  }
  // A refused sale is retried.
  assert.equal(
    assessEntry({
      ...exiting,
      closes: [{ clientOrderId: "ct_a_c1", intentStatus: "rejected" }],
    }).sell,
    "0.00099",
  );
  // A sale that left less than a step holds nothing.
  const sold = assessEntry({
    ...exiting,
    takeProfit: leg("tp", "EXPIRED", "0.000995"),
    stopLoss: leg("sl", "EXPIRED", "0.000995"),
    closes: [
      {
        clientOrderId: "ct_a_c1",
        intentStatus: "acknowledged",
        leg: leg("c1", "FILLED", "0.00099", "0.00099"),
      },
    ],
  });
  assert.equal(sold.state, "closed");
  assert.equal(sold.held, "0");
});

test("a requested exit of an unfilled entry cancels it and sells nothing", () => {
  const request = observe({ exitReason: "close_all" });
  const first = assessEntry(request);
  assert.equal(first.state, "exiting");
  assert.equal(first.cancelList, true);
  const after = assessEntry({
    ...request,
    entry: leg("en", "CANCELED", "0.001"),
  });
  assert.equal(after.state, "not_filled");
  assert.equal(after.sell, undefined);
});

test("an entry that ended without filling, or whose exit filled, holds nothing", () => {
  assert.equal(
    assessEntry(observe({ entry: leg("en", "EXPIRED", "0.001") })).state,
    "not_filled",
  );
  const closed = assessEntry(
    observe({
      entry: filled,
      takeProfit: leg("tp", "FILLED", "0.00099", "0.00099"),
      stopLoss: leg("sl", "EXPIRED", "0.00099"),
    }),
  );
  assert.equal(closed.state, "closed");
  assert.equal(closed.exitReason, null);
});

test("a pause cancels an entry that has not filled completely, and leaves a filled one protected", () => {
  const working = assessEntry(observe({ exitReason: "pause" }));
  assert.equal(working.cancelList, true);
  const partial = assessEntry(
    observe({
      entry: leg("en", "CANCELED", "0.001", "0.0004"),
      exitReason: "pause",
    }),
  );
  assert.equal(partial.sell, "0.0004");
  const filledEntry = observe({
    entry: filled,
    takeProfit: leg("tp", "NEW", "0.00099"),
    stopLoss: leg("sl", "NEW", "0.00099"),
    exitReason: "pause",
  });
  const kept = assessEntry(filledEntry);
  assert.equal(kept.state, "protected");
  assert.equal(kept.cancelList, false);
  assert.equal(kept.exitReason, null);
  // Its protection can still fail, and that replaces the pause.
  const failed = assessEntry({
    ...filledEntry,
    stopLoss: leg("sl", "EXPIRED", "0.00099"),
    takeProfit: leg("tp", "EXPIRED", "0.00099"),
  });
  assert.equal(failed.exitReason, "protection_failed");
});

test("an exit whose sale Binance refused stays unprotected until it is sold", () => {
  const exiting = observe({
    entry: filled,
    takeProfit: leg("tp", "CANCELED", "0.00099"),
    stopLoss: leg("sl", "CANCELED", "0.00099"),
    exitReason: "holding_deadline",
    closes: [{ clientOrderId: "ct_a_c1", intentStatus: "rejected" }],
  });
  assert.equal(assessEntry(exiting).state, "exiting");
  assert.equal(
    assessEntry({ ...exiting, wasUnprotected: true }).state,
    "unprotected",
  );
});
