"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import {
  Eye,
  KeyRound,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
} from "lucide-react";
import {
  ACCOUNTING_CURRENCIES,
  type ExchangeAccountMode,
  type ExchangeAccountSummary,
  type ExchangeAccountsState,
} from "@crypto-trading/exchanges/exchange-accounts";
import type { ExchangeKeysRequest } from "@crypto-trading/exchanges/settings";
import {
  accountModes,
  type Venue,
  type VenueId,
} from "@crypto-trading/exchanges/venues";

import {
  addAccount,
  removeAccount,
  renameAccount,
  replaceAccountKeys,
  testAccount,
} from "@/app/settings-actions";
import { Choice, Field } from "@/components/form-fields";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  KEY_TYPE_LABELS,
  MODE_LABELS,
  STATUS_LABELS,
  accountVenue,
  addableVenues,
  describeFeatures,
  isReadOnly,
  signingChoices,
  type Signing,
} from "@/lib/exchange-account-display";
import { formatUtc } from "@/lib/format";
import type { SettingsActionResult } from "@/lib/settings";
import type { WorkerState } from "@/lib/worker-client";

const SOURCES: Record<ExchangeAccountSummary["keys"]["source"], string> = {
  saved: "Saved in Settings",
  environment: "From the worker's .env",
  none: "No keys",
};
// Where to create keys, for venues whose page is known.
const KEY_HINTS: Partial<Record<VenueId, string>> = {
  "binance-spot-testnet":
    "Create an API key at testnet.binance.vision with account-read and trading permissions, and without withdrawals.",
  "binance-spot":
    "Create an API key in Binance API Management with Spot trading and account read permissions enabled, and without withdrawals.",
  htx: "Create an API key in HTX's API Management with Spot Trade and Read permissions enabled, and without withdraw permission. Enter its Access Key and Secret Key.",
};

/**
 * Settings → Exchange accounts: the customer's accounts, each with its own
 * keys, and a form to add one. A plain list for M4; the connection wizard
 * and account switcher come later.
 */
