import { z } from "zod";

/** The statuses a strategy is stored with. */
export const strategyStatusSchema = z.enum([
  "simulation",
  "active",
  "paused",
  "retired",
]);

export type StrategyStatus = z.infer<typeof strategyStatusSchema>;

/**
 * The status a customer sees. A strategy runs in simulation or live trading,
 * and is completed once it will open no more entries and holds none.
 */
export function strategyStatusLabel(
  status: StrategyStatus,
): "Running" | "Paused" | "Completed" {
  switch (status) {
    case "simulation":
    case "active":
      return "Running";
    case "paused":
      return "Paused";
    case "retired":
      return "Completed";
  }
}
