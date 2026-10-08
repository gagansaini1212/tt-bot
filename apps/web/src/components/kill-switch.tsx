"use client";

import { useRef, useState, useTransition } from "react";
import { LoaderCircle, OctagonX } from "lucide-react";

import { engageKillSwitch } from "@/app/kill-switch-actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Outcome = Awaited<ReturnType<typeof engageKillSwitch>>;

/**
 * The kill switch, behind a confirmation: pauses every strategy and closes
 * every entry the worker manages. `compact` shows only its icon, for the
 * phone header.
 */
export function KillSwitch({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<Outcome>();
  // Blocks a second click before the first one re-renders the button.
  const sending = useRef(false);

  const engage = () => {
    if (sending.current) return;
    sending.current = true;
    startTransition(async () => {
      try {
        setOutcome(await engageKillSwitch());
      } finally {
        sending.current = false;
      }
    });
  };

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) setOutcome(undefined);
      }}
      open={open}
    >
      <AlertDialogTrigger asChild>
        <Button
          aria-label={compact ? "Kill switch" : undefined}
          size={compact ? "icon-lg" : "default"}
          variant="destructive"
        >
          <OctagonX />
          {compact ? null : "Kill switch"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Stop all trading now?</AlertDialogTitle>
          <AlertDialogDescription>
            The kill switch acts on your Binance Spot Testnet account at once:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Every running strategy is paused.</li>
          <li>
            Every entry the worker manages, your strategies&apos; and your own
            dashboard orders, is cancelled, and what each holds is sold at
            market.
          </li>
          <li>Stop-limit entries the worker holds are cancelled.</li>
          <li>Orders you placed with the CLI or elsewhere are left alone.</li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Selling at market can fill well below the last price when the market
          moves fast. Strategies stay paused until you resume each one.
        </p>
        {outcome ? (
          <Alert
            role={outcome.result === "done" ? "status" : "alert"}
            variant={outcome.result === "done" ? "default" : "destructive"}
          >
            <AlertDescription
              className={
                outcome.result === "done"
                  ? "text-foreground"
                  : "text-destructive"
              }
            >
              {outcome.result === "done"
                ? `${outcome.pausedStrategies} strategies paused, ${outcome.closingEntries} entries closing, ${outcome.cancelledTriggers} held stop-limit entries cancelled. ${outcome.message}`
                : outcome.message}
            </AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {outcome?.result === "done" ? "Close" : "Keep trading"}
          </AlertDialogCancel>
          {outcome?.result === "done" ? null : (
            <Button
              // A lighter tint keeps the red label readable on the muted footer.
              className="dark:bg-destructive/10"
              disabled={pending}
              onClick={engage}
              variant="destructive"
            >
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <OctagonX />
              )}
              Pause and close everything
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
