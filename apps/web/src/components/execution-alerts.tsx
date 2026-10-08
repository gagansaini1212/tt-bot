import { AlertTriangle, BellRing, Info } from "lucide-react";
import type {
  EntryAlert,
  Notification,
} from "@crypto-trading/exchanges/execution";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ExecutionView } from "@/lib/execution";
import { alertHeadline, checkedLabel, isUrgent } from "@/lib/execution-display";
import { formatUtc } from "@/lib/format";

/**
 * Entries that hold quantity the worker is selling, or must, shown at the
 * top of the Overview until they are sold. Urgent ones are red.
 */
export function ExecutionAlerts({ alerts }: { alerts: EntryAlert[] }) {
  if (!alerts.length) return null;
  return (
    <section
      aria-label="Positions that need attention"
      className="mt-6 space-y-3"
    >
      {alerts.map((alert) => (
        <EntryAlertItem alert={alert} key={alert.listClientOrderId} />
      ))}
    </section>
  );
}

export function EntryAlertItem({ alert }: { alert: EntryAlert }) {
  const urgent = isUrgent(alert);
  return (
    <Alert
      className={urgent ? "border-destructive/60 bg-destructive/5" : undefined}
      variant={urgent ? "destructive" : "default"}
    >
      <AlertTriangle />
      <AlertTitle>{alertHeadline(alert)}</AlertTitle>
      <AlertDescription>
        <p>{alert.detail}</p>
        <p className="font-mono text-xs">
          Order {alert.listClientOrderId} · {alert.instrument.replace("-", "/")}
          {alert.overdueSince
            ? ` · deadline ${formatUtc(Date.parse(alert.overdueSince))}`
            : ""}
        </p>
      </AlertDescription>
    </Alert>
  );
}

const SEVERITY: Record<
  Notification["severity"],
  { label: string; variant: "destructive" | "outline" | "secondary" }
> = {
  critical: { label: "Critical", variant: "destructive" },
  warning: { label: "Warning", variant: "outline" },
  info: { label: "Info", variant: "secondary" },
};

/** The week's latest notifications from the execution worker. */
export function NotificationsCard({ execution }: { execution: ExecutionView }) {
  const connected = execution.status === "connected";
  const notifications = connected ? execution.execution.notifications : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4" />
          Alerts
        </CardTitle>
        <CardDescription>
          {connected
            ? checkedLabel(execution.execution.checkedAt)
            : execution.message}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {notifications.length ? (
          <ul className="space-y-3">
            {notifications.map((notification) => (
              <li className="space-y-1" key={notification.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    className={
                      notification.severity === "warning"
                        ? "border-amber-600/40 text-amber-700 dark:border-amber-400/40 dark:text-amber-300"
                        : undefined
                    }
                    variant={SEVERITY[notification.severity].variant}
                  >
                    {SEVERITY[notification.severity].label}
                  </Badge>
                  <span className="font-medium">{notification.title}</span>
                </div>
                <p className="text-muted-foreground">{notification.body}</p>
                <p className="text-xs text-muted-foreground">
                  <time dateTime={notification.createdAt}>
                    {formatUtc(Date.parse(notification.createdAt))}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Info className="size-4 shrink-0" />
            No alerts in the last 7 days.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
