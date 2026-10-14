import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  Clapperboard,
  Clock3,
  Film,
  Flame,
  Info,
  MonitorPlay,
  Play,
  Radio,
  RotateCcw,
  X,
} from "lucide-react";
import {
  ApiError,
  request,
  type Discovery,
  type Item,
  type Program,
} from "../api";
import { isContinueWatching, type WatchHistoryEntry } from "../watch-history";
import { Artwork } from "./artwork";
import { Button } from "./ui/button";
import "./discovery-dashboard.css";

type LibraryKind = "live" | "movie" | "series";
type NextEpisode = { entry: WatchHistoryEntry; episode: Item };
type EpisodePage = { items: Item[]; seasons?: number[]; season?: number };
const sections = [
  { kind: "live", label: "Live TV", icon: MonitorPlay },
  { kind: "movie", label: "Movies", icon: Film },
  { kind: "series", label: "Series", icon: Clapperboard },
] as const;

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

export function Dashboard({
  entries,
  persistent,
  configured,
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
}: {
  entries: WatchHistoryEntry[];
  persistent: boolean;
  configured: boolean;
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
}) {
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(configured);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [upNext, setUpNext] = useState<NextEpisode[]>([]);
  const [opening, setOpening] = useState("");
  const [error, setError] = useState("");
  const [discoveryKind, setDiscoveryKind] = useState<"movie" | "series">(
    "movie",
  );
  const [recentKind, setRecentKind] = useState<LibraryKind | "all">("all");
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
    if (!configured) {
      setDiscoveryLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const load = async () => {
      try {
        const result = await request<Discovery>("/api/discovery", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDiscovery(result);
        setDiscoveryFailed(false);
        if (result.refreshing && polls++ < 36)
          timer = setTimeout(() => void load(), 5000);
      } catch {
        if (!controller.signal.aborted) setDiscoveryFailed(true);
      } finally {
        if (!controller.signal.aborted) setDiscoveryLoading(false);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [configured]);

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
    if (configured && completedSeries.length) void load();
    return () => controller.abort();
    // Progress writes rerender the dashboard; only a different completed
    // episode needs another provider lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, completedKey]);

  const continueWatching = entries.filter(isContinueWatching).slice(0, 6);
  const recent = entries
    .filter((entry) => recentKind === "all" || entry.title.kind === recentKind)
    .slice(0, 6);
  const livePrograms = useMemo(() => {
    const current = new Map<string, Program>();
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
  }, [programs, now]);
  const liveNow = useMemo(() => {
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
  }, [entries, liveItems, livePrograms]);
  const trendingMovies = discovery?.trendingMovies || [];
  const trendingSeries = discovery?.trendingSeries || [];
  const hasTrending = trendingMovies.length > 0 || trendingSeries.length > 0;
  const exploreMovies = discovery?.exploreMovies || [];
  const exploreSeries = discovery?.exploreSeries || [];
  const movies = hasTrending ? trendingMovies : exploreMovies;
  const series = hasTrending ? trendingSeries : exploreSeries;
  const displayedKind =
    discoveryKind === "movie" && !movies.length && series.length
      ? "series"
      : discoveryKind === "series" && !series.length && movies.length
        ? "movie"
        : discoveryKind;
  const titles = (displayedKind === "movie" ? movies : series).slice(0, 12);
  const featureCandidates = [
    ...trendingMovies,
    ...trendingSeries,
    ...exploreMovies,
    ...exploreSeries,
  ];
  const feature =
    featureCandidates.find((title) => title.backdrop) || featureCandidates[0];
  const featureTrending =
    !!feature &&
    [...trendingMovies, ...trendingSeries].some(
      (title) => title.item.id === feature.item.id,
    );
  const hasTMDB = featureCandidates.some((title) => title.tmdbId !== undefined);

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
            ? "This title is no longer available. Explore the library to find something else."
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
      const { item } = await request<{ item: Item }>(
        `/api/items/${encodeURIComponent(entry.title.id)}`,
        { signal: controller.signal },
      );
      if (item.kind !== entry.title.kind)
        throw new ApiError("Title unavailable", 404);
      if (!controller.signal.aborted) onOpen(entry, item);
    });
  };

  const channelCard = (item: Item, compact = false) => {
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
        className={`discovery-channel${compact ? " discovery-channel-compact" : ""}`}
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
    <div className="dashboard discovery-dashboard">
      <div className="discovery-heading">
        <div>
          <h1>Dashboard</h1>
          <p>
            {entries.length
              ? "Pick up where you left off. Find your next favourite."
              : "Your next great watch starts here."}
          </p>
        </div>
        <div className="discovery-heading-actions">
          <span className="discovery-history-note">
            {persistent
              ? "History stays in this browser"
              : "History saved for this visit"}
          </span>
          {entries.length > 0 && (
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
          )}
        </div>
      </div>
      {!configured && (
        <div className="notice" role="status">
          Ask your administrator to set up the library before watching.
        </div>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {discoveryFailed && (
        <p className="discovery-fetch-note" role="status">
          Discovery is temporarily unavailable. You can still browse your
          library.
        </p>
      )}

      <div className="discovery-lead">
        {feature ? (
          <section
            className={`discovery-feature${feature.backdrop ? " has-backdrop" : ""}`}
            aria-label={`Featured ${feature.name}`}
          >
            {feature.backdrop && (
              <img
                className="discovery-feature-backdrop"
                src={feature.backdrop}
                alt=""
                decoding="async"
                onError={(event) => {
                  event.currentTarget.style.visibility = "hidden";
                }}
              />
            )}
            {!feature.backdrop && (
              <div className="discovery-feature-poster">
                <Artwork
                  item={{
                    ...feature.item,
                    image: feature.poster || feature.item.image,
                  }}
                />
              </div>
            )}
            <div className="discovery-feature-copy">
              <span className="discovery-eyebrow">
                {featureTrending ? (
                  <Flame size={15} aria-hidden="true" />
                ) : (
                  <Film size={15} aria-hidden="true" />
                )}
                {featureTrending
                  ? "Trending · Available here"
                  : "From your library"}
              </span>
              <h2>{feature.name}</h2>
              <div className="discovery-feature-meta">
                <span>
                  {feature.item.kind === "series" ? "Series" : "Movie"}
                </span>
                {!!feature.year && <span>{feature.year}</span>}
                {!!feature.rating && (
                  <span>{feature.rating.toFixed(1)} / 10</span>
                )}
                {!!feature.genres?.length && (
                  <span>{feature.genres.slice(0, 2).join(" · ")}</span>
                )}
              </div>
              <p>
                {feature.overview ||
                  feature.item.description ||
                  "Something new to get lost in. Available to watch in your library."}
              </p>
              <div className="discovery-feature-actions">
                <Button
                  size="lg"
                  aria-label={
                    feature.item.kind === "series"
                      ? `View episodes of ${feature.name}`
                      : `Play ${feature.name}`
                  }
                  disabled={!configured || opening === feature.item.id}
                  onClick={() =>
                    void run(feature.item.id, () =>
                      feature.item.kind === "series"
                        ? onOpenTitle(feature.item)
                        : onPlay(feature.item),
                    )
                  }
                >
                  {feature.item.kind === "series" ? (
                    <Clapperboard size={17} aria-hidden="true" />
                  ) : (
                    <Play size={17} fill="currentColor" aria-hidden="true" />
                  )}
                  {opening === feature.item.id
                    ? "Opening…"
                    : feature.item.kind === "series"
                      ? "View episodes"
                      : "Play movie"}
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  aria-label={`Open ${feature.name}`}
                  onClick={() =>
                    void run(feature.item.id, () => onOpenTitle(feature.item))
                  }
                  disabled={!configured || opening === feature.item.id}
                >
                  <Info size={17} aria-hidden="true" /> Details
                </Button>
              </div>
            </div>
          </section>
        ) : discoveryLoading ? (
          <div
            className="discovery-feature discovery-feature-loading"
            role="status"
            aria-label="Loading discovery"
          >
            <span className="artwork-skeleton" />
            <p>Finding something to watch…</p>
          </div>
        ) : (
          <section className="discovery-feature discovery-feature-welcome">
            <span className="discovery-welcome-symbol">
              <MonitorPlay size={38} aria-hidden="true" />
            </span>
            <div className="discovery-feature-copy">
              <span className="discovery-eyebrow">
                Your library. Your evening.
              </span>
              <h2>Your watching starts here</h2>
              <p>
                Find a movie, start a series, or tune in live. As you watch,
                this space becomes yours.
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

        <aside
          className="discovery-side"
          aria-label={upNext.length ? "Up next" : "On right now"}
        >
          {upNext.length > 0 ? (
            <>
              <div className="discovery-side-heading">
                <span className="discovery-eyebrow">
                  <RotateCcw size={14} aria-hidden="true" /> Your next episode
                </span>
                <h2>Up next</h2>
              </div>
              {upNext.slice(0, 2).map(({ entry, episode }) => (
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
                      <Play size={17} fill="currentColor" aria-hidden="true" />
                    </span>
                  </div>
                  <div>
                    <span>{episodeLabel(episode)}</span>
                    <h3>{entry.title.name}</h3>
                    <p>{episode.name}</p>
                  </div>
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="discovery-side-heading">
                <span className="discovery-eyebrow">
                  <Radio size={14} aria-hidden="true" /> Tune in
                </span>
                <h2>On right now</h2>
              </div>
              {liveNow.slice(0, 2).map((item) => channelCard(item, true))}
              {!liveNow.length && (
                <p className="discovery-side-empty">
                  Movies, shows and live channels, all in one place.
                </p>
              )}
            </>
          )}
          <div
            className="discovery-destinations"
            aria-label="Browse your library"
          >
            {sections.map(({ kind, label, icon: Icon }) => (
              <button
                key={kind}
                type="button"
                disabled={!configured}
                aria-label={`Browse ${label}`}
                onClick={() => onBrowse(kind)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{label}</span>
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        </aside>
      </div>

      {continueWatching.length > 0 && (
        <section className="discovery-section" aria-label="Continue watching">
          <div className="discovery-section-heading">
            <div>
              <span className="discovery-eyebrow">Right where you left it</span>
              <h2>Continue watching</h2>
            </div>
            <Clock3 size={20} aria-hidden="true" />
          </div>
          <div className="discovery-continue-grid">
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
                      <Play size={22} fill="currentColor" aria-hidden="true" />
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
          </div>
        </section>
      )}

      {(titles.length > 0 || discoveryLoading || discovery?.refreshing) && (
        <section
          className="discovery-section discovery-picks"
          aria-label={hasTrending ? "Trending now" : "Explore your library"}
        >
          <div className="discovery-section-heading">
            <div>
              <span className="discovery-eyebrow">
                {hasTrending ? (
                  <>
                    <Flame size={13} aria-hidden="true" /> Popular this week ·
                    Available here
                  </>
                ) : (
                  "Find your next watch"
                )}
              </span>
              <h2>{hasTrending ? "Trending now" : "Explore your library"}</h2>
            </div>
            <div className="discovery-segmented" aria-label="Discovery type">
              <button
                type="button"
                aria-pressed={displayedKind === "movie"}
                onClick={() => setDiscoveryKind("movie")}
                disabled={!movies.length}
              >
                Movies
              </button>
              <button
                type="button"
                aria-pressed={displayedKind === "series"}
                onClick={() => setDiscoveryKind("series")}
                disabled={!series.length}
              >
                Shows
              </button>
            </div>
          </div>
          {titles.length > 0 ? (
            <div className="discovery-poster-grid">
              {titles.map((title, index) => (
                <button
                  key={title.item.id}
                  type="button"
                  className="discovery-poster-card"
                  aria-label={`Open ${title.name}`}
                  disabled={opening === title.item.id}
                  onClick={() =>
                    void run(title.item.id, () => onOpenTitle(title.item))
                  }
                >
                  <div className="discovery-poster-art">
                    <Artwork
                      item={{
                        ...title.item,
                        image: title.poster || title.item.image,
                      }}
                    />
                    {hasTrending && (
                      <span className="discovery-rank">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                    )}
                    <span className="discovery-poster-action">
                      <Info size={16} aria-hidden="true" />
                    </span>
                  </div>
                  <h3>{title.name}</h3>
                  <p>
                    {[
                      title.year,
                      title.item.kind === "series" ? "Series" : "Movie",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div
              className="discovery-poster-grid discovery-skeleton-grid"
              role="status"
              aria-label="Loading available titles"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="discovery-poster-art">
                  <span className="artwork-skeleton" />
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="discovery-text-link"
            onClick={() => onBrowse(displayedKind)}
            disabled={!configured}
          >
            Explore all {displayedKind === "movie" ? "movies" : "series"}{" "}
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </section>
      )}

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
                <span className="discovery-eyebrow">
                  <span className="discovery-live-dot" /> In the moment
                </span>
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
            <div className="discovery-channel-grid">
              {liveNow.map((item) => channelCard(item))}
            </div>
          </section>
        )}
        {entries.length > 0 && (
          <section
            className="discovery-section discovery-recent-section"
            aria-label="Recently played"
          >
            <div className="discovery-section-heading">
              <div>
                <span className="discovery-eyebrow">Your viewing trail</span>
                <h2>Recently played</h2>
              </div>
            </div>
            <div
              className="discovery-segmented discovery-recent-filters"
              aria-label="History type"
            >
              <button
                type="button"
                aria-pressed={recentKind === "all"}
                onClick={() => setRecentKind("all")}
              >
                All
              </button>
              {sections.map(({ kind, label }) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={recentKind === kind}
                  onClick={() => setRecentKind(kind)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="discovery-recent-grid">
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
                      <time dateTime={new Date(entry.watchedAt).toISOString()}>
                        {new Date(entry.watchedAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" },
                        )}
                      </time>
                      {opening === entry.title.id && (
                        <span className="discovery-opening" role="status">
                          Opening…
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
            </div>
            {recent.length === 0 && (
              <p className="discovery-side-empty">
                Nothing watched in this section yet. Find something new in your
                library.
              </p>
            )}
          </section>
        )}
      </div>
      {hasTMDB && (
        <footer className="discovery-attribution">
          <a
            href="https://www.themoviedb.org/"
            target="_blank"
            rel="noreferrer"
          >
            <img src="/tmdb-logo.svg" alt="TMDB" width={55} height={24} />
            <span>Metadata and images by TMDB</span>
          </a>
          <span>
            This product uses the TMDB API but is not endorsed or certified by
            TMDB.
          </span>
        </footer>
      )}
    </div>
  );
}
