import "server-only";
import { accountVenue } from "@crypto-trading/exchanges/exchange-accounts";
import type { AccountSnapshot } from "@crypto-trading/exchanges/contract";
import type { OverviewState } from "./account-portfolio";
import { contentId } from "./content-id";
import type { JsonObject } from "./json";
import type { TestnetAccountState } from "./testnet-account";

// The snapshot names these balances, and the account's accounting currency,
// which pays for its entries; Accounts lists the rest.
const SNAPSHOT_ASSETS = ["BTC", "ETH", "USDT"];

/** How the assistant is told what kind of data a venue's snapshot holds. */
function dataKind(venue: string, name: string) {
  return accountVenue(venue)?.capabilities.funds === "virtual"
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
    // Null when the account list, which says it, is unavailable.
    accountingCurrency: string | null;
  },
): JsonObject {
  const assets = [
    ...new Set([...SNAPSHOT_ASSETS, account.accountingCurrency ?? "USDT"]),
  ];
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
    balanceScope: `${assets.join(", ")}. Other asset balances are listed on Accounts.`,
    balances: snapshot.balances.filter((balance) =>
      assets.includes(balance.asset),
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
 * its own snapshot, or why it has none (ADR 0009). `account` is the current
 * account's snapshot, used only while the account list is unavailable;
 * otherwise each account the worker serves carries its own.
 */
export function assistantAccounts(
  account: TestnetAccountState,
  overview: OverviewState,
): JsonObject[] {
  if (overview.status !== "connected") {
    // Without the account list, the snapshot cannot name its account, so
    // nothing can be proposed on it.
    if (account.status !== "connected") return [];
    const name =
      accountVenue(account.snapshot.venue)?.name ?? account.snapshot.venue;
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
          accountingCurrency: null,
        }),
      },
    ];
  }
  return overview.overview.accounts.map((entry): JsonObject => {
    const summary = entry.account;
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
    const own = entry.snapshot;
    if (!summary.served || !own)
      return {
        ...context,
        snapshot: null,
        noSnapshot: "The execution worker does not read this account.",
      };
    return own.status === "connected"
      ? {
          ...context,
          snapshot: accountSnapshot(own.snapshot, {
            exchangeAccountId: summary.id,
            venue: summary.venue,
            venueName: summary.venueName,
            label: summary.label,
            accountingCurrency: summary.accountingCurrency,
          }),
        }
      : { ...context, snapshot: null, noSnapshot: own.message };
  });
}
