"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartCandlestick,
  History,
  LayoutDashboard,
  Menu,
  Settings2,
  WalletCards,
  Workflow,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// The Activity icon is reserved for live performance metrics.
const navigation = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", icon: WalletCards },
  { href: "/strategies", label: "Strategies", icon: Workflow },
  { href: "/activity", label: "Activity", icon: History },
];

const settings = { href: "/settings", label: "Settings", icon: Settings2 };

// Tailwind's md breakpoint, where the sidebar replaces the mobile menu.
const desktopQuery = "(min-width: 48rem)";

function NavigationLink({
  href,
  label,
  icon: Icon,
  active,
  onNavigate,
}: (typeof navigation)[number] & {
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        buttonVariants({ variant: active ? "secondary" : "ghost" }),
        "w-full justify-start",
      )}
      href={href}
      onNavigate={onNavigate}
    >
      <Icon className="size-4" />
      {label}
    </Link>
  );
}

function Brand() {
  return (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <ChartCandlestick className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold tracking-tight">
          Crypto Trading Agent
        </span>
        <span className="block text-xs text-muted-foreground">
          Testnet workspace
        </span>
      </span>
    </>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  // Close the menu on every route change, including back and forward.
  const [menuPathname, setMenuPathname] = useState(pathname);
  if (menuPathname !== pathname) {
    setMenuPathname(pathname);
    setMenuOpen(false);
  }

  useEffect(() => {
    const desktop = window.matchMedia(desktopQuery);
    const closeOnDesktop = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto min-h-screen max-w-[1600px] md:grid md:grid-cols-[228px_1fr]">
        <aside className="hidden border-r border-border/70 bg-card/35 px-4 py-5 md:flex md:flex-col">
          <Link className="flex items-center gap-3 px-2" href="/">
            <Brand />
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
            <NavigationLink active={pathname === settings.href} {...settings} />
            <ThemeToggle />
            <div className="rounded-lg border border-border bg-background/40 p-3">
              <div className="flex items-center gap-2 text-xs font-medium">
                <span className="size-2 rounded-full bg-amber-600 dark:bg-amber-400" />
                Development trading
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Binance testnet · virtual funds
              </p>
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="flex items-center justify-between gap-3 border-b border-border/70 bg-card/35 px-4 py-2 md:hidden">
            <Link className="flex min-w-0 items-center gap-3" href="/">
              <Brand />
            </Link>
            <Sheet onOpenChange={setMenuOpen} open={menuOpen}>
              <SheetTrigger asChild>
                <Button size="lg" variant="outline">
                  <Menu />
                  Menu
                </Button>
              </SheetTrigger>
              <SheetContent aria-describedby={undefined} side="left">
                <SheetHeader className="flex-row items-center gap-3 pr-12">
                  <SheetTitle className="sr-only">Menu</SheetTitle>
                  <Brand />
                </SheetHeader>
                <nav
                  className="space-y-1 px-4 text-sm"
                  aria-label="Main navigation"
                >
                  {navigation.map((item) => (
                    <NavigationLink
                      active={pathname === item.href}
                      key={item.href}
                      onNavigate={closeMenu}
                      {...item}
                    />
                  ))}
                </nav>
                <div className="mt-auto space-y-4 p-4">
                  <Separator />
                  <NavigationLink
                    active={pathname === settings.href}
                    onNavigate={closeMenu}
                    {...settings}
                  />
                  <ThemeToggle />
                </div>
              </SheetContent>
            </Sheet>
          </header>
          <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
