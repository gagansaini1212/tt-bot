import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryAlert } from "@crypto-trading/exchanges/execution";
import {
  alertHeadline,
  checkedLabel,
  exitReasonLabel,
  isUrgent,
  triggerSummary,
} from "./execution-display";

const alert = (fields: Partial<EntryAlert> = {}): EntryAlert => ({
  listClientOrderId: "ct_display",
  instrument: "BTC-USDT",
  state: "unprotected",
  heldQuantity: "0.00099",
  exitReason: "protection_failed",
  detail: "",
  closeBlocked: false,
  overdueSince: null,
  since: "2026-10-08T12:00:00.000Z",
  ...fields,
});

test("alerts say what is held, why, and what happens next", () => {
  assert.equal(alertHeadline(alert()), "0.00099 BTC has no stop loss");
  assert.ok(isUrgent(alert()));
  const deadline = alert({ state: "exiting", exitReason: "holding_deadline" });
  assert.equal(
    alertHeadline(deadline),
    "Selling 0.00099 BTC: holding deadline reached",
  );
  assert.equal(isUrgent(deadline), false);
  const overdue = { ...deadline, overdueSince: "2026-10-08T12:00:00.000Z" };
  assert.equal(alertHeadline(overdue), "Exit overdue: 0.00099 BTC still held");
  assert.ok(isUrgent(overdue));
  const blocked = alert({ closeBlocked: true });
  assert.equal(alertHeadline(blocked), "Could not sell 0.00099 BTC");
});

test("exit reasons read as words, including ones other modules set", () => {
  assert.equal(
    exitReasonLabel("stop_loss"),
    "stop loss reached before the entry filled",
  );
  assert.equal(exitReasonLabel("range_stop"), "range stop");
  assert.equal(exitReasonLabel(null), "");
});

test("held stop-limit entries and the loop's last check are described exactly", () => {
  assert.equal(
    triggerSummary({
      listClientOrderId: "ct_stop",
      instrument: "ETH-USDT",
      stopPrice: "3100.50",
      price: "3105",
      quantity: "0.0500",
      takeProfitPrice: "3300",
      stopLossPrice: "3000",
      createdAt: "2026-10-08T12:00:00.000Z",
    }),
    "Buy 0.05 ETH at 3,105 once ETH/USDT trades at or above 3,100.5",
  );
  assert.match(checkedLabel("2026-10-08T12:00:05.000Z"), /at 12:00:05 UTC/);
  assert.match(checkedLabel(null), /has not checked/);
});
