import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna",
  reasoning: "medium",
  limits: {
    maxInputTokensPerSession: 200_000,
    maxOutputTokensPerSession: 20_000,
    maxTokenCostUsdPerSession: 1,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
