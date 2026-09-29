/*
 * Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui).
 * Licensed under Apache-2.0.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

export interface SkeletonRevealProps {
  loading: boolean;
  skeleton: React.ReactNode;
  children: React.ReactNode;
  pulseCount?: number;
  pulseDuration?: number;
  revealDuration?: number;
  className?: string;
}

export function SkeletonReveal({
  loading,
  skeleton,
  children,
  pulseCount = 1,
  pulseDuration = 1000,
  revealDuration = 400,
  className,
}: SkeletonRevealProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const wasLoading = React.useRef(loading);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (loading && !wasLoading.current) {
      element.classList.add("is-resetting");
      void element.offsetWidth;
      element.classList.remove("is-resetting");
    }
    wasLoading.current = loading;
  }, [loading]);

  return (
    <div
      ref={ref}
      className={cn("t-skel", !loading && "is-revealed", className)}
      aria-busy={loading || undefined}
      style={
        {
          "--pulse-dur": `${pulseDuration}ms`,
          "--pulse-count": pulseCount,
          "--pulse-min": 0.5,
          "--reveal-dur": `${revealDuration}ms`,
          "--reveal-blur": "2px",
          "--reveal-ease": "ease-in-out",
        } as React.CSSProperties
      }
    >
      <div
        className={cn("t-skel-skeleton", loading && "is-pulsing")}
        aria-hidden="true"
      >
        {skeleton}
      </div>
      <div className="t-skel-content">{children}</div>
    </div>
  );
}
