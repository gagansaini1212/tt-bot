"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { KeyRound, LoaderCircle, PlugZap, Trash2 } from "lucide-react";
import type {
  ExchangeKeyType,
  ExchangeKeysStatus,
} from "@crypto-trading/exchanges/settings";

import {
  changeExchangeKeys,
  checkExchangeConnection,
  deleteExchangeKeys,
} from "@/app/settings-actions";
import { ActionMessage } from "@/components/settings/action-message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatUtc } from "@/lib/format";
import type { SettingsActionResult } from "@/lib/settings";
import type { WorkerState } from "@/lib/worker-client";
import { cn } from "@/lib/utils";

const KEY_TYPES: Record<ExchangeKeyType, string> = {
  hmac: "HMAC",
  ed25519: "Ed25519",
  rsa: "RSA",
};
const SOURCES: Record<ExchangeKeysStatus["source"], string> = {
  saved: "Saved in Settings",
  environment: "From the worker's .env",
  none: "No keys",
};

type Signing = "hmac" | "private_key";

export function ExchangeKeysPanel({
  state,
}: {
  state: WorkerState<{ keys: ExchangeKeysStatus }>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SettingsActionResult>();
  const [confirming, setConfirming] = useState(false);
  const run = (action: () => Promise<SettingsActionResult>) =>
    startTransition(async () => setResult(await action()));

  if (state.status !== "connected")
    return (
      <Alert variant="destructive">
        <KeyRound />
        <AlertTitle>Exchange keys are unavailable</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  const { keys } = state;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
      <Card>
        <CardHeader>
          <CardTitle>Binance Spot Testnet</CardTitle>
          <CardDescription className="leading-6">
            The keys the execution worker trades with. Testnet funds are
            virtual, and live trading is turned off in the worker.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Source</dt>
            <dd>
              <Badge variant={keys.source === "none" ? "outline" : "secondary"}>
                {SOURCES[keys.source]}
              </Badge>
            </dd>
            <dt className="text-muted-foreground">API key</dt>
            <dd className="font-mono">
              {keys.apiKeyLast4 ? (
                <>
                  <span aria-hidden>••••••••</span>
                  <span className="sr-only">ending in </span>
                  {keys.apiKeyLast4}
                </>
              ) : (
                "None"
              )}
            </dd>
            {keys.keyType ? (
              <>
                <dt className="text-muted-foreground">Signing</dt>
                <dd>{KEY_TYPES[keys.keyType]}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Last changed</dt>
            <dd>
              {keys.updatedAt ? (
                <time dateTime={keys.updatedAt}>
                  {formatUtc(Date.parse(keys.updatedAt))}
                </time>
              ) : keys.source === "environment" ? (
                "Set in apps/execution/.env"
              ) : (
                "Never"
              )}
            </dd>
          </dl>
          {keys.problem ? (
            <Alert variant="destructive">
              <KeyRound />
              <AlertDescription className="text-destructive">
                {keys.problem}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending || keys.source === "none"}
              onClick={() => run(checkExchangeConnection)}
              variant="outline"
            >
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <PlugZap />
              )}
              Test connection
            </Button>
            {keys.source === "saved" ? (
              <Button
                disabled={pending}
                onClick={() => setConfirming(true)}
                variant="destructive"
              >
                <Trash2 />
                Remove saved keys
              </Button>
            ) : null}
          </div>
          <ActionMessage result={result} />
        </CardContent>
      </Card>

      <KeysForm
        canSave={keys.canSave}
        onResult={setResult}
        replacing={keys.source === "saved"}
      />

      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the saved keys?</AlertDialogTitle>
            <AlertDialogDescription>
              The worker deletes them. It then uses the keys in its .env file,
              if it has any, or cannot reach the account until you add keys
              again. Open orders stay on Binance.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep keys</AlertDialogCancel>
            <Button
              className="dark:bg-destructive/10"
              onClick={() => {
                setConfirming(false);
                run(deleteExchangeKeys);
              }}
              variant="destructive"
            >
              Remove keys
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function KeysForm({
  canSave,
  replacing,
  onResult,
}: {
  canSave: boolean;
  replacing: boolean;
  onResult: (result: SettingsActionResult) => void;
}) {
  const id = useId();
  const [signing, setSigning] = useState<Signing>("hmac");
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SettingsActionResult>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const request =
      signing === "hmac"
        ? { kind: signing, apiKey: apiKey.trim(), secretKey: secret.trim() }
        : { kind: signing, apiKey: apiKey.trim(), privateKey: secret };
    startTransition(async () => {
      const outcome = await changeExchangeKeys(request);
      setResult(outcome);
      if (outcome.result === "saved") {
        // The keys leave the browser's memory once the worker has them.
        setApiKey("");
        setSecret("");
        onResult(outcome);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{replacing ? "Replace keys" : "Add keys"}</CardTitle>
        <CardDescription className="leading-6">
          Create an API key at testnet.binance.vision with account-read and
          trading permissions. The execution worker stores it encrypted and
          never shows it again, logs it or gives it to the assistant.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!canSave ? (
          <Alert className="mb-4">
            <KeyRound />
            <AlertTitle>The worker cannot save keys yet</AlertTitle>
            <AlertDescription>
              Set CREDENTIALS_MASTER_KEY in apps/execution/.env to the output of{" "}
              <code>openssl rand -base64 32</code>, then restart the worker.
            </AlertDescription>
          </Alert>
        ) : null}
        <form className="space-y-4" onSubmit={submit}>
          <fieldset className="space-y-4" disabled={!canSave || pending}>
            <div className="space-y-2">
              <Label htmlFor={`${id}-key`}>API key</Label>
              <Input
                autoComplete="off"
                className="font-mono"
                id={`${id}-key`}
                onChange={(event) => setApiKey(event.target.value)}
                required
                spellCheck={false}
                value={apiKey}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium" id={`${id}-signing`}>
                Signing
              </p>
              <div
                aria-labelledby={`${id}-signing`}
                className="grid grid-cols-2 gap-0.5 rounded-lg border border-border bg-background/40 p-0.5"
                role="group"
              >
                {(
                  [
                    ["hmac", "Secret key (HMAC)"],
                    ["private_key", "Private key (Ed25519, RSA)"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    aria-pressed={signing === value}
                    className={cn(
                      "h-auto min-h-7 whitespace-normal",
                      signing === value ? undefined : "text-muted-foreground",
                    )}
                    key={value}
                    onClick={() => {
                      setSigning(value);
                      setSecret("");
                    }}
                    size="sm"
                    type="button"
                    variant={signing === value ? "secondary" : "ghost"}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
            {signing === "hmac" ? (
              <div className="space-y-2">
                <Label htmlFor={`${id}-secret`}>Secret key</Label>
                <Input
                  autoComplete="off"
                  className="font-mono"
                  id={`${id}-secret`}
                  onChange={(event) => setSecret(event.target.value)}
                  required
                  spellCheck={false}
                  type="password"
                  value={secret}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor={`${id}-pem`}>Private key</Label>
                <Textarea
                  aria-describedby={`${id}-pem-hint`}
                  autoComplete="off"
                  className="max-h-48 min-h-28 font-mono text-xs md:text-xs"
                  id={`${id}-pem`}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  required
                  spellCheck={false}
                  value={secret}
                />
                <p
                  className="text-xs text-muted-foreground"
                  id={`${id}-pem-hint`}
                >
                  The unencrypted PEM private key whose public key you
                  registered with Binance.
                </p>
              </div>
            )}
          </fieldset>
          <Button disabled={!canSave || pending} type="submit">
            {pending ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
            {replacing ? "Replace keys" : "Save keys"}
          </Button>
          {result?.result !== "saved" ? (
            <ActionMessage result={result} />
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
