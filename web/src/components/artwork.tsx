import { useLayoutEffect, useRef, useState } from "react";
import type { Item } from "../api";
import { SkeletonReveal } from "./spectrumui/skeleton-reveal";

export function Artwork({
  item,
  fallbackImage,
  className = "",
}: {
  item: Item;
  fallbackImage?: string;
  className?: string;
}) {
  const fallback = `/artwork-${item.kind === "live" ? "live" : "title"}.svg`;
  const sources = [
    ...new Set(
      [item.image, fallbackImage].filter(
        (source): source is string => !!source && source !== fallback,
      ),
    ),
    fallback,
  ];
  // Source changes get their own load state; a late effect must never reset a
  // cached image after its load event has already fired.
  return (
    <ArtworkImage
      key={JSON.stringify([item.id, item.kind, sources])}
      item={item}
      sources={sources}
      className={className}
    />
  );
}

function ArtworkImage({
  item,
  sources,
  className,
}: {
  item: Item;
  sources: string[];
  className: string;
}) {
  const element = useRef<HTMLImageElement>(null);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const fallback = sources[sources.length - 1];
  const source = sources[sourceIndex];
  const channelLogoLoaded =
    item.kind === "live" && source !== fallback && loaded;

  useLayoutEffect(() => {
    setLoaded(!!element.current?.complete && element.current.naturalWidth > 0);
  }, [source]);

  return (
    <SkeletonReveal
      loading={!loaded}
      className={`artwork-reveal${channelLogoLoaded ? " has-channel-logo" : ""}`}
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
            setSourceIndex(sourceIndex + 1);
          }
        }}
      />
    </SkeletonReveal>
  );
}
