"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ChartCandlestick,
  Database,
  LayoutDashboard,
  Settings2,
  WalletCards,
} from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", icon: WalletCards },
  { href: "/strategies", label: "Strategies", icon: Activity },
  { href: "/decisions", label: "Activity", icon: Database },
];

function NavigationLink({
  href,
  label,
  icon: Icon,
  active,
  compact = false,
}: (typeof navigation)[number] & { active: boolean; compact?: boolean }) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        buttonVariants({ variant: active ? "secondary" : "ghost" }),
        compact
          ? "h-auto min-w-0 flex-col gap-1 px-1 py-2 text-[11px]"
          : "w-full justify-start",
      )}
      href={href}
    >
      <Icon className="size-4" />
      {label}
    </Link>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings";

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto min-h-screen max-w-[1600px] md:grid md:grid-cols-[228px_1fr]">
        <aside className="hidden border-r border-border/70 bg-card/35 px-4 py-5 md:flex md:flex-col">
          <Link className="flex items-center gap-3 px-2" href="/">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ChartCandlestick className="size-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold tracking-tight">
                Northstar
              </span>
              <span className="block text-xs text-muted-foreground">
                Trading control
              </span>
            </span>
          </Link>

          <nav className="mt-8 space-y-1 text-sm" aria-label="Main navigation">
            {navigation.map((item) => (
              <NavigationLink
                active={pathname === item.href}
                key={item.href}
                {...item}
              />
            ))}
          </nav>

          <div className="mt-auto space-y-4">
            <Separator />
            <Link
              aria-current={settingsActive ? "page" : undefined}
              className={cn(
                buttonVariants({
                  variant: settingsActive ? "secondary" : "ghost",
                }),
                "w-full justify-start",
              )}
              href="/settings"
            >
              <Settings2 className="size-4" />
              Settings
            </Link>
            <div className="rounded-lg border border-border bg-background/40 p-3">
              <div className="flex items-center gap-2 text-xs font-medium">
                <span className="size-2 rounded-full bg-amber-400" />
                Development trading
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Binance testnet · virtual funds
              </p>
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <nav
            className="grid grid-cols-5 gap-1 border-b border-border/70 bg-card/35 p-2 md:hidden"
            aria-label="Main navigation"
          >
            {navigation.map((item) => (
              <NavigationLink
                active={pathname === item.href}
                compact
                key={item.href}
                {...item}
              />
            ))}
            <Link
              aria-current={settingsActive ? "page" : undefined}
              className={cn(
                buttonVariants({
                  variant: settingsActive ? "secondary" : "ghost",
                }),
                "h-auto min-w-0 flex-col gap-1 px-1 py-2 text-[11px]",
              )}
              href="/settings"
            >
              <Settings2 className="size-4" />
              Settings
            </Link>
          </nav>
          <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
