// Browser-safe: what the Settings page sends the execution worker and what it
// answers. The web server checks requests with these schemas before sending
// them, and the worker checks them again.
import { z } from "zod";
import { manualRiskLimitsSchema } from "./manual-order";
import { exchangeKeyTypeSchema } from "./venues";

const decimal = z
  .string()
  .max(48)
  .regex(/^\d+(\.\d+)?$/);
const timestamp = z.iso.datetime({ offset: true });

// ---- Exchange keys ---------------------------------------------------------

// Defined with the venues, which declare the key types they accept.
export { exchangeKeyTypeSchema, type ExchangeKeyType } from "./venues";

const apiKey = z.string().regex(/^[\x21-\x7e]{16,256}$/);
// Printable ASCII, spaces included, kept exactly as typed.
const passphrase = z
  .string()
  .regex(/^[\x20-\x7e]{1,128}$/)
  .optional();

/**
 * New keys for an exchange account. The worker checks them against the
 * account's venue: its key types, and whether it needs a passphrase.
 */
export const exchangeKeysRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("hmac"),
    apiKey,
    secretKey: z.string().regex(/^[\x21-\x7e]{16,256}$/),
    passphrase,
  }),
  z.strictObject({
    kind: z.literal("private_key"),
    apiKey,
    // An unencrypted PEM private key whose public key is registered with
    // the venue. The worker checks it is Ed25519, RSA or P-256 (ES256).
    privateKey: z
      .string()
      .min(64)
      .max(8192)
      .refine((value) => value.trim().startsWith("-----BEGIN")),
    passphrase,
  }),
]);
export type ExchangeKeysRequest = z.infer<typeof exchangeKeysRequestSchema>;

/**
 * Which keys the worker uses for an exchange account. Never the keys
 * themselves: only the last four characters of the API key.
 * - saved: keys saved on the Settings page.
 * - environment: the worker's own keys from its .env file, used for the dev
 *   account until keys are saved.
 * - none: no keys, so the worker cannot reach the account.
 */
export const exchangeKeysStatusSchema = z.object({
  source: z.enum(["saved", "environment", "none"]),
  keyType: exchangeKeyTypeSchema.nullable(),
  apiKeyLast4: z.string().max(4).nullable(),
  hasPassphrase: z.boolean().default(false),
  updatedAt: timestamp.nullable(),
  // Why saved keys cannot be used, such as a missing or different master key.
  problem: z.string().max(500).nullable(),
});
export type ExchangeKeysStatus = z.infer<typeof exchangeKeysStatusSchema>;

export const connectionTestSchema = z.object({
  result: z.enum(["connected", "failed"]),
  source: z.enum(["saved", "environment", "none"]),
  canTrade: z.boolean().optional(),
  message: z.string().max(500),
});
export type ConnectionTest = z.infer<typeof connectionTestSchema>;

// ---- Risk limits -----------------------------------------------------------

/** New risk limits, made from the version the customer was editing. */
export const riskLimitsChangeRequestSchema = manualRiskLimitsSchema.extend({
  // 0 when there was no version yet.
  baseVersion: z.int().nonnegative(),
});
export type RiskLimitsChangeRequest = z.infer<
  typeof riskLimitsChangeRequestSchema
>;

const storedLimits = z.object({
  maxOrderNotional: decimal,
  maxDailyRisk: decimal,
  defaultStopLossPercent: decimal,
});

export const riskLimitsStateSchema = z.object({
  // The latest version, or null before the customer sets any.
  current: storedLimits
    .extend({ version: z.int().positive(), createdAt: timestamp })
    .nullable(),
  // Upper bounds set by the platform. The customer cannot exceed them.
  platformMaximums: storedLimits,
  minimumStopLossPercent: decimal,
});
export type RiskLimitsState = z.infer<typeof riskLimitsStateSchema>;

export const riskLimitsChangeSchema = z.object({
  result: z.enum(["saved", "invalid", "conflict"]),
  message: z.string().max(500),
  limits: riskLimitsStateSchema,
});
export type RiskLimitsChange = z.infer<typeof riskLimitsChangeSchema>;

