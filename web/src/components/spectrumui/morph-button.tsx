/*
 * Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui).
 * Licensed under Apache-2.0.
 */
import React, { useCallback } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";
import { buttonVariants } from "../ui/button";

type MorphButtonState = "idle" | "loading" | "success" | "error";

interface MorphButtonProps {
  children: React.ReactNode;

  state: MorphButtonState;

  onClick?: React.MouseEventHandler<HTMLButtonElement>;

  loadingLabel?: string;

  successLabel?: string;

  errorLabel?: string;

  size?: "sm" | "md" | "lg";

  variant?: VariantProps<typeof buttonVariants>["variant"];

  disabled?: boolean;
  className?: string;
}

const SPRING_SNAPPY = { type: "spring", stiffness: 500, damping: 30 } as const;

const SPRING_SOFT = { type: "spring", stiffness: 260, damping: 22 } as const;

const EASE_REVEAL: [number, number, number, number] = [0.22, 1, 0.36, 1];

const CONTENT_SHIFT = 8;

const CONTENT_DURATION = 0.3;

const DRAW_DURATION = 0.25;

const SHAKE_KEYFRAMES = [0, -3, 3, -2, 2, 0];

const SHAKE_DURATION = 0.25;

const SPINNER_ARC = 0.75;

const SPINNER_RADIUS = 10;

const SIZES = {
  sm: { button: "sm", icon: 16 },
  md: { button: "default", icon: 16 },
  lg: { button: "lg", icon: 18 },
} as const;

const CHECK_PATH = "M5 13l4.5 4.5L19 7";
const X_PATHS = ["M7 7l10 10", "M17 7L7 17"];

function SpinnerIcon({ size }: { size: number }) {
  const circumference = 2 * Math.PI * SPINNER_RADIUS;
  return (
    <motion.svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className="motion-safe:animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r={SPINNER_RADIUS}
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${circumference * SPINNER_ARC} ${circumference}`}
      />
    </motion.svg>
  );
}

function DrawnIcon({
  paths,
  size,
  instant,
}: {
  paths: string[];
  size: number;
  instant: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d, index) => (
        <motion.path
          key={d}
          d={d}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={
            instant
              ? { duration: 0 }
              : {
                  duration: DRAW_DURATION,
                  ease: EASE_REVEAL,
                  delay: index * 0.05,
                }
          }
        />
      ))}
    </svg>
  );
}

export function MorphButton({
  children,
  state,
  onClick,
  loadingLabel,
  successLabel = "Done",
  errorLabel = "Failed",
  size = "md",
  variant = "outline",
  disabled = false,
  className,
}: MorphButtonProps) {
  const shouldReduceMotion = useReducedMotion();
  const interactive = state === "idle" && !disabled;
  const { button: buttonSize, icon: iconSize } = SIZES[size];
  const buttonVariant = state === "error" ? "destructive" : variant;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!interactive) return;
      onClick?.(event);
    },
    [interactive, onClick],
  );

  const announcement =
    state === "loading"
      ? (loadingLabel ?? "Loading")
      : state === "success"
        ? successLabel
        : state === "error"
          ? errorLabel
          : "";

  let content: React.ReactNode;
  if (state === "loading") {
    content = (
      <>
        <SpinnerIcon size={iconSize} />
        {loadingLabel && <span>{loadingLabel}</span>}
      </>
    );
  } else if (state === "success") {
    content = (
      <>
        <motion.span
          className="inline-flex"
          initial={shouldReduceMotion ? false : { scale: 0.6 }}
          animate={{ scale: 1 }}
          transition={SPRING_SOFT}
        >
          <DrawnIcon
            paths={[CHECK_PATH]}
            size={iconSize}
            instant={!!shouldReduceMotion}
          />
        </motion.span>
        {successLabel && <span>{successLabel}</span>}
      </>
    );
  } else if (state === "error") {
    content = (
      <>
        <DrawnIcon
          paths={X_PATHS}
          size={iconSize}
          instant={!!shouldReduceMotion}
        />
        {errorLabel && <span>{errorLabel}</span>}
      </>
    );
  } else {
    content = children;
  }

  return (
    <motion.button
      type="button"
      layout
      onClick={handleClick}
      disabled={disabled}
      aria-disabled={!interactive || undefined}
      aria-busy={state === "loading" || undefined}
      aria-label={
        announcement || (typeof children === "string" ? children : undefined)
      }
      data-state={state}
      data-slot="button"
      data-variant={buttonVariant}
      data-size={buttonSize}
      whileTap={
        interactive && !shouldReduceMotion ? { scale: 0.97 } : undefined
      }
      animate={
        state === "error" && !shouldReduceMotion
          ? { x: SHAKE_KEYFRAMES }
          : { x: 0 }
      }
      transition={{
        layout: shouldReduceMotion ? { duration: 0 } : SPRING_SNAPPY,
        scale: SPRING_SNAPPY,
        x: { duration: SHAKE_DURATION, ease: "easeInOut" },
      }}
      className={cn(
        buttonVariants({ variant: buttonVariant, size: buttonSize }),
        "relative select-none overflow-hidden",
        !interactive && "pointer-events-none",
        className,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state}
          className="inline-flex items-center justify-center gap-[8px] whitespace-nowrap"
          initial={{ y: CONTENT_SHIFT, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -CONTENT_SHIFT, opacity: 0 }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : { duration: CONTENT_DURATION, ease: EASE_REVEAL }
          }
        >
          {content}
        </motion.span>
      </AnimatePresence>
      <span aria-live="polite" role="status" className="sr-only">
        {announcement}
      </span>
    </motion.button>
  );
}
