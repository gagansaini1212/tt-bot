import "server-only";
import { venueFor, venueIdSchema } from "@crypto-trading/exchanges/venues";
import type { AccountSnapshot } from "@crypto-trading/exchanges/contract";
import type { OverviewState } from "./account-portfolio";
import { contentId } from "./content-id";
import type { JsonObject } from "./json";
import type { TestnetAccountState } from "./testnet-account";

// The snapshot names these balances; Accounts lists the rest.
const SNAPSHOT_ASSETS = ["BTC", "ETH", "USDT"];

/** How the assistant is told what kind of data a venue's snapshot holds. */
function dataKind(venue: string, name: string) {
  const known = venueIdSchema.safeParse(venue);
  return known.success && venueFor(known.data).capabilities.funds === "virtual"
    ? `${name}, virtual funds`
    : `${name}, real funds, read only`;
}

/**
 * One account's snapshot for the assistant, labelled with its venue and
 * account. Its snapshotId hashes that label too, so two accounts never share
 * one, and a decision names exactly the account it was based on.
 */
function accountSnapshot(
  snapshot: AccountSnapshot,
  account: {
    exchangeAccountId: string | null;
    venue: string;
    venueName: string;
    label: string;
    accountingCurrency: string;
  },
): JsonObject {
  const content = {
    capturedAt: snapshot.capturedAt,
    dataKind: dataKind(account.venue, account.venueName),
    account: {
      exchangeAccountId: account.exchangeAccountId,
      venue: account.venueName,
      label: account.label,
      accountingCurrency: account.accountingCurrency,
      canTrade: snapshot.canTrade,
      liveTradingLocked: true,
    },
    balanceScope: `${SNAPSHOT_ASSETS.join(", ")}. Other asset balances are listed on Accounts.`,
    balances: snapshot.balances.filter((balance) =>
      SNAPSHOT_ASSETS.includes(balance.asset),
    ),
    openOrders: snapshot.orders,
    recentFills: snapshot.fills.slice(0, 10),
    strategyManagement:
      "Manual development trades. The execution worker watches each order's exits and sells any bought quantity left without a stop loss. Strategy ownership and profit/loss are not tracked for these holdings.",
  };
  return JSON.parse(
    JSON.stringify({ snapshotId: contentId(content), ...content }),
  ) as JsonObject;
}

/**
 * What the analysis assistant sees of the customer's exchange accounts:
 * each one labelled with its venue and account, whether it can trade, and
 * its own snapshot, or why it has none (ADR 0009). The worker reads one
 * account's snapshot today, `account`; the others are listed without one.
 */
export function assistantAccounts(
  account: TestnetAccountState,
  overview: OverviewState,
): JsonObject[] {
  if (overview.status !== "connected") {
    // Without the account list, the snapshot cannot name its account, so
    // nothing can be proposed on it.
    if (account.status !== "connected") return [];
    const name = "Binance Spot Testnet";
    return [
      {
        exchangeAccountId: null,
        venue: name,
        label: name,
        canTrade: false,
        note: "The account list is unavailable, so this account cannot be named in a proposal.",
        snapshot: accountSnapshot(account.snapshot, {
          exchangeAccountId: null,
          venue: account.snapshot.venue,
          venueName: name,
          label: name,
          accountingCurrency: "USDT",
        }),
      },
    ];
  }
  return overview.overview.accounts.map(({ account: summary }): JsonObject => {
    const context = {
      exchangeAccountId: summary.id,
      venue: summary.venueName,
      label: summary.label,
      accountingCurrency: summary.accountingCurrency,
      readOnly: summary.access === "read_only",
      // Only a testnet account the worker trades on can take a proposal.
      canTrade:
        summary.access === "trade" &&
        summary.mode === "simulation" &&
        summary.served,
    };
    if (!summary.served)
      return {
        ...context,
        snapshot: null,
        noSnapshot: "The execution worker does not read this account yet.",
      };
    return account.status === "connected"
      ? {
          ...context,
          snapshot: accountSnapshot(account.snapshot, {
            exchangeAccountId: summary.id,
            venue: summary.venue,
            venueName: summary.venueName,
            label: summary.label,
            accountingCurrency: summary.accountingCurrency,
          }),
        }
      : { ...context, snapshot: null, noSnapshot: account.message };
  });
}
