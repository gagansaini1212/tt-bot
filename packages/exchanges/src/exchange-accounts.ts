// Browser-safe: a customer's exchange accounts as Settings lists and changes
// them through the execution worker. The web server checks requests with
// these schemas before sending them, and the worker checks them again. See
// ADR 0009 and docs/database.md.
import { z } from "zod";
import type { KeyPermissions } from "./contract";
import {
  exchangeKeysRequestSchema,
  exchangeKeysStatusSchema,
} from "./settings";
import {
  canPlaceOrders,
  venueIdSchema,
  type Venue,
  type VenueCapabilities,
} from "./venues";

const timestamp = z.iso.datetime({ offset: true });

/** `simulation` on a testnet; `live` only on a read-only venue (`accountModes`). */
export const exchangeAccountModeSchema = z.enum(["simulation", "live"]);
export type ExchangeAccountMode = z.infer<typeof exchangeAccountModeSchema>;

/**
 * An account the worker serves is `connected`, `reconciling` or
 * `unavailable` (ADR 0009 §5). One the customer removed is `disconnected`,
 * or `handed_over` after an account handover, and is never traded again.
 */
export const exchangeAccountStatusSchema = z.enum([
  "connected",
  "reconciling",
  "unavailable",
  "handed_over",
  "disconnected",
]);
export type ExchangeAccountStatus = z.infer<typeof exchangeAccountStatusSchema>;

/**
 * The accounting currencies an account may choose. Every M4 account accounts
 * in USDT (ADR 0009 §3): risk limits, allocations and strategy limits are
 * still USDT amounts.
 */
export const ACCOUNTING_CURRENCIES = ["USDT"] as const;

/** At most this many exchange accounts per customer, each read every pass. */
export const MAX_EXCHANGE_ACCOUNTS = 10;

export const exchangeAccountLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}]+$/u);

/** What a venue's adapter declared, as an account records it. */
export const venueCapabilitiesSchema = z.object({
  marketKinds: z.array(z.enum(["spot", "perpetual"])),
  access: z.enum(["trade", "read_only"]),
  funds: z.enum(["virtual", "real"]),
  orderTypes: z.array(
    z.enum(["limit", "limit_maker", "market", "stop_loss", "stop_loss_limit"]),
  ),
  timeInForce: z.array(z.enum(["GTC", "IOC", "FOK"])),
  orderLists: z.array(z.enum(["oco", "oto", "otoco", "opo", "opoco"])),
  attachedExits: z.enum(["opoco"]).nullable(),
  stopOrders: z.enum(["exits_only", "standalone", "none"]),
  testOrders: z.boolean(),
  lookupByClientOrderId: z.boolean(),
}) satisfies z.ZodType<VenueCapabilities>;
export type SupportedFeatures = z.infer<typeof venueCapabilitiesSchema>;

export const exchangeAccountSummarySchema = z.object({
  id: z.uuid(),
  // A venue ID. One this build has no adapter for is shown as it is.
  venue: z.string().max(64),
  label: z.string().max(64),
  mode: exchangeAccountModeSchema,
  accountingCurrency: z.string().max(16),
  status: exchangeAccountStatusSchema,
  // Null until the account first connects.
  supportedFeatures: venueCapabilitiesSchema.nullable(),
  supportedFeaturesRefreshedAt: timestamp.nullable(),
  keys: exchangeKeysStatusSchema,
  createdAt: timestamp,
});
export type ExchangeAccountSummary = z.infer<
  typeof exchangeAccountSummarySchema
>;

export const exchangeAccountsStateSchema = z.object({
  // Oldest first. Removed accounts are left out.
  accounts: z.array(exchangeAccountSummarySchema).max(MAX_EXCHANGE_ACCOUNTS),
  // Saving keys, and so adding an account, needs the worker's master key.
  canSave: z.boolean(),
});
export type ExchangeAccountsState = z.infer<typeof exchangeAccountsStateSchema>;

const exchangeAccountId = z.uuid();

/** A new exchange account with its keys. */
export const addExchangeAccountRequestSchema = z.strictObject({
  venue: venueIdSchema,
  label: exchangeAccountLabelSchema,
  mode: exchangeAccountModeSchema,
  accountingCurrency: z.enum(ACCOUNTING_CURRENCIES),
  credentials: exchangeKeysRequestSchema,
});
export type AddExchangeAccountRequest = z.infer<
  typeof addExchangeAccountRequestSchema
>;

export const relabelExchangeAccountRequestSchema = z.strictObject({
  exchangeAccountId,
  label: exchangeAccountLabelSchema,
});
export type RelabelExchangeAccountRequest = z.infer<
  typeof relabelExchangeAccountRequestSchema
>;

/** New keys for an account, replacing its old ones. */
export const replaceExchangeKeysRequestSchema = z.strictObject({
  exchangeAccountId,
  credentials: exchangeKeysRequestSchema,
});
export type ReplaceExchangeKeysRequest = z.infer<
  typeof replaceExchangeKeysRequestSchema
>;

/** Names one account, to test or remove it. */
export const exchangeAccountRequestSchema = z.strictObject({
  exchangeAccountId,
});

/**
 * What a change did. `invalid`, `refused`, `conflict` and `unavailable`
 * changed nothing.
 */
export const exchangeAccountChangeSchema = z.object({
  result: z.enum([
    "saved",
    "removed",
    "invalid",
    "refused",
    "conflict",
    "unavailable",
  ]),
  message: z.string().max(1000),
});
export type ExchangeAccountChange = z.infer<typeof exchangeAccountChangeSchema>;

/**
 * The permissions a key has beyond what an account on `venue` allows. No
 * account may hold a key that can withdraw, and one on a venue the product
 * only reads may hold no key that can trade either (ADR 0009 §4).
 */
export function excessKeyPermissions(
  venue: Venue,
  permissions: KeyPermissions,
): ("trade" | "withdraw")[] {
  const excess: ("trade" | "withdraw")[] = [];
  if (permissions.trade && !canPlaceOrders(venue)) excess.push("trade");
  if (permissions.withdraw) excess.push("withdraw");
  return excess;
}
