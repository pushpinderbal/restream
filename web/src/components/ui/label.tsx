import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "mb-[8px] block text-[13px] font-medium leading-[20px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
