/*
 * Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui).
 * Licensed under Apache-2.0.
 */
import type React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

const spinnerVariants = cva("flex-col items-center justify-center", {
  variants: {
    show: {
      true: "flex",
      false: "hidden",
    },
  },
  defaultVariants: { show: true },
});

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

interface SpinnerProps
  extends VariantProps<typeof spinnerVariants>,
    VariantProps<typeof loaderVariants> {
  className?: string;
  children?: React.ReactNode;
}

export function Spinner({ size, show, children, className }: SpinnerProps) {
  return (
    <span className={spinnerVariants({ show })} aria-hidden="true">
      <LoaderCircle className={cn(loaderVariants({ size }), className)} />
      {children}
    </span>
  );
}
