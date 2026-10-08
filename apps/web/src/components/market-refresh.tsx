"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Refreshes the page every `seconds` while the tab is visible, as
 * AccountRefresh does, but often enough that the button only shows manual
 * refreshes, and a tick is skipped while the last refresh is still loading.
 */
export function MarketRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  const [polling, startPolling] = useTransition();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);

  useEffect(() => {
    busy.current = polling || pending;
  }, [polling, pending]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && !busy.current) {
        startPolling(() => router.refresh());
      }
    };
    const interval = setInterval(refresh, seconds * 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, seconds]);

  return (
    <Button
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      size="sm"
      variant="outline"
    >
      <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} />
      {pending ? "Refreshing…" : "Refresh"}
    </Button>
  );
}
