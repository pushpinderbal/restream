import { useEffect, useMemo, useRef, useState } from "react";
import {
  request,
  type Discovery,
  type DiscoveryTitle,
  type Item,
  type Program,
} from "../api";
import { Artwork } from "./artwork";
import { Spinner } from "./spectrumui/spinner-dependencies";
import { AnimatedAlert } from "./spectrumui/animated-alert";
import { Button } from "./ui/button";

function sameCategory(item: Item, other: Item) {
  if (item.categoryId && other.categoryId)
    return item.categoryId === other.categoryId;
  return !!item.category && item.category === other.category;
}

function movieSuggestions(discovery: Discovery, item: Item) {
  const seen = new Set<string>();
  return [...discovery.trendingMovies, ...discovery.exploreMovies]
    .filter((title) => {
      if (
        title.item.kind !== "movie" ||
        title.item.id === item.id ||
        seen.has(title.item.id)
      )
        return false;
      seen.add(title.item.id);
      return true;
    })
    .sort(
      (a, b) =>
        Number(sameCategory(item, b.item)) - Number(sameCategory(item, a.item)),
    )
    .slice(0, 3);
}

export function MovieSuggestions({
  item,
  onPlay,
  refreshRevision,
  items,
}: {
  item: Item;
  onPlay: (item: Item) => Promise<void>;
  refreshRevision?: string;
  items?: Item[];
}) {
  const [titles, setTitles] = useState<DiscoveryTitle[]>([]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const opening = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    opening.current = false;
    setTitles([]);
    setPending("");
    setError("");
    if (items || item.kind !== "movie") return () => controller.abort();

    const load = async () => {
      try {
        const discovery = await request<Discovery>("/api/discovery", {
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation.current !== current) return;
        const next = movieSuggestions(discovery, item);
        setTitles(next);
        // A cold provider cache warms in the background. Keep the empty
        // sidebar unobtrusive while waiting for its real available listings.
        if (discovery.refreshing && next.length < 3 && polls++ < 36)
          timer = setTimeout(() => void load(), 5000);
      } catch {
        // Suggestions are optional; a failed discovery request should not
        // replace the movie's player or details with an error screen.
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      generation.current++;
    };
  }, [
    item.id,
    item.kind,
    item.categoryId,
    item.category,
    refreshRevision,
    !!items,
  ]);

  const play = async (title: DiscoveryTitle) => {
    if (opening.current) return;
    const current = generation.current;
    opening.current = true;
    setPending(title.item.id);
    setError("");
    try {
      await onPlay(title.item);
    } catch (cause) {
      if (generation.current === current)
        setError(
          cause instanceof Error ? cause.message : "Couldn’t open this movie.",
        );
    } finally {
      if (generation.current === current) {
        opening.current = false;
        setPending("");
      }
    }
  };

  const suggestions = items
    ? items
        .filter((other) => other.kind === "movie" && other.id !== item.id)
        .slice(0, 3)
        .map((other) => ({
          item: other,
          name: other.name,
          poster: other.image,
        }))
    : titles;
  if (!suggestions.length) return null;
  const heading = items ? "In this listing" : "More movies";
  return (
    <section className="watch-suggestions" aria-label={heading}>
      <h2>{heading}</h2>
      {suggestions.map((title: DiscoveryTitle) => (
        <Button
          key={title.item.id}
          type="button"
          variant="ghost"
          className="watch-suggestion"
          aria-label={`Play ${title.name}`}
          aria-busy={pending === title.item.id || undefined}
          disabled={!!pending}
          onClick={() => void play(title)}
        >
          <span className="watch-suggestion-art">
            <Artwork
              item={{
                ...title.item,
                image: title.backdrop || title.poster || title.item.image,
              }}
            />
          </span>
          <span className="watch-suggestion-copy">
            <strong>{title.name}</strong>
            <small>
              {pending === title.item.id ? (
                <span role="status" aria-label="Opening movie">
                  <Spinner size="small" className="app-spinner" />
                </span>
              ) : (
                "Movie"
              )}
            </small>
          </span>
        </Button>
      ))}
      {error && <AnimatedAlert>{error}</AnimatedAlert>}
    </section>
  );
}

export function LiveChannelSuggestions({
  items,
  activeItem,
  currentPrograms,
  onPlay,
}: {
  items: Item[];
  activeItem: Item;
  currentPrograms: Map<string, Program>;
  onPlay: (item: Item) => void;
}) {
  const channels = useMemo(() => {
    const seen = new Set<string>();
    return items
      .filter((item) => {
        if (item.kind !== "live" || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((a, b) => {
        const priority = (item: Item) =>
          item.id === activeItem.id
            ? 2
            : Number(sameCategory(activeItem, item));
        return priority(b) - priority(a);
      })
      .slice(0, 5);
  }, [items, activeItem.id, activeItem.categoryId, activeItem.category]);

  if (!channels.length) return null;
  return (
    <section className="watch-suggestions" aria-label="Channels">
      <h2>Channels</h2>
      {channels.map((item) => {
        const active = item.id === activeItem.id;
        const title = currentPrograms.get(item.id)?.title.trim();
        const programme =
          title && title.toLowerCase() !== "no information available"
            ? title
            : "Live TV";
        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            className="watch-suggestion"
            aria-label={`Watch ${item.name}`}
            aria-current={active ? "true" : undefined}
            onClick={() => {
              if (!active) onPlay(item);
            }}
          >
            <span className="watch-suggestion-art watch-channel-art">
              <Artwork item={item} />
            </span>
            <span className="watch-suggestion-copy">
              <strong>{item.name}</strong>
              <small>{programme}</small>
            </span>
          </Button>
        );
      })}
    </section>
  );
}
