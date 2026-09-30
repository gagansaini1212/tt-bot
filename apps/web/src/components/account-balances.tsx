"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Balance = { asset: string; free: string; locked: string };
const priority = ["USDT", "BTC", "ETH", "BNB"];

export function AccountBalances({ balances }: { balances: Balance[] }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toUpperCase();
  const filtered = balances
    .filter((balance) => balance.asset.includes(query))
    .sort((a, b) => {
      const aRank = priority.indexOf(a.asset);
      const bRank = priority.indexOf(b.asset);
      return (
        (aRank < 0 ? priority.length : aRank) -
          (bRank < 0 ? priority.length : bRank) ||
        a.asset.localeCompare(b.asset, "en")
      );
    });
  return (
    <section aria-label="Exchange balances" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Virtual balances</h2>
        <input
          aria-label="Filter balances"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-48"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search assets…"
          type="search"
          value={search}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {filtered.length} of {balances.length} assets with nonzero balances
      </p>
      <div
        className="max-h-96 overflow-auto rounded-md border border-border"
        tabIndex={0}
        aria-label="Scrollable asset balances"
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Asset</TableHead>
              <TableHead>Available</TableHead>
              <TableHead>Locked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((balance) => (
              <TableRow key={balance.asset}>
                <TableCell>{balance.asset}</TableCell>
                <TableCell className="font-mono text-xs">
                  {balance.free}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {balance.locked}
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3}>
                  {balances.length === 0
                    ? "No nonzero balances."
                    : "No matching assets."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
