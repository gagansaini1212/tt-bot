"use server";

import { refresh } from "next/cache";
import { reportingCurrencyChangeRequestSchema } from "@crypto-trading/exchanges/portfolio";

import { saveReportingCurrency } from "@/lib/account-portfolio";
import { isLocalRequest } from "@/lib/local-request";
import type { SettingsActionResult } from "@/lib/settings";

/**
 * Changes the currency the dashboard adds every exchange account up in. It
 * changes only what the dashboard shows, never an allocation or a limit.
 * Like the Settings actions, it refuses requests from other machines.
 */
export async function changeReportingCurrency(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest()))
    return {
      result: "refused",
      message:
        "Settings can only be changed from the dashboard on this machine.",
    };
  const request = reportingCurrencyChangeRequestSchema.safeParse(input);
  if (!request.success)
    return {
      result: "invalid",
      message: "Choose one of the offered currencies.",
    };
  const result = await saveReportingCurrency(request.data);
  refresh();
  return result;
}
