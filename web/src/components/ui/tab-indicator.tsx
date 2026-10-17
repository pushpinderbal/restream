import { motion, useReducedMotion } from "motion/react";

export function TabIndicator({ id }: { id: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.span
      className="section-tab-indicator"
      layoutId={id}
      initial={false}
      transition={
        reducedMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 500, damping: 36 }
      }
      aria-hidden="true"
    />
  );
}
