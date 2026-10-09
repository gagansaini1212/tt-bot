"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import type { ReportingCurrencyOptionView } from "@crypto-trading/exchanges/portfolio";

import { changeReportingCurrency } from "@/app/portfolio-actions";
import { ActionMessage } from "@/components/settings/action-message";
import { Button } from "@/components/ui/button";
import type { SettingsActionResult } from "@/lib/settings";

/**
 * Chooses the currency the dashboard adds every exchange account up in. A
 * currency is offered only if every account can convert into it with its
 * own venue's markets.
 */
export function ReportingCurrencyForm({
  current,
  options,
}: {
  current: string;
  options: ReportingCurrencyOptionView[];
}) {
  const [value, setValue] = useState(current);
  // Follows a change saved elsewhere, as the page refreshes.
  const [shown, setShown] = useState(current);
  if (shown !== current) {
    setShown(current);
    setValue(current);
  }
  const [result, setResult] = useState<SettingsActionResult>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const unavailable = options.filter((option) => !option.available);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () =>
      setResult(await changeReportingCurrency({ reportingCurrency: value })),
    );
  };

  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-x-3 gap-y-2"
      onSubmit={submit}
    >
      <div className="space-y-1">
        <label
          className="block text-xs font-medium text-muted-foreground"
          htmlFor={id}
        >
          Reporting currency
        </label>
        <select
          aria-describedby={`${id}-hint`}
          className="block h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
          disabled={pending}
          id={id}
          onChange={(event) => setValue(event.target.value)}
          value={value}
        >
          {options.some((option) => option.currency === current) ? null : (
            <option value={current}>{current}</option>
          )}
          {options.map((option) => (
            <option
              disabled={!option.available && option.currency !== current}
              key={option.currency}
              value={option.currency}
            >
              {option.available
                ? option.currency
                : `${option.currency} (no route)`}
            </option>
          ))}
        </select>
      </div>
      <Button
        disabled={pending || value === current}
        size="sm"
        type="submit"
        variant="outline"
      >
        {pending ? <LoaderCircle className="animate-spin" /> : null}
        Show totals in {value}
      </Button>
      <p
        className="w-full text-xs leading-5 text-muted-foreground"
        id={`${id}-hint`}
      >
        Changes only what the dashboard shows.
        {unavailable.length
          ? ` Not offered, because one of your accounts' venues has no market to convert into it: ${unavailable.map((option) => option.currency).join(", ")}.`
          : null}
      </p>
      {result ? (
        <div className="w-full">
          <ActionMessage result={result} />
        </div>
      ) : null}
    </form>
  );
}
