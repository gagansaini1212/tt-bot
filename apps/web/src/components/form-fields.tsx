"use client";

import { useId, type ComponentProps } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** A labelled text input with an optional hint. */
export function Field({
  label,
  hint,
  onChange,
  wrapperClassName,
  ...props
}: Omit<ComponentProps<typeof Input>, "onChange"> & {
  label: string;
  hint?: string;
  onChange: (value: string) => void;
  // For the field and its label together, such as its grid span.
  wrapperClassName?: string;
}) {
  const id = useId();
  return (
    <div className={cn("min-w-0 space-y-1.5", wrapperClassName)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={hint ? `${id}-hint` : undefined}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
      {hint ? (
        <p className="text-xs text-muted-foreground" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A segmented control built from radio buttons. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg border border-border bg-background/40 p-0.5">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label
              className={cn(
                buttonVariants({
                  variant: selected ? "secondary" : "ghost",
                  size: "sm",
                }),
                "cursor-pointer has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                selected ? undefined : "text-muted-foreground",
              )}
              key={option.value}
            >
              <input
                checked={selected}
                className="sr-only"
                name={name}
                onChange={() => onChange(option.value)}
                type="radio"
                value={option.value}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
