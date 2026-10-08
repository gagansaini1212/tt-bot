"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  Info,
  LoaderCircle,
  OctagonAlert,
  Send,
  Trash2,
  Webhook,
} from "lucide-react";
import type { Notification } from "@crypto-trading/exchanges/execution";
import type { WebhookStatus } from "@crypto-trading/exchanges/settings";

import {
  changeWebhook,
  deleteWebhook,
  readAllNotifications,
  testWebhook,
} from "@/app/settings-actions";
import { ActionMessage } from "@/components/settings/action-message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatUtc } from "@/lib/format";
import type { SettingsActionResult } from "@/lib/settings";
import type { WorkerState } from "@/lib/worker-client";
import { cn } from "@/lib/utils";

const KINDS = { discord: "Discord", telegram: "Telegram" } as const;
const SEVERITY = {
  info: {
    label: "Info",
    icon: Info,
    tone: "text-muted-foreground",
  },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    tone: "text-amber-700 dark:text-amber-400",
  },
  critical: {
    label: "Critical",
    icon: OctagonAlert,
    tone: "text-destructive",
  },
} as const;

export function NotificationsPanel({
  webhook,
  notifications,
}: {
  webhook: WorkerState<{ webhook: WebhookStatus }>;
  notifications: WorkerState<{ notifications: Notification[] }>;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
      <WebhookCard state={webhook} />
      <HistoryCard state={notifications} />
    </div>
  );
}

function WebhookCard({
  state,
}: {
  state: WorkerState<{ webhook: WebhookStatus }>;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SettingsActionResult>();
  const run = (action: () => Promise<SettingsActionResult>) =>
    startTransition(async () => setResult(await action()));

  if (state.status !== "connected")
    return (
      <Alert variant="destructive">
        <Webhook />
        <AlertTitle>Webhook settings are unavailable</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  const { webhook, canSave } = state.webhook;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const outcome = await changeWebhook({ url });
      setResult(outcome);
      if (outcome.result === "saved") setUrl("");
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trade alert webhook</CardTitle>
        <CardDescription className="leading-6">
          Optional. Every alert below is also posted to a Discord channel or a
          Telegram chat. Failed posts are retried with backoff, eight times over
          about 45 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Webhook</dt>
          <dd>
            {webhook ? (
              <>
                {KINDS[webhook.kind]}, token ending{" "}
                <span className="font-mono">{webhook.last4}</span>
              </>
            ) : (
              "None"
            )}
          </dd>
          {webhook ? (
            <>
              <dt className="text-muted-foreground">Last changed</dt>
              <dd>
                <time dateTime={webhook.updatedAt}>
                  {formatUtc(Date.parse(webhook.updatedAt))}
                </time>
              </dd>
            </>
          ) : null}
        </dl>
        {webhook ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending}
              onClick={() => run(testWebhook)}
              variant="outline"
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Send />}
              Send test
            </Button>
            <Button
              disabled={pending}
              onClick={() => run(deleteWebhook)}
              variant="destructive"
            >
              <Trash2 />
              Remove
            </Button>
          </div>
        ) : null}
        {!canSave ? (
          <Alert>
            <Webhook />
            <AlertTitle>The worker cannot save webhooks yet</AlertTitle>
            <AlertDescription>
              Set CREDENTIALS_MASTER_KEY in apps/execution/.env, then restart
              the worker. The URL holds a token, so it is stored encrypted.
            </AlertDescription>
          </Alert>
        ) : null}
        <form className="space-y-3" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor={id}>
              {webhook ? "Replace the webhook URL" : "Webhook URL"}
            </Label>
            <Input
              aria-describedby={`${id}-hint`}
              autoComplete="off"
              className="font-mono"
              disabled={!canSave || pending}
              id={id}
              inputMode="url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              required
              spellCheck={false}
              value={url}
            />
            <p
              className="text-xs leading-5 text-muted-foreground"
              id={`${id}-hint`}
            >
              Discord: copy the URL from the channel&apos;s Integrations →
              Webhooks. Telegram:
              https://api.telegram.org/bot&lt;token&gt;/sendMessage?chat_id=&lt;chat
              ID&gt;. The URL is never shown again.
            </p>
          </div>
          <Button disabled={!canSave || pending} type="submit">
            <Webhook />
            Save webhook
          </Button>
        </form>
        <ActionMessage result={result} />
      </CardContent>
    </Card>
  );
}

function HistoryCard({
  state,
}: {
  state: WorkerState<{ notifications: Notification[] }>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SettingsActionResult>();
  if (state.status !== "connected")
    return (
      <Alert variant="destructive">
        <Bell />
        <AlertTitle>Alert history is unavailable</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  const { notifications } = state;
  const unread = notifications.filter((entry) => !entry.readAt).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alert history</CardTitle>
        <CardDescription className="leading-6">
          In-app alerts from the execution worker, such as an order whose
          outcome is unknown or a position without exits. Latest 50, newest
          first.
        </CardDescription>
        {unread > 0 ? (
          <CardAction>
            <Button
              disabled={pending}
              onClick={() =>
                startTransition(async () =>
                  setResult(await readAllNotifications()),
                )
              }
              size="sm"
              variant="outline"
            >
              <CheckCheck />
              Mark all read
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {result?.result !== "done" ? <ActionMessage result={result} /> : null}
        {notifications.length ? (
          <ol className="divide-y divide-border">
            {notifications.map((entry) => (
              <NotificationItem key={entry.id} notification={entry} />
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            No alerts yet. They appear here as the execution worker raises them.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function NotificationItem({ notification }: { notification: Notification }) {
  const severity = SEVERITY[notification.severity];
  const Icon = severity.icon;
  const unread = !notification.readAt;
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", severity.tone)}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p
            className={cn("text-sm", unread ? "font-semibold" : "font-medium")}
          >
            {notification.title}
          </p>
          <Badge
            variant={
              notification.severity === "critical" ? "destructive" : "outline"
            }
          >
            {severity.label}
          </Badge>
          {unread ? (
            <span className="text-xs font-medium text-foreground">
              <span
                aria-hidden
                className="mr-1 inline-block size-1.5 rounded-full bg-primary align-middle"
              />
              Unread
            </span>
          ) : null}
        </div>
        <p className="text-sm break-words whitespace-pre-line text-muted-foreground">
          {notification.body}
        </p>
        <p className="text-xs text-muted-foreground">
          <time dateTime={notification.createdAt}>
            {formatUtc(Date.parse(notification.createdAt))}
          </time>
        </p>
      </div>
    </li>
  );
}
