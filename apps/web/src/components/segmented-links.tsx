import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A row of links that works like a segmented control, one per view. */
export function SegmentedLinks({
  label,
  items,
  className,
}: {
  label: string;
  items: { href: string; label: string; current: boolean }[];
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex w-fit gap-0.5 rounded-lg border border-border bg-background/40 p-0.5",
        className,
      )}
    >
      {items.map((item) => (
        <Link
          aria-current={item.current ? "page" : undefined}
          className={cn(
            buttonVariants({
              variant: item.current ? "secondary" : "ghost",
              size: "sm",
            }),
            item.current ? undefined : "text-muted-foreground",
          )}
          href={item.href}
          key={item.href}
          scroll={false}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
