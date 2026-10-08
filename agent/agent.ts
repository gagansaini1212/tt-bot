import { defineAgent } from "eve";

import { ASSISTANT_MODEL } from "./lib/decisions";

export default defineAgent({
  model: ASSISTANT_MODEL,
  reasoning: "medium",
  limits: {
    maxInputTokensPerSession: 200_000,
    maxOutputTokensPerSession: 20_000,
    maxTokenCostUsdPerSession: 1,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
