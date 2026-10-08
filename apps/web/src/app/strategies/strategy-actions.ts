"use server";

import { refresh } from "next/cache";
import {
  strategyActionRequestSchema,
  strategyDraftSchema,
  strategyVersionRequestSchema,
} from "@crypto-trading/exchanges/strategies";

import { isLocalRequest } from "@/lib/local-request";
import {
  closeAllStrategy,
  createStrategy,
  pauseStrategy,
  resumeStrategy,
  saveStrategyVersion,
  type StrategyActionResult,
} from "@/lib/strategies";

// Strategies place orders on the connected testnet account, so like the
// order actions these refuse any request that is not from this machine. The
// worker checks every request again.
const REFUSED: StrategyActionResult = {
  result: "refused",
  message: "Strategies can only be changed from the dashboard on this machine.",
  strategy: null,
};

const invalid = (message: string): StrategyActionResult => ({
  result: "invalid",
  message,
  strategy: null,
});

export async function startStrategy(
  input: unknown,
): Promise<StrategyActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const draft = strategyDraftSchema.safeParse(input);
  if (!draft.success)
    return invalid(
      draft.error.issues[0]?.message ?? "Check the strategy and try again.",
    );
  const result = await createStrategy(draft.data);
  refresh();
  return result;
}

export async function saveVersion(
  input: unknown,
): Promise<StrategyActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const request = strategyVersionRequestSchema.safeParse(input);
  if (!request.success)
    return invalid(
      request.error.issues[0]?.message ?? "Check the strategy and try again.",
    );
  const result = await saveStrategyVersion(request.data);
  refresh();
  return result;
}

const ACTIONS = {
  pause: pauseStrategy,
  resume: resumeStrategy,
  close_all: closeAllStrategy,
};

export async function controlStrategy(
  action: unknown,
  input: unknown,
): Promise<StrategyActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const request = strategyActionRequestSchema.safeParse(input);
  if (!request.success || typeof action !== "string" || !(action in ACTIONS))
    return invalid("That strategy action is not available.");
  const result = await ACTIONS[action as keyof typeof ACTIONS](
    request.data.strategyId,
  );
  refresh();
  return result;
}
