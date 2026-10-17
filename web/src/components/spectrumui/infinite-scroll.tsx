/*
 * Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui).
 * Licensed under Apache-2.0.
 */
import * as React from "react";

interface InfiniteScrollProps {
  isLoading: boolean;
  hasMore: boolean;
  next: () => void;
  children: React.ReactNode;
}

export default function InfiniteScroll({
  isLoading,
  hasMore,
  next,
  children,
}: InfiniteScrollProps) {
  const observer = React.useRef<IntersectionObserver | null>(null);
  const observerRef = React.useCallback(
    (element: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!element || isLoading || !hasMore) return;
      const current = new IntersectionObserver(
        ([entry]) => {
          if (observer.current !== current || !entry.isIntersecting) return;
          // One request per observation, including when a page has no matches.
          current.disconnect();
          observer.current = null;
          next();
        },
        { threshold: 0, root: null, rootMargin: "300px 0px" },
      );
      observer.current = current;
      current.observe(element);
    },
    [hasMore, isLoading, next],
  );
  React.useEffect(() => () => observer.current?.disconnect(), []);
  const items = React.Children.toArray(children);
  return items.map((child, index) =>
    index === items.length - 1 && React.isValidElement(child)
      ? React.cloneElement(
          child as React.ReactElement<{ ref?: React.Ref<HTMLElement> }>,
          { ref: observerRef },
        )
      : child,
  );
}
