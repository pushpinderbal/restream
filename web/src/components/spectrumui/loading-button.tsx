/*
 * Adapted from Spectrum UI, licensed under Apache-2.0.
 * https://github.com/arihantcodes/spectrum-ui/blob/main/components/ui/loading-button.tsx
 */
import type { ComponentProps } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";

export type LoadingButtonProps = Omit<
  ComponentProps<typeof Button>,
  "asChild"
> & {
  loading?: boolean;
  loadingLabel?: string;
};

export function LoadingButton({
  loading = false,
  loadingLabel,
  children,
  onClick,
  disabled,
  type = "button",
  ...props
}: LoadingButtonProps) {
  return (
    <Button
      {...props}
      type={type}
      disabled={disabled}
      aria-label={
        props["aria-label"] ??
        (typeof children === "string" ? children : undefined)
      }
      aria-disabled={disabled || loading || undefined}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {loading && (
        <Loader2
          className="size-4 motion-safe:animate-spin"
          aria-hidden="true"
        />
      )}
      {loading && loadingLabel ? loadingLabel : children}
    </Button>
  );
}
