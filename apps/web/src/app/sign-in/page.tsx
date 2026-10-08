import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ChartCandlestick } from "lucide-react";
import {
  DEV_USER_EMAIL,
  DEV_USER_PASSWORD,
} from "@crypto-trading/database/dev-seed";

import { SignInForm } from "@/components/sign-in-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentCustomer } from "@/lib/current-customer";
import { safeNextPath } from "@/lib/sign-in-path";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const customer = await getCurrentCustomer();
  // A signed-in customer comes here only to confirm their password before a
  // sensitive action, which starts a fresh session.
  const reauthenticate = customer !== null && params.reauthenticate === "1";
  if (customer && !reauthenticate) redirect(next);

  const form = (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1>{reauthenticate ? "Confirm it's you" : "Sign in"}</h1>
        </CardTitle>
        <CardDescription>
          {reauthenticate
            ? "Enter your password again to continue. Changes to exchange credentials and live trading need a recent sign-in."
            : "Sign in to see your exchange account and use the assistant."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SignInForm
          email={customer?.email}
          next={next}
          reauthenticate={reauthenticate}
        />
      </CardContent>
    </Card>
  );
  // Confirming a password happens inside the dashboard's shell.
  if (reauthenticate)
    return <div className="flex justify-center py-6 sm:py-10">{form}</div>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-3">
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
        </div>
        {form}
        {process.env.NODE_ENV === "development" ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Local development: sign in as{" "}
            <span className="font-mono">{DEV_USER_EMAIL}</span> with the
            password <span className="font-mono">{DEV_USER_PASSWORD}</span>,
            which <span className="font-mono">pnpm db:seed</span> creates.
          </p>
        ) : null}
      </div>
    </main>
  );
}
