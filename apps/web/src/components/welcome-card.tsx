"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const storageKey = "crypto-trading-agent:welcome-dismissed";
const listeners = new Set<() => void>();
// Keeps the card hidden until the next full page load when localStorage is
// unavailable, for example with blocked site data.
let dismissedWithoutStorage = false;

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function isDismissed() {
  if (dismissedWithoutStorage) return true;
  try {
    return window.localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

function dismiss() {
  try {
    window.localStorage.setItem(storageKey, "true");
  } catch {
    dismissedWithoutStorage = true;
  }
  listeners.forEach((listener) => listener());
}

export function WelcomeCard() {
  // The server cannot read this browser's storage, so it renders nothing and
  // returning visitors never see the card flash before it hides.
  const dismissed = useSyncExternalStore(subscribe, isDismissed, () => true);
  if (dismissed) return null;

  return (
    <Card aria-labelledby="welcome-title" className="mt-6" role="region">
      <CardHeader>
        <CardTitle>
          <h2 id="welcome-title">Welcome to Crypto Trading Agent</h2>
        </CardTitle>
        <CardDescription>
          Monitor a Binance Spot Testnet exchange account and ask the analysis
          assistant about its balances, orders, and fills. Strategies and
          AI-managed trades are not available yet.
        </CardDescription>
        <CardAction>
          <Button onClick={dismiss} size="sm" variant="ghost">
            <X />
            Dismiss
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6 text-sm md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div>
          <h3 className="flex items-center gap-2 font-medium">
            <ShieldCheck className="size-4" />
            Virtual funds only
          </h3>
          <p className="mt-2 leading-6 text-muted-foreground">
            Binance Spot Testnet balances are virtual and reset about once a
            month. No real money is involved, and live trading is disabled.
          </p>
        </div>
        <div>
          <h3 className="font-medium">Start trading</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 leading-6 text-muted-foreground">
            <li>
              Register an Ed25519 or RSA public key at{" "}
              <a
                className="text-foreground underline underline-offset-3"
                href="https://testnet.binance.vision/"
                rel="noreferrer"
                target="_blank"
              >
                Binance Spot Testnet
              </a>
              . Copy <Code>apps/execution/.env.example</Code> to{" "}
              <Code>apps/execution/.env</Code> and set the API key Binance
              issues and the path to your private key.
            </li>
            <li>
              Generate a token with <Code>openssl rand -hex 32</Code> and set it
              as <Code>EXECUTION_API_TOKEN</Code> in{" "}
              <Code>apps/execution/.env</Code> and in{" "}
              <Code>apps/web/.env.local</Code>, copied from{" "}
              <Code>apps/web/.env.example</Code>. Then restart{" "}
              <Code>pnpm dev</Code>.
            </li>
            <li>
              Run <Code>pnpm exchange check</Code>, then start the execution
              worker with <Code>pnpm dev:worker</Code>.
            </li>
            <li>
              Place test limit orders with{" "}
              <Code>pnpm exchange place-order</Code>, using the arguments in
              README.md. They appear here after the next refresh.
            </li>
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            Full steps are under “Connect Binance Spot Testnet” in README.md.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}
