/*
 * Adapted from Spectrum UI UndoPill:
 * https://github.com/arihantcodes/spectrum-ui/blob/main/components/spectrumui/undo-pill.tsx
 * Licensed under Apache-2.0.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  type Variants,
} from "motion/react";
import { cn } from "@/lib/utils";

export interface UndoPillProps {
  open: boolean;
  resetKey?: number;
  label?: string;
  duration?: number;
  onUndo: () => void;
  onExpire: () => void;
  pauseOnHover?: boolean;
  undoLabel?: string;
  className?: string;
}

type ExitReason = "undo" | "expire";

const RING_RADIUS = 7;
const RING_SIZE = 18;
const RING_CENTER = RING_SIZE / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const MAX_FRAME_DELTA_MS = 100;
const SECONDS_SWAP_DURATION = 0.15;
const UNDO_EXIT_DURATION = 0.3;
const EXPIRE_EXIT_DURATION = 0.25;

const ENTRANCE_SPRING = {
  type: "spring",
  stiffness: 500,
  damping: 30,
} as const;

export function UndoPill({
  open,
  resetKey,
  label = "Deleted",
  duration = 5,
  onUndo,
  onExpire,
  pauseOnHover = true,
  undoLabel = "Undo",
  className,
}: UndoPillProps) {
  const shouldReduceMotion = useReducedMotion();
  const [secondsLeft, setSecondsLeft] = useState(() => Math.ceil(duration));
  const [exitReason, setExitReason] = useState<ExitReason>("expire");
  const [isPaused, setIsPaused] = useState(false);
  const ringOffset = useMotionValue(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const elapsedRef = useRef(0);
  const expiredRef = useRef(false);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const latestRef = useRef({ onExpire, pauseOnHover });
  useEffect(() => {
    latestRef.current = { onExpire, pauseOnHover };
  });

  useEffect(() => {
    if (!open) return;

    const durationMs = Math.max(duration, 0.001) * 1000;
    elapsedRef.current = 0;
    expiredRef.current = false;
    hoveredRef.current = false;
    focusedRef.current = false;
    lastFrameRef.current = performance.now();
    ringOffset.set(0);
    setSecondsLeft(Math.ceil(duration));
    setExitReason("expire");
    setIsPaused(false);

    const tick = (now: number) => {
      const { onExpire: expire, pauseOnHover: pausable } = latestRef.current;
      const paused = pausable && (hoveredRef.current || focusedRef.current);
      if (!paused) {
        elapsedRef.current += Math.min(
          now - lastFrameRef.current,
          MAX_FRAME_DELTA_MS,
        );
      }
      lastFrameRef.current = now;

      const progress = Math.min(elapsedRef.current / durationMs, 1);
      ringOffset.set(RING_CIRCUMFERENCE * progress);

      const remaining = Math.max(
        0,
        Math.ceil((durationMs - elapsedRef.current) / 1000),
      );
      setSecondsLeft((prev) => (prev === remaining ? prev : remaining));

      if (progress >= 1) {
        if (!expiredRef.current) {
          expiredRef.current = true;
          expire();
        }
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [open, duration, resetKey, ringOffset]);

  const handleUndo = useCallback(() => {
    if (expiredRef.current) return;
    expiredRef.current = true;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    setExitReason("undo");
    onUndo();
  }, [onUndo]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      handleUndo();
    },
    [handleUndo],
  );

  const syncPaused = useCallback(() => {
    setIsPaused(pauseOnHover && (hoveredRef.current || focusedRef.current));
  }, [pauseOnHover]);

  const pillVariants: Variants = {
    hidden: shouldReduceMotion
      ? { opacity: 0 }
      : { opacity: 0, y: 16, scale: 0.95 },
    visible: shouldReduceMotion
      ? { opacity: 1, transition: { duration: 0 } }
      : {
          opacity: 1,
          y: 0,
          scale: 1,
          transition: ENTRANCE_SPRING,
        },
    exit: (reason: ExitReason) =>
      shouldReduceMotion
        ? { opacity: 0, transition: { duration: 0 } }
        : reason === "undo"
          ? {
              opacity: [1, 1, 0],
              scale: [1, 1.04, 0.9],
              transition: {
                duration: UNDO_EXIT_DURATION,
                times: [0, 0.4, 1],
                ease: "easeIn",
              },
            }
          : {
              opacity: 0,
              scale: 0.9,
              y: 8,
              transition: { duration: EXPIRE_EXIT_DURATION, ease: "easeIn" },
            },
  };

  return (
    <AnimatePresence custom={exitReason}>
      {open && (
        <motion.div
          role="status"
          aria-live="polite"
          variants={pillVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          custom={exitReason}
          onPointerEnter={() => {
            hoveredRef.current = true;
            syncPaused();
          }}
          onPointerLeave={() => {
            hoveredRef.current = false;
            syncPaused();
          }}
          onFocus={() => {
            focusedRef.current = true;
            syncPaused();
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              focusedRef.current = false;
              syncPaused();
            }
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "pointer-events-auto inline-flex select-none items-center gap-2.5 rounded-full bg-neutral-900 py-2 pl-3 pr-2.5 text-sm text-white",
            "shadow-[0px_0px_0px_1px_rgba(0,0,0,0.06),0px_1px_2px_0px_rgba(0,0,0,0.04),0px_2px_4px_0px_rgba(0,0,0,0.04)]",
            "dark:bg-white dark:text-neutral-900 dark:shadow-none",
            className,
          )}
        >
          <span
            aria-hidden="true"
            className="relative inline-flex shrink-0 items-center justify-center"
            style={{ width: RING_SIZE, height: RING_SIZE }}
          >
            <svg
              viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
              width={RING_SIZE}
              height={RING_SIZE}
              className="-rotate-90"
            >
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={2}
                className={cn(
                  "transition-colors duration-200",
                  isPaused
                    ? "stroke-white/45 dark:stroke-neutral-900/40"
                    : "stroke-neutral-500/50",
                )}
              />
              <motion.circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                style={{ strokeDashoffset: ringOffset }}
                className="stroke-white dark:stroke-neutral-900"
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[9px] font-medium leading-none tabular-nums">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={secondsLeft}
                  className="inline-block"
                  initial={
                    shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -5 }
                  }
                  animate={{ opacity: 1, y: 0 }}
                  exit={
                    shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 5 }
                  }
                  transition={{
                    duration: shouldReduceMotion ? 0 : SECONDS_SWAP_DURATION,
                    ease: "easeOut",
                  }}
                >
                  {secondsLeft}
                </motion.span>
              </AnimatePresence>
            </span>
          </span>

          <span className="min-w-0">{label}</span>

          <span
            aria-hidden="true"
            className="h-1 w-1 shrink-0 rounded-full bg-white/30 dark:bg-neutral-900/30"
          />

          <button
            type="button"
            onClick={handleUndo}
            aria-label={undoLabel}
            className={cn(
              "-my-1 touch-manipulation rounded-full px-1.5 py-1 font-medium underline-offset-2 transition-colors",
              "hover:bg-white/10 hover:underline active:bg-white/20 dark:hover:bg-neutral-900/10 dark:active:bg-neutral-900/15",
              "focus-visible:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/70 dark:focus-visible:ring-neutral-900/60",
            )}
          >
            {undoLabel}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
