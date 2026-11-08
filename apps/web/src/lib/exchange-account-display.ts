// Browser-safe: how Settings → Exchange accounts names an account's venue,
// mode, status, keys and what its venue supports.
import type {
  ExchangeAccountMode,
  ExchangeAccountStatus,
  SupportedFeatures,
} from "@crypto-trading/exchanges/exchange-accounts";
import {
  accountModes,
  canPlaceOrders,
  VENUES,
  type ExchangeKeyType,
  type Venue,
} from "@crypto-trading/exchanges/venues";

export { accountVenue } from "@crypto-trading/exchanges/exchange-accounts";

export const MODE_LABELS: Record<ExchangeAccountMode, string> = {
  simulation: "Simulation (testnet)",
  live: "Live",
};

export const STATUS_LABELS: Record<ExchangeAccountStatus, string> = {
  connected: "Connected",
  reconciling: "Reconciling",
  unavailable: "Unavailable",
  handed_over: "Handed over",
  disconnected: "Removed",
};

export const KEY_TYPE_LABELS: Record<ExchangeKeyType, string> = {
  hmac: "HMAC",
  ed25519: "Ed25519",
  rsa: "RSA",
  es256: "ES256",
};

/** The venues an account can be added on: those with a mode this build allows. */
export function addableVenues(): Venue[] {
  return Object.values(VENUES).filter((venue) => accountModes(venue).length);
}

/** Whether the product only reads accounts on the venue. */
export function isReadOnly(venue: Venue) {
  return !canPlaceOrders(venue);
}

export type Signing = "hmac" | "private_key";

/** How a venue's keys can sign: with a secret, a private key, or either. */
export function signingChoices(
  venue: Venue,
): { value: Signing; label: string }[] {
  const { keyTypes } = venue.credentials;
  const privateKeys = keyTypes.filter((type) => type !== "hmac");
  return [
    ...(keyTypes.includes("hmac")
      ? [{ value: "hmac" as const, label: "Secret key (HMAC)" }]
      : []),
    ...(privateKeys.length
      ? [
          {
            value: "private_key" as const,
            label: `Private key (${privateKeys.map((type) => KEY_TYPE_LABELS[type]).join(", ")})`,
          },
        ]
      : []),
  ];
}

const MARKET_KINDS: Record<SupportedFeatures["marketKinds"][number], string> = {
  spot: "Spot",
  perpetual: "Perpetuals",
};

/**
 * What an account's venue supports, as the account last recorded it, such
 * as "Spot · trades with virtual funds · exits attached (OPOCO)".
 */
export function describeFeatures(features: SupportedFeatures): string {
  const parts = [
    features.marketKinds.map((kind) => MARKET_KINDS[kind]).join(", "),
    features.access === "read_only"
      ? `read only, ${features.funds} funds`
      : `trades with ${features.funds} funds`,
  ];
  if (features.attachedExits)
    parts.push(`exits attached (${features.attachedExits.toUpperCase()})`);
  return parts.filter(Boolean).join(" · ");
}
