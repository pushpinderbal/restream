/*
 * Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui).
 * Licensed under Apache-2.0.
 */
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

const loaderVariants = cva("animate-spin text-primary", {
  variants: {
    size: {
      small: "size-4",
      medium: "size-8",
      large: "size-12",
    },
  },
  defaultVariants: { size: "medium" },
});

interface SpinnerProps extends VariantProps<typeof loaderVariants> {
  className?: string;
}

export function Spinner({ size, className }: SpinnerProps) {
  return (
    <span
      className="flex flex-col items-center justify-center"
      aria-hidden="true"
    >
      <LoaderCircle className={cn(loaderVariants({ size }), className)} />
    </span>
  );
}
