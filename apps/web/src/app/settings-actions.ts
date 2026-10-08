"use server";

import { refresh } from "next/cache";
import {
  exchangeKeysRequestSchema,
  parseWebhookUrl,
  riskLimitsChangeRequestSchema,
  webhookRequestSchema,
} from "@crypto-trading/exchanges/settings";

import {
  PORTFOLIO_DRAWDOWN_LIMITS,
  portfolioLimitsChangeRequestSchema,
} from "@crypto-trading/exchanges/strategies";

import { requireFreshSession } from "@/lib/fresh-session";
import { isLocalRequest } from "@/lib/local-request";
import {
  markNotificationsRead,
  removeExchangeKeys,
  removeWebhook,
  saveExchangeKeys,
  saveRiskLimits,
  saveWebhook,
  sendTestWebhook,
  testExchangeConnection,
  type SettingsActionResult,
} from "@/lib/settings";
import { savePortfolioLimits } from "@/lib/strategies";

// These actions change what the worker trades with, so like the order
// actions they refuse any request that is not from this machine. Keys and
// URLs pass through to the worker and are never logged or returned. Changing
// exchange keys also needs a fresh session.
const KEYS_PAGE = "/settings?tab=keys";
const REFUSED: SettingsActionResult = {
  result: "refused",
  message: "Settings can only be changed from the dashboard on this machine.",
};

export async function changeExchangeKeys(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  // Sends a customer whose session is not fresh to confirm their password,
  // then back to the keys.
  await requireFreshSession(KEYS_PAGE);
  const request = exchangeKeysRequestSchema.safeParse(input);
  if (!request.success) {
    const field = request.error.issues[0]?.path[0];
    return {
      result: "invalid",
      message:
        field === "apiKey"
          ? "Check the API key: paste it as Binance shows it, 16 to 256 characters without spaces."
          : field === "secretKey"
            ? "Check the secret key: paste it as Binance shows it, 16 to 256 characters without spaces."
            : field === "privateKey"
              ? "Paste the whole private key, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----."
              : "Enter the API key and its secret key or private key.",
    };
  }
  const result = await saveExchangeKeys(request.data);
  refresh();
  return result;
}

export async function deleteExchangeKeys(): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  await requireFreshSession(KEYS_PAGE);
  const result = await removeExchangeKeys();
  refresh();
  return result;
}

export async function checkExchangeConnection(): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  return testExchangeConnection();
}

const LIMIT_FIELDS: Record<string, string> = {
  maxOrderNotional:
    "The per-order cap must be a positive USDT amount with at most 8 decimals.",
  maxDailyRisk:
    "The daily risk limit must be a positive USDT amount with at most 8 decimals.",
  defaultStopLossPercent:
    "The default stop loss must be a percentage below 100 with at most 2 decimals.",
};

export async function changeRiskLimits(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const request = riskLimitsChangeRequestSchema.safeParse(input);
  if (!request.success)
    return {
      result: "invalid",
      message:
        LIMIT_FIELDS[String(request.error.issues[0]?.path[0])] ??
        "Check the limits and try again.",
    };
  const result = await saveRiskLimits(request.data);
  refresh();
  return result;
}

export async function changePortfolioLimits(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const request = portfolioLimitsChangeRequestSchema.safeParse(input);
  if (!request.success)
    return {
      result: "invalid",
      message: `The daily drawdown limit must be a percentage from ${PORTFOLIO_DRAWDOWN_LIMITS.min} to ${PORTFOLIO_DRAWDOWN_LIMITS.max}, with at most 2 decimals.`,
    };
  const result = await savePortfolioLimits(request.data);
  refresh();
  return result;
}

export async function changeWebhook(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const request = webhookRequestSchema.safeParse(input);
  const parsed = request.success ? parseWebhookUrl(request.data.url) : null;
  if (!parsed?.ok)
    return {
      result: "invalid",
      message: parsed?.message ?? "Enter a Discord or Telegram webhook URL.",
    };
  const result = await saveWebhook(parsed.url);
  refresh();
  return result;
}

export async function deleteWebhook(): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const result = await removeWebhook();
  refresh();
  return result;
}

export async function testWebhook(): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  return sendTestWebhook();
}

export async function readAllNotifications(): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const result = await markNotificationsRead();
  refresh();
  return result;
}
