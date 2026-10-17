import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  MonitorPlay,
  Play,
  X,
} from "lucide-react";
import {
  ApiError,
  request,
  type Discovery,
  type DiscoveryTitle,
  type Item,
  type Program,
} from "../api";
import { isContinueWatching, type WatchHistoryEntry } from "../watch-history";
import { Artwork } from "./artwork";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./spectrumui/spinner-dependencies";
import { AnimatedAlert } from "./spectrumui/animated-alert";
import { DiscoveryHero } from "./discovery-hero";
import "./discovery-dashboard.css";

type LibraryKind = "live" | "movie" | "series";
type NextEpisode = { entry: WatchHistoryEntry; episode: Item };
type EpisodePage = { items: Item[]; seasons?: number[]; season?: number };
function episodeLabel(item: Item) {
  return `S${item.season || 1}${item.episode ? ` · E${item.episode}` : ""}`;
}

function progress(entry: WatchHistoryEntry) {
  return entry.duration && entry.position
    ? Math.min(100, Math.max(0, (entry.position / entry.duration) * 100))
    : 0;
}

function byEpisode(a: Item, b: Item) {
  return (
    (a.season || 1) - (b.season || 1) || (a.episode || 0) - (b.episode || 0)
  );
}

function releaseLabel(title: DiscoveryTitle) {
  if (
    title.releaseDate &&
    /^\d{4}-(0[1-9]|1[0-2])(?:-|$)/.test(title.releaseDate)
  ) {
    return new Date(
      `${title.releaseDate.slice(0, 7)}-01T00:00:00Z`,
    ).toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return title.year ? String(title.year) : "";
}

function ContentRail({
  label,
  className,
  overlay = false,
  children,
}: {
  label: string;
  className: string;
  overlay?: boolean;
  children: ReactNode;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState({
    previous: false,
    next: false,
  });
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const update = () => {
      const previous = element.scrollLeft > 2;
      const next =
        element.scrollLeft + element.clientWidth < element.scrollWidth - 2;
      setScrollable((current) =>
        current.previous === previous && current.next === next
          ? current
          : { previous, next },
      );
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [children]);
  const scroll = (direction: number) => {
    const element = rail.current;
    if (element)
      element.scrollBy({
        left: direction * element.clientWidth * 0.8,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  };
  return (
    <div
      className={`discovery-rail-shell${overlay ? " discovery-rail-overlay" : ""}`}
    >
      <div
        ref={rail}
        className={className}
        role="group"
        aria-label={label}
        tabIndex={0}
      >
        {children}
      </div>
      {(scrollable.previous || scrollable.next) && (
        <div
          className="discovery-rail-controls"
          role="group"
          aria-label={`${label} scrolling`}
        >
          {scrollable.previous && (
            <Button
              variant="ghost"
              size="icon"
              className="discovery-rail-control discovery-rail-previous"
              aria-label={`Scroll ${label.toLowerCase()} left`}
              onClick={() => scroll(-1)}
            >
              <ChevronLeft
                className="size-7"
                size={26}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </Button>
          )}
          {scrollable.next && (
            <Button
              variant="ghost"
              size="icon"
              className="discovery-rail-control discovery-rail-next"
              aria-label={`Scroll ${label.toLowerCase()} right`}
              onClick={() => scroll(1)}
            >
              <ChevronRight
                className="size-7"
                size={26}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function Dashboard({
  entries,
  persistent,
  configured,
  refreshRevision,
  playbackActive = false,
  liveItems,
  programs,
  now,
  onBrowse,
  onOpen,
  onRemove,
  onClear,
  onResume,
  onPlay,
  onPlayEpisode,
  onOpenTitle,
  isDashboardAllowed = () => true,
}: {
  entries: WatchHistoryEntry[];
  persistent: boolean;
  configured: boolean;
  refreshRevision?: string;
  playbackActive?: boolean;
  liveItems: Item[];
  programs: Program[];
  now: number;
  onBrowse: (kind: LibraryKind) => void;
  onOpen: (entry: WatchHistoryEntry, title: Item) => void;
  onRemove: (entry: WatchHistoryEntry) => void;
  onClear: () => void;
  onResume: (entry: WatchHistoryEntry) => Promise<void>;
  onPlay: (item: Item) => Promise<void>;
  onPlayEpisode: (title: Item, episode: Item) => Promise<void>;
  onOpenTitle: (item: Item) => Promise<void>;
  isDashboardAllowed?: (item: Item) => boolean;
}) {
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(configured);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [upNext, setUpNext] = useState<NextEpisode[]>([]);
  const [opening, setOpening] = useState("");
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const operation = useRef(0);

  useEffect(
    () => () => {
      pending.current?.abort();
      operation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!playbackActive) return;
    pending.current?.abort();
    operation.current++;
    setOpening("");
    setError("");
  }, [playbackActive]);

  useEffect(() => {
    if (!configured) {
      setDiscoveryLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    // Allow a final poll after the server's three-minute refresh window.
    const deadline = Date.now() + 185_000;
    const load = async () => {
      if (loading || document.hidden || controller.signal.aborted) return;
      clearTimeout(timer);
      loading = true;
      try {
        const result = await request<Discovery>("/api/discovery", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDiscovery(result);
        setDiscoveryFailed(false);
        if (result.refreshing && Date.now() < deadline && !document.hidden) {
          const hasTitles =
            result.trendingMovies.length + result.trendingSeries.length > 0;
          timer = setTimeout(() => void load(), hasTitles ? 5000 : 2000);
        }
      } catch {
        if (!controller.signal.aborted) setDiscoveryFailed(true);
      } finally {
        loading = false;
        if (!controller.signal.aborted) setDiscoveryLoading(false);
      }
    };
    const resume = () => {
      clearTimeout(timer);
      if (!document.hidden) void load();
    };
    void load();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [configured, refreshRevision]);

  const completedSeries = entries
    .filter((entry) => entry.title.kind === "series" && entry.completed)
    .slice(0, 4);
  const completedKey = completedSeries
    .map(
      (entry) =>
        `${entry.title.id}:${entry.item.id}:${entry.item.season}:${entry.item.episode}`,
    )
    .join("|");
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const next: NextEpisode[] = [];
      for (const entry of completedSeries) {
        if (controller.signal.aborted) return;
        try {
          const season = entry.item.season || 1;
          const path = `/api/series/${encodeURIComponent(entry.title.id)}/episodes`;
          const result = await request<EpisodePage>(
            `${path}?season=${season}`,
            { signal: controller.signal },
          );
          const episodes = result.items
            .filter((item) => item.kind === "episode")
            .sort(byEpisode);
          const index = episodes.findIndex(
            (item) =>
              item.id === entry.item.id ||
              (!!entry.item.episode &&
                (item.season || 1) === season &&
                item.episode === entry.item.episode),
          );
          // An unknown watched episode must not be guessed into a different show.
          if (index < 0) continue;
          let episode = episodes[index + 1];
          if (!episode) {
            const nextSeason = result.seasons
              ?.filter((value) => value > season)
              .sort((a, b) => a - b)[0];
            if (nextSeason !== undefined) {
              const following = await request<EpisodePage>(
                `${path}?season=${nextSeason}`,
                { signal: controller.signal },
              );
              episode = following.items
                .filter(
                  (item) =>
                    item.kind === "episode" &&
                    (item.season || 1) === nextSeason,
                )
                .sort(byEpisode)[0];
            }
          }
          if (episode) next.push({ entry, episode });
        } catch {
          // One unavailable season should not block other shows or discovery.
        }
      }
      if (!controller.signal.aborted) setUpNext(next);
    };
    setUpNext([]);
    if (!playbackActive && configured && completedSeries.length) void load();
    return () => controller.abort();
    // Progress writes rerender the dashboard; only a different completed
    // episode needs another provider lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, completedKey, playbackActive]);

  const continueWatching = entries.filter(isContinueWatching).slice(0, 6);
  const recent = entries.slice(0, 6);
  const livePrograms = useMemo(() => {
    const current = new Map<string, Program>();
    if (playbackActive) return current;
    for (const program of programs) {
      if (
        Date.parse(program.start) <= now &&
        Date.parse(program.end) > now &&
        program.title.trim() &&
        program.title.trim().toLowerCase() !== "no information available"
      )
        current.set(program.channelId, program);
    }
    return current;
  }, [programs, now, playbackActive]);
  const liveNow = useMemo(() => {
    if (playbackActive) return [];
    const recentIds = new Set(
      entries
        .filter((entry) => entry.title.kind === "live")
        .map((entry) => entry.title.id),
    );
    const withGuide = liveItems.filter((item) => livePrograms.has(item.id));
    const guidedIds = new Set(withGuide.map((item) => item.id));
    return [
      ...withGuide.filter((item) => recentIds.has(item.id)),
      ...withGuide.filter((item) => !recentIds.has(item.id)),
      ...liveItems.filter((item) => !guidedIds.has(item.id)),
    ].slice(0, 6);
  }, [entries, liveItems, livePrograms, playbackActive]);
  const trendingMovies = (discovery?.trendingMovies || []).filter((title) =>
    isDashboardAllowed(title.item),
  );
  const trendingSeries = (discovery?.trendingSeries || []).filter((title) =>
    isDashboardAllowed(title.item),
  );
  const hasTrending = trendingMovies.length > 0 || trendingSeries.length > 0;
  const exploreMovies = (discovery?.exploreMovies || []).filter((title) =>
    isDashboardAllowed(title.item),
  );
  const exploreSeries = (discovery?.exploreSeries || []).filter((title) =>
    isDashboardAllowed(title.item),
  );
  const movies = hasTrending ? trendingMovies : exploreMovies;
  const series = hasTrending ? trendingSeries : exploreSeries;
  const titles: DiscoveryTitle[] = [];
  for (let index = 0; index < Math.max(movies.length, series.length); index++) {
    if (movies[index]) titles.push(movies[index]);
    if (series[index]) titles.push(series[index]);
  }

  const featureCandidates = [
    ...trendingMovies,
    ...trendingSeries,
    ...exploreMovies,
    ...exploreSeries,
  ];
  const run = async (key: string, action: () => Promise<void>) => {
    const id = ++operation.current;
    setOpening(key);
    setError("");
    try {
      await action();
    } catch (cause) {
      if (operation.current === id)
        setError(
          cause instanceof ApiError && cause.status === 404
            ? "This title is no longer available."
            : cause instanceof Error
              ? cause.message
              : "Couldn’t start playback. Please try again.",
        );
    } finally {
      if (operation.current === id) setOpening("");
    }
  };

  const open = async (entry: WatchHistoryEntry) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    await run(entry.title.id, async () => {
      const openedAt = operation.current;
      const { item } = await request<{ item: Item }>(
        `/api/items/${encodeURIComponent(entry.title.id)}`,
        { signal: controller.signal },
      );
      if (item.kind !== entry.title.kind)
        throw new ApiError("Title unavailable", 404);
      if (!controller.signal.aborted && operation.current === openedAt)
        onOpen(entry, item);
    });
  };

  const channelCard = (item: Item) => {
    const program = livePrograms.get(item.id);
    const elapsed = program
      ? Math.max(
          0,
          Math.min(
            100,
            ((now - Date.parse(program.start)) /
              (Date.parse(program.end) - Date.parse(program.start))) *
              100,
          ),
        )
      : 0;
    return (
      <button
        key={item.id}
        className="discovery-channel"
        type="button"
        aria-label={`Watch ${item.name}`}
        disabled={!configured || opening === item.id}
        onClick={() => void run(item.id, () => onPlay(item))}
      >
        <div className="discovery-channel-logo">
          <Artwork item={item} />
        </div>
        <div className="discovery-channel-copy">
          <span className="discovery-live-tag">
            <span /> LIVE
          </span>
          <h3>{program?.title || item.name}</h3>
          <p>{program ? item.name : item.category || "Live TV"}</p>
          {program && (
            <div
              className="discovery-program-progress"
              aria-label="Programme progress"
            >
              <span style={{ width: `${elapsed}%` }} />
            </div>
          )}
        </div>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    );
  };

  return (
    <div
      className={`dashboard discovery-dashboard${playbackActive ? " discovery-playback-active" : ""}`}
      role="region"
      aria-label="Home"
    >
      {!playbackActive && (
        <>
          {error && <AnimatedAlert variant="error">{error}</AnimatedAlert>}
          {discoveryFailed && (
            <AnimatedAlert variant="warning" className="discovery-fetch-note">
              Discovery unavailable
            </AnimatedAlert>
          )}

          <DiscoveryHero
            titles={titles}
            history={entries}
            configured={configured}
            opening={opening}
            onPlay={(item) => void run(item.id, () => onPlay(item))}
            onResume={(entry) =>
              void run(entry.title.id, () => onResume(entry))
            }
          >
            {discoveryLoading ? (
              <div
                className="discovery-feature discovery-feature-loading"
                role="status"
                aria-label="Loading discovery"
              >
                <div className="discovery-feature-copy" aria-hidden="true">
                  <Skeleton className="mb-5 h-3 w-44" />
                  <Skeleton className="mb-5 h-12 w-4/5 md:h-16" />
                  <Skeleton className="mb-6 h-4 w-40" />
                  <Skeleton className="mb-2 h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <div className="discovery-feature-actions">
                    <Skeleton className="h-12 w-32" />
                  </div>
                </div>
              </div>
            ) : (
              <section className="discovery-feature discovery-feature-welcome">
                <span className="discovery-welcome-symbol">
                  <MonitorPlay size={38} aria-hidden="true" />
                </span>
                <div className="discovery-feature-copy">
                  <h2>Your next watch starts here.</h2>
                  <p>
                    Explore movies, shows, and live channels from your library.
                  </p>
                  <Button
                    size="lg"
                    disabled={!configured}
                    onClick={() => onBrowse("movie")}
                  >
                    Browse Movies <ArrowRight size={17} aria-hidden="true" />
                  </Button>
                </div>
              </section>
            )}
          </DiscoveryHero>

          {upNext.length > 0 && (
            <section className="discovery-section" aria-label="Up next">
              <div className="discovery-section-heading">
                <h2>Up next</h2>
              </div>
              <ContentRail label="Up next" className="discovery-next-grid">
                {upNext.map(({ entry, episode }) => (
                  <button
                    key={episode.id}
                    type="button"
                    className="discovery-next-card"
                    aria-label={`Play ${entry.title.name} ${episodeLabel(episode)}: ${episode.name}`}
                    disabled={opening === episode.id}
                    onClick={() =>
                      void run(episode.id, () =>
                        onPlayEpisode(entry.title, episode),
                      )
                    }
                  >
                    <div className="discovery-next-art">
                      <Artwork
                        item={{
                          ...entry.title,
                          image: episode.image || entry.title.image,
                        }}
                      />
                      <span className="discovery-next-play">
                        <Play
                          size={17}
                          fill="currentColor"
                          aria-hidden="true"
                        />
                      </span>
                    </div>
                    <div>
                      <span>{episodeLabel(episode)}</span>
                      <h3>{entry.title.name}</h3>
                      <p>{episode.name}</p>
                    </div>
                  </button>
                ))}
              </ContentRail>
            </section>
          )}

          {continueWatching.length > 0 && (
            <section
              className="discovery-section"
              aria-label="Continue watching"
            >
              <div className="discovery-section-heading">
                <div>
                  <h2>Continue watching</h2>
                </div>
              </div>
              <ContentRail
                label="Continue watching"
                className="discovery-continue-grid"
              >
                {continueWatching.map((entry) => {
                  const metadata = featureCandidates.find(
                    (title) => title.item.id === entry.title.id,
                  );
                  const remaining =
                    entry.duration && entry.position
                      ? Math.ceil((entry.duration - entry.position) / 60)
                      : 0;
                  return (
                    <button
                      key={entry.title.id}
                      className="discovery-continue-card"
                      type="button"
                      aria-label={`Resume ${entry.title.name}`}
                      disabled={!configured || opening === entry.title.id}
                      onClick={() =>
                        void run(entry.title.id, () => onResume(entry))
                      }
                    >
                      <div className="discovery-landscape-art">
                        <Artwork
                          item={{
                            ...entry.title,
                            image: metadata?.backdrop || entry.title.image,
                          }}
                        />
                        <span className="discovery-resume-symbol">
                          <Play
                            size={22}
                            fill="currentColor"
                            aria-hidden="true"
                          />
                        </span>
                        <span className="discovery-remaining">
                          {remaining > 0
                            ? `${remaining} min left`
                            : "Resume watching"}
                        </span>
                        <div className="discovery-watch-progress">
                          <span style={{ width: `${progress(entry)}%` }} />
                        </div>
                      </div>
                      <div className="discovery-continue-copy">
                        <h3>{entry.title.name}</h3>
                        <p>
                          {entry.title.kind === "series"
                            ? `${episodeLabel(entry.item)} · ${entry.item.name}`
                            : "Movie"}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </ContentRail>
            </section>
          )}
        </>
      )}

      {(playbackActive ||
        titles.length > 0 ||
        discoveryLoading ||
        discovery?.refreshing) && (
        <section
          className="discovery-section discovery-picks"
          aria-label={
            playbackActive
              ? "Explore"
              : hasTrending
                ? "Trending now"
                : "Explore"
          }
        >
          <div className="discovery-section-heading">
            <div>
              <h2>
                {playbackActive
                  ? "Explore"
                  : hasTrending
                    ? "Trending now"
                    : "Explore"}
              </h2>
            </div>
          </div>
          {playbackActive && (
            <>
              {error && <AnimatedAlert variant="error">{error}</AnimatedAlert>}
              {discoveryFailed && (
                <AnimatedAlert
                  variant="warning"
                  className="discovery-fetch-note"
                >
                  Discovery unavailable
                </AnimatedAlert>
              )}
            </>
          )}
          {titles.length > 0 ? (
            <ContentRail
              label="Titles"
              className="discovery-poster-grid"
              overlay
            >
              {titles.map((title) => (
                <button
                  key={title.item.id}
                  type="button"
                  className="discovery-poster-card"
                  aria-label={`Open ${title.name}`}
                  disabled={!configured || opening === title.item.id}
                  onClick={() =>
                    void run(title.item.id, () => onOpenTitle(title.item))
                  }
                >
                  <div className="discovery-poster-art">
                    <Artwork
                      item={{
                        ...title.item,
                        image: playbackActive
                          ? title.backdrop || title.poster || title.item.image
                          : title.poster || title.item.image,
                      }}
                    />
                  </div>
                  <p>
                    {[
                      releaseLabel(title),
                      title.item.kind === "series" ? "Show" : "Movie",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </button>
              ))}
            </ContentRail>
          ) : discoveryLoading || discovery?.refreshing ? (
            <div
              className="discovery-poster-grid discovery-skeleton-grid"
              role="status"
              aria-label="Loading available titles"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} aria-hidden="true">
                  <div className="discovery-poster-art">
                    <Skeleton className="h-full w-full" />
                  </div>
                  <Skeleton className="mt-2.5 h-3 w-3/4" />
                </div>
              ))}
            </div>
          ) : (
            <p className="discovery-explore-empty">No titles</p>
          )}
        </section>
      )}

      {!playbackActive && (
        <div
          className={`discovery-bottom${entries.length === 0 || liveNow.length === 0 ? " discovery-bottom-single" : ""}`}
        >
          {liveNow.length > 0 && (
            <section
              className="discovery-section discovery-live-section"
              aria-label="Live now"
            >
              <div className="discovery-section-heading">
                <div>
                  <h2>Live now</h2>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="View all channels"
                  onClick={() => onBrowse("live")}
                >
                  All channels <ArrowRight size={15} aria-hidden="true" />
                </Button>
              </div>
              <ContentRail
                label="Live channels"
                className="discovery-channel-grid"
              >
                {liveNow.map((item) => channelCard(item))}
              </ContentRail>
            </section>
          )}
          {entries.length > 0 && (
            <section
              className="discovery-section discovery-recent-section"
              aria-label="Recently played"
            >
              <div className="discovery-section-heading">
                <div>
                  <h2>Recently played</h2>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    pending.current?.abort();
                    operation.current++;
                    setOpening("");
                    setError("");
                    onClear();
                  }}
                >
                  Clear history
                </Button>
              </div>
              {!persistent && (
                <AnimatedAlert
                  variant="warning"
                  className="discovery-history-note"
                >
                  History isn’t saved.
                </AnimatedAlert>
              )}
              <ContentRail
                label="Recently played"
                className="discovery-recent-grid"
              >
                {recent.map((entry) => (
                  <div
                    key={entry.title.id}
                    className={`discovery-recent-card${entry.title.kind === "live" ? " is-live" : ""}`}
                  >
                    <button
                      type="button"
                      className="discovery-recent-open"
                      aria-label={`Open ${entry.title.name}`}
                      disabled={!configured || opening === entry.title.id}
                      onClick={() => void open(entry)}
                    >
                      <div className="discovery-recent-art">
                        <Artwork item={entry.title} />
                      </div>
                      <div className="discovery-recent-copy">
                        <span>
                          {entry.title.kind === "live"
                            ? "Live TV"
                            : entry.title.kind === "series"
                              ? episodeLabel(entry.item)
                              : "Movie"}
                        </span>
                        <h3>{entry.title.name}</h3>
                        {entry.title.kind === "series" && (
                          <p>{entry.item.name}</p>
                        )}
                        <time
                          dateTime={new Date(entry.watchedAt).toISOString()}
                        >
                          {new Date(entry.watchedAt).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )}
                        </time>
                        {opening === entry.title.id && (
                          <span
                            className="discovery-opening"
                            role="status"
                            aria-label="Opening title"
                          >
                            <Spinner size="small" className="app-spinner" />
                          </span>
                        )}
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="discovery-remove"
                      aria-label={`Remove ${entry.title.name} from history`}
                      onClick={() => {
                        if (opening === entry.title.id) {
                          pending.current?.abort();
                          operation.current++;
                          setOpening("");
                        }
                        setError("");
                        onRemove(entry);
                      }}
                    >
                      <X size={13} aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </ContentRail>
              {recent.length === 0 && (
                <p className="discovery-side-empty">No history</p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
