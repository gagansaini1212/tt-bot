# Disconnect exchange accounts without deleting them

Status: accepted, 2026-10-09, for milestone M4 (#24). It builds on [ADR 0009](0009-keep-exchange-accounts-isolated-across-venues.md), which keeps each exchange account and its credential set apart.

A customer can now add, label and remove exchange accounts on any venue, up to ten, each with its own keys. Removing one is a **disconnection**: the account's row stays, marked `disconnected` with the time, and its keys are deleted, ciphertext and all. We keep the row because strategies, allocations, order intents, orders, fills and the audit trail name the account, and reconciliation and reporting still need them. From then on the worker never resolves, reads, trades or reconciles the account, it leaves Settings, and its label is free for a new account.

The brief says disconnection requires closure or an explicit handover. M4 offers closure only. Removal is refused while the product still manages anything on the account: a running strategy, an open position, or an order the worker holds, is sending, has an unknown outcome for, or has not finished reconciling. The customer stops and closes these with the controls that already exist (pause, close all, the kill switch), then removes the account. An **account handover** would instead leave the positions and their protective orders with the customer and stop the worker managing them. That needs the execution loop to let go of each entry, its holding deadline and its strategy, which M4 does not build. The `handed_over` status is reserved for it, and the worker already treats such an account as disconnected.

One API key belongs to one exchange account. ADR 0009 refuses a second exchange account for the same venue account, where the venue reports an account identifier. To cover every venue, including those that report none, the worker also stores a fingerprint of each API key: an HMAC under a key derived from the master key, unique across all customers. A key saved for a second account is refused, so the same capital is never counted twice. Keys saved before this change have no fingerprint until they are replaced, and a new master key gives new fingerprints.

## Considered options

- **Deleting the account's row.** This would be simplest, but foreign keys from orders, fills and strategies would block it, or a cascade would erase the history that reconciliation and the audit trail need. Rejected.
- **Offering handover in M4.** The brief allows it. But without the execution loop letting go of entries, a "handed over" account would still be traded. Left for later, with removal refused until everything is closed.
- **Comparing sealed keys to find duplicates.** Each seal uses a fresh nonce, so equal keys never seal alike. Rejected for a keyed fingerprint.
- **Comparing only the venue's account identifier.** This is the precise check, but Binance's adapter does not read one yet, and some venues report none. It can be added beside the fingerprint.

## Consequences

- Queries that resolve or visit exchange accounts leave out `disconnected` and `handed_over` rows.
- An account's credential set is deleted when it is disconnected. Reconnecting the same venue account means adding a new exchange account with its keys.
- The fingerprint reveals nothing without the master key, but its unique index tells a customer that another account already holds a key, which only someone holding that key could test.
