import { CheckCircle2, CircleX } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import type { SettingsActionResult } from "@/lib/settings";

const SUCCEEDED = new Set<SettingsActionResult["result"]>([
  "saved",
  "removed",
  "connected",
  "delivered",
  "done",
]);

/** The outcome of a Settings action, announced to screen readers. */
export function ActionMessage({ result }: { result?: SettingsActionResult }) {
  if (!result) return null;
  const succeeded = SUCCEEDED.has(result.result);
  const Icon = succeeded ? CheckCircle2 : CircleX;
  return (
    <Alert
      role={succeeded ? "status" : "alert"}
      variant={succeeded ? "default" : "destructive"}
    >
      <Icon
        className={succeeded ? "text-emerald-700 dark:text-emerald-400" : ""}
      />
      <AlertDescription
        className={succeeded ? "text-foreground" : "text-destructive"}
      >
        {result.message}
      </AlertDescription>
    </Alert>
  );
}
