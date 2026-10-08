import type { ExecutionState } from "@crypto-trading/exchanges";
import { z } from "zod";
import type { AccountScope } from "../accounts";
import { handler } from "../http";

/** Reads what the execution loop knows about a customer's orders. */
export interface ExecutionReader {
  state(scope: AccountScope): Promise<ExecutionState>;
}

const idle: ExecutionState = {
  checkedAt: null,
  alerts: [],
  triggers: [],
  notifications: [],
};

/**
 * Entries the customer must act on or know about, stop-limit entries the
 * worker holds, and recent notifications. Without a loop, such as in tests of
 * other routes, there is nothing to report.
 */
export function execution(reader: ExecutionReader | undefined) {
  return handler({
    query: z.strictObject({}),
    handle: async ({ account }) => ({
      status: "connected",
      execution: reader ? await reader.state(account) : idle,
    }),
  });
}
