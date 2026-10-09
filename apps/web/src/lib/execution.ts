import "server-only";
import {
  executionStateSchema,
  type ExecutionState,
} from "@crypto-trading/exchanges/execution";
import { z } from "zod";
import { callWorkerForAccount, type WorkerState } from "./worker-client";

export type ExecutionView = WorkerState<{ execution: ExecutionState }>;

/**
 * What the worker's execution loop reports for the current customer:
 * entries it is selling or must, stop-limit entries it holds, and recent
 * notifications.
 */
export async function getExecutionState(): Promise<ExecutionView> {
  const result = await callWorkerForAccount({
    path: "/execution",
    schema: z.object({ execution: executionStateSchema }),
  });
  if (result.status !== "connected")
    return { status: result.status, message: result.message };
  return { status: "connected", execution: result.data.execution };
}
