import "server-only";
import {
  accountSnapshotSchema,
  type AccountSnapshot,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import {
  callWorkerForCustomer,
  type WorkerFailureReason,
  type WorkerState,
} from "./worker-client";

export type TestnetAccountState = WorkerState<{ snapshot: AccountSnapshot }>;

const MAX_SNAPSHOT_AGE_MS = 30_000;
// Covers the Date header's one-second resolution and small clock adjustments.
const MAX_SNAPSHOT_LEAD_MS = 5_000;
const REJECTED =
  "The testnet account is unavailable. Check the execution worker and its credentials, then refresh.";
const UNREACHABLE =
  "The testnet account is unavailable. Start the execution worker and refresh to reconnect.";
// Account wording for some failures. The others keep the worker client's.
const MESSAGES: Partial<Record<WorkerFailureReason, string>> = {
  missing_token:
    "Set up Binance Spot Testnet to view virtual balances, orders, and fills here. Follow the testnet setup in README.md.",
  invalid_request: REJECTED,
  rejected: REJECTED,
  unreachable: UNREACHABLE,
  timeout: UNREACHABLE,
  invalid_response: UNREACHABLE,
};

/**
 * Measures the snapshot's age on the worker's clock, read from its response Date header,
 * so a difference between this machine's clock and the worker's does not matter.
 * Falls back to this machine's clock if the header is missing.
 */
export function snapshotFreshness(
  capturedAt: string,
  workerDate: string | null,
  now: number,
): "fresh" | "stale" | "future" {
  const workerNow = Date.parse(workerDate ?? "");
  const age =
    (Number.isNaN(workerNow) ? now : workerNow) - Date.parse(capturedAt);
  if (age > MAX_SNAPSHOT_AGE_MS) return "stale";
  if (age < -MAX_SNAPSHOT_LEAD_MS) return "future";
  return "fresh";
}

export async function getTestnetAccount(): Promise<TestnetAccountState> {
  const result = await callWorkerForCustomer({
    path: "/snapshot",
    schema: z.object({ snapshot: accountSnapshotSchema }),
  });
  if (result.status !== "connected")
    return {
      status: result.status,
      message: MESSAGES[result.reason] ?? result.message,
    };
  const { snapshot } = result.data;
  const freshness = snapshotFreshness(
    snapshot.capturedAt,
    result.date,
    Date.now(),
  );
  if (freshness === "stale")
    return {
      status: "unavailable",
      message:
        "The execution worker is running, but its account snapshot is more than 30 seconds old. Check the worker's connection to Binance Spot Testnet, then refresh.",
    };
  if (freshness === "future")
    return {
      status: "unavailable",
      message:
        "The execution worker is running, but its account snapshot is dated in the future. Check the system clock on the machine running the worker, then refresh.",
    };
  return { status: "connected", snapshot };
}
