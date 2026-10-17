/*
 * Adapted from Spectrum UI TextStates (transitions.dev text-states-swap recipe):
 * https://github.com/arihantcodes/spectrum-ui/blob/main/components/spectrumui/text-states.tsx
 * Licensed under Apache-2.0.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import "./feedback.css";

export function TextStates({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const element = ref.current;
    if (reducedMotion) setShown(text);
    if (!element || text === shown || reducedMotion) {
      element?.classList.remove("is-exit");
      return;
    }
    element.classList.add("is-exit");
    const timer = window.setTimeout(() => setShown(text), 150);
    return () => window.clearTimeout(timer);
  }, [text, shown, reducedMotion]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element?.classList.contains("is-exit")) return;
    element.classList.remove("is-exit");
    element.classList.add("is-enter-start");
    void element.offsetHeight;
    element.classList.remove("is-enter-start");
  }, [shown]);

  return (
    <span
      className={cn("spectrum-text-states", className)}
      role="status"
      aria-atomic="true"
    >
      <span ref={ref} className="spectrum-text-swap">
        {reducedMotion ? text : shown}
      </span>
    </span>
  );
}
