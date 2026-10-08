"use server";

import { refresh } from "next/cache";

import { isLocalRequest } from "@/lib/local-request";
import { activateKillSwitch } from "@/lib/strategies";

/**
 * The kill switch. Like the order actions, it refuses any request that is
 * not from this machine.
 */
export async function engageKillSwitch(): Promise<
  | Awaited<ReturnType<typeof activateKillSwitch>>
  | {
      result: "refused";
      message: string;
    }
> {
  if (!(await isLocalRequest()))
    return {
      result: "refused",
      message:
        "The kill switch can only be used from the dashboard on this machine.",
    };
  const result = await activateKillSwitch();
  refresh();
  return result;
}
