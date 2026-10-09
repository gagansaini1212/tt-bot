import "server-only";
import { cache } from "react";
import {
  defaultAccount,
  type ServedAccount,
} from "@crypto-trading/exchanges/served-accounts";
import type { WorkerFailure, WorkerResult } from "./worker-client";

/**
 * The exchange account this request acts on: the current customer's default
 * account among those the worker serves (`defaultAccount`, their oldest that
 * trades), undefined if they have none, or why the worker could not say.
 * `list` asks the worker for the customer's accounts; pass the same function
 * every time, so a request asks once, like the current customer.
 */
export const getCurrentExchangeAccount = cache(
  async (
    list: () => Promise<WorkerResult<{ accounts: ServedAccount[] }>>,
  ): Promise<ServedAccount | WorkerFailure | undefined> => {
    const result = await list();
    if (result.status !== "connected") return result;
    return defaultAccount(result.data.accounts);
  },
);