// ---- Notifications ---------------------------------------------------------

export const webhookKindSchema = z.enum(["discord", "telegram"]);
export type WebhookKind = z.infer<typeof webhookKindSchema>;

export const MAX_WEBHOOK_URL_LENGTH = 512;
const DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);
const DISCORD_PATH =
  /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{20,100})$/;
const TELEGRAM_PATH = /^\/bot(\d{3,15}:[A-Za-z0-9_-]{20,100})\/sendMessage$/;
const TELEGRAM_CHAT = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

export type ParsedWebhookUrl =
  | {
      ok: true;
      kind: WebhookKind;
      url: string;
      // The token's last four characters, shown in place of the URL.
      last4: string;
    }
  | { ok: false; message: string };

/**
 * Accepts only a Discord webhook URL or a Telegram Bot API sendMessage URL,
 * over HTTPS on the default port, so the worker can post nowhere else:
 *
 * - https://discord.com/api/webhooks/<id>/<token>, optionally with thread_id
 * - https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat>, optionally
 *   with message_thread_id
 *
 * Messages never include the URL, which holds the token.
 */
export function parseWebhookUrl(value: string): ParsedWebhookUrl {
  const invalid = (message: string) => ({ ok: false as const, message });
  const help =
    "Use a Discord webhook URL (https://discord.com/api/webhooks/…) or a Telegram sendMessage URL (https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat ID>).";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WEBHOOK_URL_LENGTH)
    return invalid(`Enter a webhook URL. ${help}`);
  const url = URL.parse(trimmed);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return invalid(`That is not a supported webhook URL. ${help}`);
  const query = [...url.searchParams];
  if (DISCORD_HOSTS.has(url.hostname)) {
    const match = DISCORD_PATH.exec(url.pathname);
    const queryValid = query.every(
      ([key, item]) => key === "thread_id" && /^\d{1,25}$/.test(item),
    );
    if (!match || !queryValid || query.length > 1)
      return invalid(
        "That is not a Discord webhook URL. Copy it from the channel's Integrations → Webhooks settings.",
      );
    return {
      ok: true,
      kind: "discord",
      url: url.toString(),
      last4: match[2].slice(-4),
    };
  }
  if (url.hostname === "api.telegram.org") {
    const match = TELEGRAM_PATH.exec(url.pathname);
    const chat = url.searchParams.get("chat_id");
    const queryValid = query.every(([key, item]) =>
      key === "chat_id"
        ? TELEGRAM_CHAT.test(item)
        : key === "message_thread_id" && /^\d{1,15}$/.test(item),
    );
    const repeated = new Set(query.map(([key]) => key)).size !== query.length;
    if (!match || !chat || !queryValid || repeated)
      return invalid(
        "That is not a Telegram sendMessage URL. Use https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat ID>.",
      );
    return {
      ok: true,
      kind: "telegram",
      url: url.toString(),
      last4: match[1].slice(-4),
    };
  }
  return invalid(`Only Discord and Telegram webhooks are supported. ${help}`);
}

export const webhookRequestSchema = z.strictObject({
  url: z.string().max(MAX_WEBHOOK_URL_LENGTH),
});

export const webhookStatusSchema = z.object({
  webhook: z
    .object({
      kind: webhookKindSchema,
      last4: z.string().max(4),
      updatedAt: timestamp,
    })
    .nullable(),
  // Saving a webhook needs the worker's master key.
  canSave: z.boolean(),
});
export type WebhookStatus = z.infer<typeof webhookStatusSchema>;

export const webhookChangeSchema = z.object({
  result: z.enum(["saved", "removed", "invalid", "unavailable"]),
  message: z.string().max(500),
  status: webhookStatusSchema,
});
export type WebhookChange = z.infer<typeof webhookChangeSchema>;

export const webhookTestSchema = z.object({
  result: z.enum(["delivered", "failed"]),
  message: z.string().max(500),
});
export type WebhookTest = z.infer<typeof webhookTestSchema>;

// Notifications use notificationSchema from execution-state.ts.
/** How many notifications the Settings history lists. */
export const MAX_NOTIFICATIONS = 50;
