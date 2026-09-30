import { useLayoutEffect, useRef, useState } from "react";
import type { Item } from "../api";
import { SkeletonReveal } from "./spectrumui/skeleton-reveal";

export function Artwork({
  item,
  className = "",
}: {
  item: Item;
  className?: string;
}) {
  // Source changes get their own load state; a late effect must never reset a
  // cached image after its load event has already fired.
  return (
    <ArtworkImage
      key={`${item.id}:${item.image || ""}`}
      item={item}
      className={className}
    />
  );
}

function ArtworkImage({ item, className }: { item: Item; className: string }) {
  const element = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fallback = `/artwork-${item.kind === "live" ? "live" : "title"}.svg`;
  const source = !failed && item.image ? item.image : fallback;

  useLayoutEffect(() => {
    setLoaded(!!element.current?.complete && element.current.naturalWidth > 0);
  }, [source]);

  return (
    <SkeletonReveal
      loading={!loaded}
      className="artwork-reveal"
      revealDuration={320}
      skeleton={<span className="artwork-skeleton" />}
    >
      <img
        ref={element}
        key={source}
        className={className}
        loading="lazy"
        decoding="async"
        src={source}
        alt=""
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (source === fallback) setLoaded(true);
          else {
            setLoaded(false);
            setFailed(true);
          }
        }}
      />
    </SkeletonReveal>
  );
}
