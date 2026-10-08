"use client";

import { useId, useState, type FormEvent } from "react";
import { AlertTriangle, LoaderCircle, LogIn } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

function failureMessage(status: number) {
  if (status === 401 || status === 400)
    return "The email or password is incorrect.";
  if (status === 429)
    return "Too many attempts. Wait a minute, then try again.";
  return "Sign-in is unavailable. Try again, and check the web server's output if it continues.";
}

export function SignInForm({
  next,
  email: initialEmail = "",
  reauthenticate = false,
}: {
  /** A path on this site to open once signed in. */
  next: string;
  email?: string;
  /** Confirming the password of the customer already signed in. */
  reauthenticate?: boolean;
}) {
  const id = useId();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    let status: number | undefined;
    try {
      const result = await authClient.signIn.email({ email, password });
      status = result.error ? (result.error.status ?? 500) : undefined;
    } catch {
      status = 500;
    }
    if (status !== undefined) {
      setError(failureMessage(status));
      setPending(false);
      return;
    }
    // A full load, so every page and the assistant start over as this
    // customer, and Back does not return to the form.
    window.location.replace(next);
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input
          autoComplete="username"
          autoFocus={!reauthenticate}
          id={`${id}-email`}
          onChange={(event) => setEmail(event.target.value)}
          readOnly={reauthenticate}
          required
          type="email"
          value={email}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-password`}>Password</Label>
        <Input
          autoComplete="current-password"
          autoFocus={reauthenticate}
          id={`${id}-password`}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>
      {error ? (
        <Alert role="status" variant="destructive">
          <AlertTriangle />
          <AlertTitle>Not signed in</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button className="w-full" disabled={pending} size="lg" type="submit">
        {pending ? <LoaderCircle className="animate-spin" /> : <LogIn />}
        {reauthenticate ? "Confirm password" : "Sign in"}
      </Button>
    </form>
  );
}
