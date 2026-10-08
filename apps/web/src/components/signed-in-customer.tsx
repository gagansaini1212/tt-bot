"use client";

import { useState } from "react";
import { LoaderCircle, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export type SignedInCustomerProps = {
  customer: { name: string; email: string };
};

/** Who is signed in, with a way to sign out. */
export function SignedInCustomer({ customer }: SignedInCustomerProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    let ok = false;
    try {
      ok = !(await authClient.signOut()).error;
    } catch {
      ok = false;
    }
    if (!ok) {
      setFailed(true);
      setPending(false);
      return;
    }
    // A full load, not a router navigation: it drops every page the router
    // cached for this customer and the assistant's conversation, and Back
    // does not return to this page.
    window.location.replace("/sign-in");
  }

  return (
    <div className="flex items-center gap-2 pl-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={customer.name}>
          {customer.name}
        </p>
        <p
          className="truncate text-xs text-muted-foreground"
          title={customer.email}
        >
          {customer.email}
        </p>
        {failed ? (
          <p className="text-xs text-destructive" role="status">
            Could not sign out. Try again.
          </p>
        ) : null}
      </div>
      <Button
        aria-label="Sign out"
        disabled={pending}
        onClick={signOut}
        size="icon-sm"
        title="Sign out"
        variant="outline"
      >
        {pending ? <LoaderCircle className="animate-spin" /> : <LogOut />}
      </Button>
    </div>
  );
}