export function ExchangeAccountsPanel({
  state,
}: {
  state: WorkerState<{ exchangeAccounts: ExchangeAccountsState }>;
}) {
  if (state.status !== "connected")
    return (
      <Alert variant="destructive">
        <KeyRound />
        <AlertTitle>Exchange accounts are unavailable</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  const { accounts, canSave } = state.exchangeAccounts;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
      <section aria-labelledby="exchange-accounts-heading" className="min-w-0">
        <h2 className="sr-only" id="exchange-accounts-heading">
          Your exchange accounts
        </h2>
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
        {accounts.length ? (
          <ul className="space-y-4">
            {accounts.map((account) => (
              <li key={account.id}>
                <AccountCard account={account} canSave={canSave} />
              </li>
            ))}
          </ul>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>No exchange accounts yet</CardTitle>
              <CardDescription className="leading-6">
                Add one to see its balances and orders, and to trade on a
                testnet.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </section>
      <AddAccountForm canSave={canSave} />
    </div>
  );
}

function AccountCard({
  account,
  canSave,
}: {
  account: ExchangeAccountSummary;
  canSave: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SettingsActionResult>();
  const [editing, setEditing] = useState<"label" | "keys">();
  const [confirming, setConfirming] = useState(false);
  const run = (action: () => Promise<SettingsActionResult>) =>
    startTransition(async () => setResult(await action()));
  const venue = accountVenue(account.venue);
  const { keys } = account;
  const target = { exchangeAccountId: account.id };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="break-words">{account.label}</CardTitle>
        <CardDescription className="flex flex-wrap gap-1.5 pt-1">
          <Badge variant="outline">{venue?.name ?? account.venue}</Badge>
          <Badge variant="secondary">{MODE_LABELS[account.mode]}</Badge>
          <Badge
            variant={account.status === "connected" ? "outline" : "destructive"}
          >
            {STATUS_LABELS[account.status]}
          </Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {venue && isReadOnly(venue) ? <ReadOnlyNote venue={venue} /> : null}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
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
          <dt className="text-muted-foreground">Keys</dt>
          <dd>
            {SOURCES[keys.source]}
            {keys.keyType ? `, ${KEY_TYPE_LABELS[keys.keyType]}` : ""}
            {keys.hasPassphrase ? ", with passphrase" : ""}
          </dd>
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
          <dt className="text-muted-foreground">Accounting</dt>
          <dd>{account.accountingCurrency}</dd>
          <dt className="text-muted-foreground">Supports</dt>
          <dd>
            {account.supportedFeatures
              ? describeFeatures(account.supportedFeatures)
              : "Recorded when the account next connects. Test the connection."}
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
            onClick={() => run(() => testAccount(target))}
            variant="outline"
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
            Test connection
          </Button>
          <Button
            aria-expanded={editing === "label"}
            disabled={pending}
            onClick={() =>
              setEditing(editing === "label" ? undefined : "label")
            }
            variant="outline"
          >
            <Pencil />
            Rename
          </Button>
          <Button
            aria-expanded={editing === "keys"}
            disabled={pending || !venue}
            onClick={() => setEditing(editing === "keys" ? undefined : "keys")}
            variant="outline"
          >
            <KeyRound />
            Replace keys
          </Button>
          <Button
            disabled={pending}
            onClick={() => setConfirming(true)}
            variant="destructive"
          >
            <Trash2 />
            Remove
          </Button>
        </div>
        {editing === "label" ? (
          <RenameForm
            account={account}
            onDone={(outcome) => {
              setResult(outcome);
              if (outcome.result === "saved") setEditing(undefined);
            }}
          />
        ) : null}
        {editing === "keys" && venue ? (
          <ReplaceKeysForm
            account={account}
            canSave={canSave}
            onDone={(outcome) => {
              setResult(outcome);
              if (outcome.result === "saved") setEditing(undefined);
            }}
            venue={venue}
          />
        ) : null}
        <ActionMessage result={result} />
      </CardContent>

      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {account.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The worker deletes its keys and stops reading and trading it. Its
              orders and fills stay in your history. It is refused while
              strategies run there or the worker still manages orders or
              positions on it: close those first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep account</AlertDialogCancel>
            <Button
              className="dark:bg-destructive/10"
              onClick={() => {
                setConfirming(false);
                run(() => removeAccount(target));
              }}
              variant="destructive"
            >
              Remove account
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ReadOnlyNote({ venue }: { venue: Venue }) {
  return (
    <Alert>
      <Eye />
      <AlertTitle>Read only</AlertTitle>
      <AlertDescription>
        The product only monitors {venue.name} accounts and never trades them.
        Use a key with read permission only, without trade or withdraw
        permission: the worker refuses keys that can do more wherever{" "}
        {venue.name} reports a key&apos;s permissions.
      </AlertDescription>
    </Alert>
  );
}

/**
 * The customer's word that a read-only venue's key can neither trade nor
 * withdraw. The worker needs it only when the venue will not report the
 * key's permissions, as HTX will not for a sub-account's key (ADR 0013).
 */
function ReadOnlyConfirmation({
  venue,
  checked,
  onChange,
}: {
  venue: Venue;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label className="flex items-start gap-2 text-sm" htmlFor={id}>
        <input
          aria-describedby={`${id}-hint`}
          checked={checked}
          className="mt-0.5 size-4 shrink-0 accent-primary"
          id={id}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        This key has read permission only: it can neither trade nor withdraw.
      </label>
      <p className="text-xs leading-5 text-muted-foreground" id={`${id}-hint`}>
        Needed when {venue.name} will not report a key&apos;s permissions, as
        for a sub-account&apos;s key. Otherwise the worker checks them itself.
      </p>
    </div>
  );
}

function RenameForm({
  account,
  onDone,
}: {
  account: ExchangeAccountSummary;
  onDone: (result: SettingsActionResult) => void;
}) {
  const [label, setLabel] = useState(account.label);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () =>
      onDone(await renameAccount({ exchangeAccountId: account.id, label })),
    );
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
      onSubmit={submit}
    >
      <Field
        disabled={pending}
        label="Label"
        maxLength={64}
        onChange={setLabel}
        required
        value={label}
        wrapperClassName="min-w-48 flex-1"
      />
      <Button disabled={pending} type="submit">
        {pending ? <LoaderCircle className="animate-spin" /> : null}
        Save label
      </Button>
    </form>
  );
}

function ReplaceKeysForm({
  account,
  venue,
  canSave,
  onDone,
}: {
  account: ExchangeAccountSummary;
  venue: Venue;
  canSave: boolean;
  onDone: (result: SettingsActionResult) => void;
}) {
  const keys = useKeyFields(venue);
  const [readOnlyConfirmed, setReadOnlyConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const outcome = await replaceAccountKeys({
        exchangeAccountId: account.id,
        credentials: keys.request(),
        ...(isReadOnly(venue) && readOnlyConfirmed
          ? { confirmReadOnly: true }
          : {}),
      });
      // The keys leave the browser's memory once the worker has them.
      if (outcome.result === "saved") {
        keys.clear();
        setReadOnlyConfirmed(false);
      }
      onDone(outcome);
    });
  };
  return (
    <form className="space-y-4 border-t border-border pt-4" onSubmit={submit}>
      <fieldset className="space-y-4" disabled={!canSave || pending}>
        <legend className="text-sm font-medium">New keys</legend>
        <KeyFields fields={keys} venue={venue} />
        {isReadOnly(venue) ? (
          <ReadOnlyConfirmation
            checked={readOnlyConfirmed}
            onChange={setReadOnlyConfirmed}
            venue={venue}
          />
        ) : null}
      </fieldset>
      <Button disabled={!canSave || pending} type="submit">
        {pending ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
        Replace keys
      </Button>
    </form>
  );
}

function AddAccountForm({ canSave }: { canSave: boolean }) {
  const venues = addableVenues();
  const [venueId, setVenueId] = useState<VenueId | undefined>(venues[0]?.id);
  const venue = venues.find((item) => item.id === venueId);
  const modes = venue ? accountModes(venue) : [];
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<ExchangeAccountMode | undefined>(modes[0]);
  const [currency, setCurrency] = useState<string>(ACCOUNTING_CURRENCIES[0]);
  const keys = useKeyFields(venue);
  const [readOnlyConfirmed, setReadOnlyConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SettingsActionResult>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!venue) return;
    startTransition(async () => {
      const outcome = await addAccount({
        venue: venue.id,
        label,
        mode,
        accountingCurrency: currency,
        credentials: keys.request(),
        ...(isReadOnly(venue) && readOnlyConfirmed
          ? { confirmReadOnly: true }
          : {}),
      });
      setResult(outcome);
      // The keys leave the browser's memory once the worker has them.
      if (outcome.result === "saved") {
        keys.clear();
        setLabel("");
        setReadOnlyConfirmed(false);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add an exchange account</CardTitle>
        <CardDescription className="leading-6">
          Each account has its own keys. The execution worker stores them
          encrypted and never shows them again, logs them or gives them to the
          assistant. Never attach keys with withdrawal permissions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!venue ? (
          <p className="text-sm text-muted-foreground">
            No venue can be added in this build.
          </p>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <fieldset className="space-y-4" disabled={!canSave || pending}>
              {venues.length > 1 ? (
                <Choice
                  label="Venue"
                  onChange={(id: VenueId) => {
                    const next = venues.find((item) => item.id === id);
                    setVenueId(id);
                    setMode(next ? accountModes(next)[0] : undefined);
                    keys.clear();
                    setReadOnlyConfirmed(false);
                  }}
                  options={venues.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                  value={venue.id}
                />
              ) : (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Venue</p>
                  <p className="text-sm">{venue.name}</p>
                </div>
              )}
              {isReadOnly(venue) ? <ReadOnlyNote venue={venue} /> : null}
              <Field
                label="Label"
                maxLength={64}
                onChange={setLabel}
                placeholder={venue.name}
                required
                value={label}
              />
              <Choice
                label="Mode"
                onChange={setMode}
                options={modes.map((value) => ({
                  value,
                  label: MODE_LABELS[value],
                }))}
                value={mode ?? modes[0]}
              />
              <Choice
                label="Accounting currency"
                onChange={setCurrency}
                options={ACCOUNTING_CURRENCIES.map((value) => ({
                  value,
                  label: value,
                }))}
                value={currency}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {KEY_HINTS[venue.id] ??
                  "Create an API key used only by this product, without withdraw permission."}
              </p>
              <KeyFields fields={keys} venue={venue} />
              {isReadOnly(venue) ? (
                <ReadOnlyConfirmation
                  checked={readOnlyConfirmed}
                  onChange={setReadOnlyConfirmed}
                  venue={venue}
                />
              ) : null}
            </fieldset>
            <Button disabled={!canSave || pending} type="submit">
              {pending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              Add account
            </Button>
            <ActionMessage result={result} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** The key fields' state, and the request they make. */
function useKeyFields(venue: Venue | undefined) {
  const choices = venue ? signingChoices(venue) : [];
  const [chosen, setSigning] = useState<Signing>();
  const signing =
    choices.find((choice) => choice.value === chosen)?.value ??
    choices[0]?.value ??
    "hmac";
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const needsPassphrase = venue?.credentials.passphrase ?? false;
  return {
    choices,
    signing,
    apiKey,
    secret,
    passphrase,
    needsPassphrase,
    setSigning: (value: Signing) => {
      setSigning(value);
      setSecret("");
    },
    setApiKey,
    setSecret,
    setPassphrase,
    clear() {
      setApiKey("");
      setSecret("");
      setPassphrase("");
    },
    request(): ExchangeKeysRequest {
      const extra = needsPassphrase ? { passphrase } : {};
      return signing === "hmac"
        ? {
            kind: "hmac",
            apiKey: apiKey.trim(),
            secretKey: secret.trim(),
            ...extra,
          }
        : {
            kind: "private_key",
            apiKey: apiKey.trim(),
            privateKey: secret,
            ...extra,
          };
    },
  };
}

function KeyFields({
  venue,
  fields,
}: {
  venue: Venue;
  fields: ReturnType<typeof useKeyFields>;
}) {
  const id = useId();
  return (
    <>
      <Field
        autoComplete="off"
        className="font-mono"
        label="API key"
        onChange={fields.setApiKey}
        required
        spellCheck={false}
        value={fields.apiKey}
      />
      {fields.choices.length > 1 ? (
        <Choice
          label="Signing"
          onChange={fields.setSigning}
          options={fields.choices}
          value={fields.signing}
        />
      ) : null}
      {fields.signing === "hmac" ? (
        <Field
          autoComplete="off"
          className="font-mono"
          label="Secret key"
          onChange={fields.setSecret}
          required
          spellCheck={false}
          type="password"
          value={fields.secret}
        />
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-pem`}>Private key</Label>
          <Textarea
            aria-describedby={`${id}-pem-hint`}
            autoComplete="off"
            className="max-h-48 min-h-28 font-mono text-xs md:text-xs"
            id={`${id}-pem`}
            onChange={(event) => fields.setSecret(event.target.value)}
            placeholder="-----BEGIN PRIVATE KEY-----"
            required
            spellCheck={false}
            value={fields.secret}
          />
          <p className="text-xs text-muted-foreground" id={`${id}-pem-hint`}>
            The unencrypted PEM private key whose public key you registered with{" "}
            {venue.name}.
          </p>
        </div>
      )}
      {fields.needsPassphrase ? (
        <Field
          autoComplete="off"
          hint={`The passphrase you set when you created the key at ${venue.name}.`}
          label="Passphrase"
          onChange={fields.setPassphrase}
          required
          spellCheck={false}
          type="password"
          value={fields.passphrase}
        />
      ) : null}
    </>
  );
}
