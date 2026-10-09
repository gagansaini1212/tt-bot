"use server";

import { refresh } from "next/cache";
import type { z } from "zod";
import {
  addExchangeAccountRequestSchema,
  exchangeAccountRequestSchema,
  relabelExchangeAccountRequestSchema,
  replaceExchangeKeysRequestSchema,
} from "@crypto-trading/exchanges/exchange-accounts";
import {
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
  addExchangeAccount,
  markNotificationsRead,
  relabelExchangeAccount,
  removeExchangeAccount,
  removeWebhook,
  replaceExchangeKeys,
  saveRiskLimits,
  saveWebhook,
  sendTestWebhook,
  testExchangeAccount,
  type SettingsActionResult,
} from "@/lib/settings";
import { savePortfolioLimits } from "@/lib/strategies";

// These actions change what the worker trades with, so like the order
// actions they refuse any request that is not from this machine. Keys and
// URLs pass through to the worker and are never logged or returned. Adding,
// removing or giving new keys to an exchange account also needs a fresh
// session.
const ACCOUNTS_PAGE = "/settings?tab=accounts";
const REFUSED: SettingsActionResult = {
  result: "refused",
  message: "Settings can only be changed from the dashboard on this machine.",
};

// What to fix, by the field the request failed on. Never repeats a value.
const ACCOUNT_FIELDS: Record<string, string> = {
  venue: "Choose a venue.",
  label:
    "Enter a label of 1 to 64 characters, such as Binance testnet, to tell the account apart.",
  mode: "Choose the account's mode.",
  accountingCurrency: "Choose the accounting currency.",
  apiKey:
    "Check the API key: paste it as the venue shows it, 16 to 256 characters without spaces.",
  secretKey:
    "Check the secret key: paste it as the venue shows it, 16 to 256 characters without spaces.",
  privateKey:
    "Paste the whole private key, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.",
  passphrase:
    "Check the passphrase: up to 128 printable characters, as you set it at the venue.",
};

function invalid(error: z.ZodError): SettingsActionResult {
  const path = error.issues[0]?.path ?? [];
  const field = String(path.at(-1));
  return {
    result: "invalid",
    message:
      ACCOUNT_FIELDS[field] ??
      (path[0] === "credentials"
        ? "Enter the API key and its secret key or private key."
        : "Check the account's details and try again."),
  };
}

export async function addAccount(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  // Sends a customer whose session is not fresh to confirm their password,
  // then back to the accounts.
  await requireFreshSession(ACCOUNTS_PAGE);
  const request = addExchangeAccountRequestSchema.safeParse(input);
  if (!request.success) return invalid(request.error);
  const result = await addExchangeAccount(request.data);
  refresh();
  return result;
}

export async function replaceAccountKeys(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  await requireFreshSession(ACCOUNTS_PAGE);
  const request = replaceExchangeKeysRequestSchema.safeParse(input);
  if (!request.success) return invalid(request.error);
  const result = await replaceExchangeKeys(request.data);
  refresh();
  return result;
}

export async function removeAccount(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  await requireFreshSession(ACCOUNTS_PAGE);
  const request = exchangeAccountRequestSchema.safeParse(input);
  if (!request.success) return invalid(request.error);
  const result = await removeExchangeAccount(request.data.exchangeAccountId);
  refresh();
  return result;
}

export async function renameAccount(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const request = relabelExchangeAccountRequestSchema.safeParse(input);
  if (!request.success) return invalid(request.error);
  const result = await relabelExchangeAccount(request.data);
  refresh();
  return result;
}

export async function testAccount(
  input: unknown,
): Promise<SettingsActionResult> {
  if (!(await isLocalRequest())) return REFUSED;
  const request = exchangeAccountRequestSchema.safeParse(input);
  if (!request.success) return invalid(request.error);
  return testExchangeAccount(request.data.exchangeAccountId);
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
