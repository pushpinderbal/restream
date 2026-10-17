/*
 * Adapted from Spectrum UI Alert03 and Alert02:
 * https://github.com/arihantcodes/spectrum-ui/blob/main/app/registry/alertthree.tsx
 * https://github.com/arihantcodes/spectrum-ui/blob/main/app/registry/alerttwo.tsx
 * Licensed under Apache-2.0.
 */
import type { HTMLAttributes } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import "./feedback.css";

type AlertProps = HTMLAttributes<HTMLDivElement> & {
  variant?: "error" | "warning" | "info";
};

export function AnimatedAlert({
  variant = "error",
  title,
  children,
  className,
  role = variant === "error" ? "alert" : "status",
  ...props
}: AlertProps) {
  const reducedMotion = useReducedMotion();
  const Icon =
    variant === "error"
      ? CircleAlert
      : variant === "warning"
        ? TriangleAlert
        : Info;

  return (
    <div
      {...props}
      role={role}
      className={cn("spectrum-alert", className)}
      data-variant={variant}
    >
      <motion.div
        className="spectrum-alert-layout"
        initial={reducedMotion ? false : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.2 }}
      >
        <motion.span
          className="spectrum-alert-icon"
          initial={reducedMotion ? false : { scale: 0.5 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          aria-hidden="true"
        >
          <Icon size={17} />
        </motion.span>
        <div className="spectrum-alert-content">
          {title && <p className="spectrum-alert-title">{title}</p>}
          {children}
        </div>
      </motion.div>
    </div>
  );
}

export { AnimatedAlert as Alert };
