import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import {
  ArrowLeft,
  Clapperboard,
  Film,
  Menu,
  MonitorPlay,
  Play,
  Search,
  Maximize2,
  Pause,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Skeleton } from "./components/ui/skeleton";
import {
  ResponsiveModal,
  ResponsiveModalClose,
  ResponsiveModalContent,
  ResponsiveModalTitle,
} from "./components/spectrumui/responsive-modal-dependencies";
import {
  ApiError,
  jsonRequest,
  releaseSession,
  request,
  type BrowsePage,
  type Category,
  type Item,
  type Program,
  type Session,
  type Status,
} from "./api";

type Tab = "live" | "movie" | "series";
function locationSelection() {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get("section");
  return {
    tab: (kind === "movie" || kind === "series" ? kind : "live") as Tab,
    category: params.get("category") || "*",
    search: params.get("search") || "",
    item: params.get("item") || "",
  };
}
function writeLocation(
  tab: Tab,
  category: string,
  search: string,
  replace = false,
  item = "",
) {
  const url = new URL(window.location.href);
  if (tab === "live") url.searchParams.delete("section");
  else url.searchParams.set("section", tab);
  if (category === "*") url.searchParams.delete("category");
  else url.searchParams.set("category", category);
  if (search) url.searchParams.set("search", search);
  else url.searchParams.delete("search");
  if (item) url.searchParams.set("item", item);
  else url.searchParams.delete("item");
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}
const sections = [
  { id: "live" as Tab, label: "Live TV", icon: MonitorPlay },
  { id: "movie" as Tab, label: "Movies", icon: Film },
  { id: "series" as Tab, label: "Series", icon: Clapperboard },
];
const noRoom =
  "No room available. All streaming slots are in use. Try again when someone stops watching.";
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 3600) ? `${Math.floor(value / 3600)}:` : ""}${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
function epgFor(programs: Program[], now: number) {
  const current = programs.find(
    (program) =>
      Date.parse(program.start) <= now && now < Date.parse(program.end),
  );
  const next = programs.find((program) => Date.parse(program.start) > now);
  return { current, next };
}
function normalizeSearch(text: string) {
  return text.toLocaleLowerCase().normalize("NFKD").replace(/[\p{M}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function keywordMatch(value: string, query: string) {
  const haystack = normalizeSearch(value);
  return normalizeSearch(query).split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}
function Artwork({ item, className = "" }: { item: Item; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.image, item.id]);
  return <img className={className} loading="lazy" src={!failed && item.image ? item.image : `/artwork-${item.kind === "live" ? "live" : "title"}.svg`} alt="" onError={() => setFailed(true)} />;
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [liveItems, setLiveItems] = useState<Item[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(() => locationSelection().tab);
  const [category, setCategory] = useState(() => locationSelection().category);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryPane, setCategoryPane] = useState<Tab | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState(() => locationSelection().search);
  const [debouncedSearch, setDebouncedSearch] = useState(
    () => locationSelection().search,
  );
  const [browseItems, setBrowseItems] = useState<Item[]>([]);
  const [browsePage, setBrowsePage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [selectedId, setSelectedId] = useState(() => locationSelection().item);
  const [detailError, setDetailError] = useState("");
  const opener = useRef<HTMLButtonElement | null>(null);
  const libraryScroll = useRef(0);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const browseAbort = useRef<AbortController | null>(null);
  const browseGeneration = useRef(0);
  const searchPending = useRef(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [visibleCount, setVisibleCount] = useState(72);

  useEffect(() => {
    let alive = true;
    void request<Status>("/api/status")
      .then((value) => {
        if (alive) {
          setStatus(value);
          if (!value.configured) setLoading(false);
        }
      })
      .catch((cause) => {
        if (alive) {
          setError(message(cause));
          setLoading(false);
        }
      });
    const interval = window.setInterval(() => {
      void request<Status>("/api/status")
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch(() => {});
    }, 10000);
    const clock = window.setInterval(() => setNow(Date.now()), 30000);
    return () => {
      alive = false;
      clearInterval(interval);
      clearInterval(clock);
    };
  }, []);
  useEffect(() => {
    const restore = () => {
      const next = locationSelection();
      searchPending.current = false;
      setTab(next.tab);
      setCategory(next.category);
      setSearch(next.search);
      setDebouncedSearch(next.search);
      setSelectedId(next.item);
      setSelected((old) => old?.id === next.item ? old : null);
      window.requestAnimationFrame(() => window.scrollTo({ top: next.item ? 0 : libraryScroll.current }));
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!selectedId || selected?.id === selectedId || !status?.configured) return;
    let alive = true;
    setDetailError("");
    void request<{ item: Item }>(`/api/items/${encodeURIComponent(selectedId)}`)
      .then(({ item }) => { if (alive) setSelected(item); })
      .catch((cause) => { if (alive) setDetailError(message(cause)); });
    return () => { alive = false; };
  }, [selectedId, selected?.id, status?.configured]);
  useEffect(() => {
    if (!status?.configured) return;
    let alive = true;
    void Promise.all([
      request<{ items: Item[] }>("/api/catalog"),
      request<{ programs: Program[] }>("/api/epg").catch(() => ({
        programs: [],
      })),
      request<{ categories: Category[] }>("/api/categories"),
    ])
      .then(([catalog, epg, categoryList]) => {
        if (!alive) return;
        setLiveItems(catalog.items || []);
        setPrograms(epg.programs || []);
        setCategories(categoryList.categories || []);
        setError("");
        setLoading(false);
      })
      .catch((cause) => {
        if (alive) {
          setError(message(cause));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [status?.configured, status?.catalogUpdatedAt, status?.epgUpdatedAt]);
  useEffect(() => {
    if (!searchPending.current || selectedId) return;
    if (tab !== "live") {
      browseGeneration.current++;
      browseAbort.current?.abort();
      setBrowseLoading(false);
      setBrowseItems([]);
      setBrowsePage(0);
      setHasMore(false);
      setBrowseError("");
    }
    const timer = window.setTimeout(() => {
      searchPending.current = false;
      setDebouncedSearch(search.trim());
      setSearchRevision((value) => value + 1);
      writeLocation(tab, category, search.trim(), true);
    }, 400);
    return () => clearTimeout(timer);
  }, [search, tab, category, selectedId]);

  const fetchPage = useCallback(
    (page: number, generation: number) => {
      if (tab === "live") return;
      browseAbort.current?.abort();
      const controller = new AbortController();
      browseAbort.current = controller;
      setBrowseLoading(true);
      setBrowseError("");
      const isCurrent = () => !controller.signal.aborted && generation === browseGeneration.current;
      void (async () => {
        try {
          // Portal pages may mix movies and series. Check a few pages per action
          // so a filtered empty page does not make a section look empty.
          for (let nextPage = page; nextPage < page + 5; nextPage++) {
            const params = new URLSearchParams({ kind: tab, category, search: debouncedSearch, page: String(nextPage) });
            const result = await request<BrowsePage>(`/api/browse?${params}`, { signal: controller.signal });
            if (!isCurrent()) return;
            setBrowsePage(nextPage);
            setHasMore(result.hasMore);
            if (result.items?.length) {
              setBrowseItems((old) => {
                const previous = page === 1 ? [] : old;
                const existing = new Set(previous.map((item) => item.id));
                return [...previous, ...result.items.filter((item) => {
                  if (existing.has(item.id)) return false;
                  existing.add(item.id);
                  return true;
                })];
              });
              break;
            }
            if (!result.hasMore) break;
          }
        } catch (cause) {
          if (isCurrent()) setBrowseError(message(cause));
        } finally {
          if (isCurrent()) setBrowseLoading(false);
        }
      })();
    },
    [tab, category, debouncedSearch],
  );
  useEffect(() => {
    browseGeneration.current++;
    browseAbort.current?.abort();
    setBrowseItems([]);
    setBrowsePage(0);
    setHasMore(false);
    setBrowseError("");
    setBrowseLoading(false);
    if (tab !== "live" && status?.configured)
      fetchPage(1, browseGeneration.current);
    return () => browseAbort.current?.abort();
  }, [
    tab,
    category,
    debouncedSearch,
    searchRevision,
    status?.configured,
    fetchPage,
  ]);

  const liveCategories = useMemo(
    () => categories.filter((value) => value.kind === "live"),
    [categories],
  );
  const currentCategory = categories.find(
    (value) => value.kind === tab && value.id === category,
  );
  const liveSearchIndex = useMemo(() => liveItems.map((item) => ({ item, name: normalizeSearch(item.name) })), [liveItems]);
  const liveTerms = useMemo(() => normalizeSearch(search).split(/\s+/).filter(Boolean), [search]);
  const selectedLiveCategoryName = category === "*" ? null : liveCategories.find((value) => value.id === category)?.name;
  const filteredLive = useMemo(
    () =>
      liveSearchIndex.filter(
        ({ item, name }) =>
          (category === "*" ||
            selectedLiveCategoryName === item.category) &&
          liveTerms.every((token) => name.includes(token)),
      ).map(({ item }) => item),
    [liveSearchIndex, selectedLiveCategoryName, category, liveTerms],
  );
  const items = tab === "live" ? filteredLive : browseItems;
  const shownItems = tab === "live" ? items.slice(0, visibleCount) : items;
  const epgByChannel = useMemo(() => {
    const grouped = new Map<string, Program[]>();
    for (const program of programs) {
      const list = grouped.get(program.channelId) || [];
      list.push(program);
      grouped.set(program.channelId, list);
    }
    for (const list of grouped.values())
      list.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return grouped;
  }, [programs]);
  const selectCategory = (nextTab: Tab, nextCategory = "*", closeDrawer = true) => {
    searchPending.current = false;
    writeLocation(nextTab, nextCategory, "");
    setTab(nextTab);
    setCategory(nextCategory);
    setSearch("");
    setDebouncedSearch("");
    setVisibleCount(72);
    setSelected(null);
    setSelectedId("");
    setCategoryPane((old) => old === nextTab ? old : null);
    if (closeDrawer) setDrawerOpen(false);
  };
  const toggleSection = (nextTab: Tab) => {
    const wasOpen = categoryPane === nextTab;
    if (tab !== nextTab) selectCategory(nextTab, "*", false);
    setCategoryPane(wasOpen ? null : nextTab);
  };
  const updateStatus = useCallback(() => {
    void request<Status>("/api/status")
      .then(setStatus)
      .catch(() => {});
  }, []);
  const closePlayer = useCallback(() => {
    setSelected(null);
    setSelectedId("");
    setDetailError("");
    writeLocation(tab, category, search, true);
    window.requestAnimationFrame(() => { window.scrollTo({ top: libraryScroll.current }); opener.current?.focus({ preventScroll: true }); });
  }, [tab, category, search]);
  const navigation = (paneId: string) => (
    <nav className="library-nav" aria-label="Library">
      <div className="nav-heading">LIBRARY</div>
      {sections.map((section) => {
        const Icon = section.icon;
        return (
          <div className="nav-section" key={section.id}>
              <button
                type="button"
                className={`nav-parent ${tab === section.id ? "active" : ""}`}
                aria-expanded={categoryPane === section.id}
                aria-controls={paneId}
                onClick={() => toggleSection(section.id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{section.label}</span>
              </button>
          </div>
        );
      })}
    </nav>
  );
  const categoryNavigation = (kind: Tab) => {
    const list = categories.filter((value) => value.kind === kind && keywordMatch(value.name, categoryQuery));
    return <div className="category-navigation">
      <button type="button" className={`nav-child ${tab === kind && category === "*" ? "active" : ""}`} onClick={() => selectCategory(kind)}>All {sections.find((value) => value.id === kind)?.label}</button>
      {list.length ? list.map((value) => <button type="button" key={`${kind}:${value.id}`} className={`nav-child ${tab === kind && category === value.id ? "active" : ""}`} aria-current={tab === kind && category === value.id ? "page" : undefined} onClick={() => selectCategory(kind, value.id)}>{value.name}</button>) : <span className="nav-empty">No matching categories</span>}
    </div>;
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <div className="brand">
            <button
              ref={menuButton}
              className="mobile-menu"
              aria-label="Open library menu"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu size={19} />
            </button>
            <span className="brand-symbol" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Restream</span>
          </div>
          <div className="header-status" aria-live="polite">
            {status?.configured && (
              <span className="stream-count">
                <span className="status-dot" />
                {status.activeStreams} / {status.maxStreams} streams active
              </span>
            )}
            {status?.refreshing && (
              <span className="refreshing">Updating library…</span>
            )}
          </div>
        </div>
      </header>
      <div className={`library-layout ${categoryPane ? "categories-open" : ""}`}>
        <aside className="library-sidebar">
          {navigation("category-pane-desktop")}
        </aside>
        <aside id="category-pane-desktop" className="category-pane" aria-label="Categories" aria-hidden={!categoryPane}>
          {categoryPane && <>
            <div className="category-pane-heading"><span>{sections.find((value) => value.id === categoryPane)?.label} categories</span><button className="icon-button" aria-label="Close categories" onClick={() => setCategoryPane(null)}><X size={16} /></button></div>
            <label className="category-search"><Search size={14} aria-hidden="true" /><span className="sr-only">Filter categories</span><Input value={categoryQuery} onChange={(event) => setCategoryQuery(event.target.value)} placeholder="Find a category" /></label>
            {categoryNavigation(categoryPane)}
          </>}
        </aside>
        <main id="main-content" className="main-content">
          {selectedId ? selected ? (
            <PlayerPage key={`${selected.kind}:${selected.id}`} item={selected} programs={epgByChannel.get(selected.id) || []} now={now} onClose={closePlayer} onSessionChange={updateStatus} />
          ) : detailError ? <div className="state-card state-block" role="alert"><h2>Couldn’t open this title</h2><p>{detailError}</p><Button onClick={closePlayer}>Back to library</Button></div>
          : <div className="loading-library" role="status">Loading title…</div> : loading ? (
            <div
              className="loading-library"
              role="status"
              aria-label="Loading your library"
            >
              <Skeleton className="h-9 w-56" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : !status?.configured && !error ? (
            <div className="state-card state-block" role="status">
              <h2>Restream is awaiting setup</h2>
              <p>Ask your administrator to finish setting up the library.</p>
            </div>
          ) : error ? (
            <div className="state-card state-block" role="alert">
              <h2>Couldn’t load the library</h2>
              <p>{error}</p>
              <Button
                className="button-primary"
                onClick={() => window.location.reload()}
              >
                Try again
              </Button>
            </div>
          ) : (
            <>
              {status?.error && (
                <div className="notice" role="alert">
                  {status.error}
                </div>
              )}
              <div className="catalog-toolbar">
                <div className="catalog-summary">
                  <p className="breadcrumb">
                    Library /{" "}
                    {sections.find((value) => value.id === tab)?.label}
                    {currentCategory ? ` / ${currentCategory.name}` : ""}
                  </p>
                  <h1>
                    {currentCategory?.name ||
                      sections.find((value) => value.id === tab)?.label}
                  </h1>
                  <p>
                    {tab === "live"
                      ? `${items.length} channels`
                      : `${items.length} titles loaded${browseLoading ? " · Loading…" : ""}`}
                  </p>
                </div>
                <label className="search-field">
                  <Search size={15} aria-hidden="true" />
                  <span className="sr-only">
                    Search {tab === "live" ? "channels" : "titles"}
                  </span>
                  <Input
                    type="search"
                    value={search}
                    placeholder={`Search ${tab === "live" ? "channels" : tab === "movie" ? "movies" : "series"}`}
                    onChange={(event) => {
                      searchPending.current = true;
                      setSearch(event.target.value);
                      setVisibleCount(72);
                    }}
                  />
                </label>
              </div>
              {items.length > 0 && (
                <div
                  className={
                    tab === "live" ? "catalog-grid live-grid" : "catalog-grid"
                  }
                >
                  {shownItems.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className="media-card"
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        libraryScroll.current = window.scrollY;
                        searchPending.current = false;
                        setSelected(item);
                        setSelectedId(item.id);
                        writeLocation(tab, category, search, false, item.id);
                        window.scrollTo({ top: 0 });
                      }}
                      aria-label={`Open ${item.name}`}
                    >
                      <div className="card-art">
                        <Artwork item={item} />
                        <span className="card-play" aria-hidden="true">
                          <Play size={13} fill="currentColor" />
                        </span>
                      </div>
                      <div className="card-content">
                        <div className="card-title-row">
                          <h3>{item.name}</h3>
                          {item.number !== undefined && (
                            <span className="channel-number">
                              CH {item.number}
                            </span>
                          )}
                        </div>
                        <p className="card-category">
                          {item.category ||
                            (tab === "live" ? "Live channel" : "Entertainment")}
                        </p>
                        {tab === "live" && (
                          <EpgPreview
                            programs={epgByChannel.get(item.id) || []}
                            now={now}
                          />
                        )}
                        {tab !== "live" && item.description && (
                          <p className="card-description">{item.description}</p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {!browseLoading && !browseError && items.length === 0 && (
                <div className="empty-state" role="status">
                  <h3>
                    {tab !== "live" && hasMore
                      ? `No ${tab === "movie" ? "movies" : "series"} in the pages checked yet`
                      : search
                        ? "No matches found"
                        : tab === "live"
                          ? "No channels yet"
                          : "No titles in this category"}
                  </h3>
                  <p>
                    {hasMore
                      ? "Continue loading to check the next pages."
                      : "Try another category or search."}
                  </p>
                </div>
              )}
              {browseLoading && (
                <div className="page-status" role="status">
                  <span className="spinner" /> Loading{" "}
                  {tab === "movie" ? "movies" : "series"}…
                </div>
              )}
              {browseError && (
                <div className="page-error" role="alert">
                  <span>{browseError}</span>
                  <Button
                    onClick={() =>
                      fetchPage(browsePage + 1, browseGeneration.current)
                    }
                  >
                    Retry page
                  </Button>
                </div>
              )}
              {tab === "live" && items.length > visibleCount && (
                <Button
                  className="load-more"
                  onClick={() => setVisibleCount((count) => count + 72)}
                >
                  Show more
                </Button>
              )}
              {tab !== "live" && hasMore && !browseLoading && !browseError && (
                <Button
                  className="load-more"
                  onClick={() =>
                    fetchPage(browsePage + 1, browseGeneration.current)
                  }
                >
                  Load more
                </Button>
              )}
            </>
          )}
        </main>
      </div>
      <ResponsiveModal open={drawerOpen} onOpenChange={setDrawerOpen}>
        <ResponsiveModalContent
          side="left"
          className="mobile-drawer"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            menuButton.current?.focus();
          }}
        >
          <div className="drawer-header">
            <ResponsiveModalTitle>Library</ResponsiveModalTitle>
            <ResponsiveModalClose
              aria-label="Close library menu"
              className="icon-button"
            >
              <X size={18} />
            </ResponsiveModalClose>
          </div>
          <label className="category-search">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Filter categories</span>
            <Input
              value={categoryQuery}
              onChange={(event) => setCategoryQuery(event.target.value)}
              placeholder="Filter categories"
            />
          </label>
          {navigation("category-pane-mobile")}
          <div id="category-pane-mobile" className="mobile-category-group" hidden={!categoryPane}>{categoryPane && <><h3>{sections.find((value) => value.id === categoryPane)?.label} categories</h3>{categoryNavigation(categoryPane)}</>}</div>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}

function EpgPreview({ programs, now }: { programs: Program[]; now: number }) {
  const { current, next } = epgFor(programs, now);
  if (!current && !next)
    return <p className="epg-unavailable">Schedule unavailable</p>;
  return (
    <div className="epg-preview">
      {current && (
        <p>
          <span>NOW</span>
          <strong>{current.title}</strong>
          <time>{formatTime(current.end)}</time>
        </p>
      )}
      {next && (
        <p>
          <span>NEXT</span>
          <strong>{next.title}</strong>
          <time>{formatTime(next.start)}</time>
        </p>
      )}
    </div>
  );
}

function PlayerPage({
  item,
  programs,
  now,
  onClose,
  onSessionChange,
}: {
  item: Item;
  programs: Program[];
  now: number;
  onClose: () => void;
  onSessionChange: () => void;
}) {
  const playbackArea = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const sessionId = useRef<string | null>(null);
  const seekVersion = useRef(0);
  const seekingRef = useRef(false);
  const pendingPlayUrlRef = useRef<string | null>(null);
  const attachedUrlRef = useRef<string | null>(null);
  const resumeNeedsSeekRef = useRef(false);
  const suppressPauseRef = useRef(false);
  const releasedRef = useRef(false);
  const releasePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const transitionRef = useRef<Promise<void>>(Promise.resolve());
  const [episode, setEpisode] = useState<Item | null>(null);
  const [playingEpisode, setPlayingEpisode] = useState<Item | null>(null);
  const [playRequested, setPlayRequested] = useState(false);
  const [playAttempt, setPlayAttempt] = useState(0);
  const [episodes, setEpisodes] = useState<Item[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(
    item.kind === "series",
  );
  const [episodesError, setEpisodesError] = useState("");
  const [episodeRetry, setEpisodeRetry] = useState(0);
  const [season, setSeason] = useState<number | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [position, setPosition] = useState(0);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [seeking, setSeeking] = useState(false);
  const [viewerFinished, setViewerFinished] = useState(false);
  const activeItem = item.kind === "series" ? playingEpisode : item;

  useEffect(() => {
    if (item.kind !== "series") return;
    let alive = true;
    setEpisodesError("");
    setEpisodesLoading(true);
    void request<{ items: Item[] }>(
      `/api/series/${encodeURIComponent(item.id)}/episodes`,
    )
      .then((result) => {
        if (alive) {
          setEpisodes(result.items);
          setSeason(result.items[0]?.season ?? 1);
          setEpisode(result.items[0] || null);
          setEpisodesLoading(false);
        }
      })
      .catch((cause) => {
        if (alive) {
          setEpisodesError(message(cause));
          setEpisodesLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [item, episodeRetry]);

  useEffect(() => {
    if (!activeItem || !playRequested) return;
    let alive = true;
    let timer: number | undefined;
    let heartbeat: number | undefined;
    let pollBusy = false;
    let currentId: string | null = null;
    let postStarted = false;
    let postDone = false;
    let stopped = false;
    let releaseKeepalive = false;
    let resolved = false;
    let resolveTransition!: () => void;
    const priorTransition = transitionRef.current;
    transitionRef.current = new Promise<void>((resolve) => {
      resolveTransition = resolve;
    });
    const finishTransition = () => {
      if (!resolved) {
        resolved = true;
        resolveTransition();
      }
    };
    const stop = (keepalive = false) => {
      if (stopped) return;
      stopped = true;
      releaseKeepalive = keepalive;
      alive = false;
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (currentId && !releasedRef.current) {
        releasedRef.current = true;
        releasePromiseRef.current = releaseSession(currentId, keepalive);
      }
      if (currentId) void releasePromiseRef.current.finally(finishTransition);
      else if (!postStarted) void priorTransition.finally(finishTransition);
      else if (postDone) finishTransition();
      if (sessionId.current === currentId) sessionId.current = null;
      onSessionChange();
    };
    releasedRef.current = false;
    resumeNeedsSeekRef.current = false;
    pendingPlayUrlRef.current = null;
    setSession(null);
    setError("");
    setPosition(0);
    setSeeking(false);
    setSeekTarget(null);
    setPlaying(false);
    setViewerFinished(false);
    void priorTransition.then(() => {
      if (!alive) return;
      postStarted = true;
      return jsonRequest<Session>("/api/sessions", "POST", {
        itemId: activeItem.id,
      })
        .then((value) => {
          postDone = true;
          if (!alive) {
            releasePromiseRef.current = releaseSession(
              value.id,
              releaseKeepalive,
            );
            void releasePromiseRef.current.finally(finishTransition);
            return;
          }
          currentId = value.id;
          sessionId.current = value.id;
          setSession(value);
          pendingPlayUrlRef.current = value.url;
          onSessionChange();
          if (value.state === "failed") {
            setError(value.error || "This stream is unavailable.");
            return;
          }
          timer = window.setInterval(() => {
            if (pollBusy || seekingRef.current || releasedRef.current) return;
            pollBusy = true;
            const version = seekVersion.current;
            void request<Session>(
              `/api/sessions/${encodeURIComponent(value.id)}`,
            )
              .then((next) => {
                if (!alive || version !== seekVersion.current) return;
                setSession(next);
                if (next.state === "failed")
                  setError(next.error || "This stream failed.");
              })
              .catch((cause) => {
                if (alive) setError(message(cause));
              })
              .finally(() => {
                pollBusy = false;
              });
          }, 2000);
          heartbeat = window.setInterval(() => {
            if (!releasedRef.current)
              void request<void>(
                `/api/sessions/${encodeURIComponent(value.id)}/heartbeat`,
                { method: "POST" },
              ).catch((cause) => {
                if (alive && !releasedRef.current) setError(message(cause));
              });
          }, 15000);
        })
        .catch((cause) => {
          postDone = true;
          if (alive)
            setError(
              cause instanceof ApiError &&
                (cause.status === 409 || cause.code === "capacity")
                ? noRoom
                : message(cause),
            );
          else finishTransition();
        });
    });
    const onPageHide = () => stop(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      stop();
    };
  }, [activeItem?.id, playRequested, playAttempt, onSessionChange]);
  useEffect(() => {
    if (playRequested) window.requestAnimationFrame(() => playbackArea.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }));
  }, [playRequested]);

  useEffect(() => {
    seekingRef.current = seeking;
  }, [seeking]);

  useEffect(() => {
    const element = video.current;
    if (
      !playRequested ||
      !element ||
      !session?.url ||
      (session.state !== "ready" && session.state !== "ended")
    )
      return;
    let hls: Hls | undefined;
    setPlaying(false);
    suppressPauseRef.current = true;
    attachedUrlRef.current = session.url;
    element.pause();
    element.removeAttribute("src");
    element.load();
    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, startPosition: 0 });
      hls.loadSource(session.url);
      hls.attachMedia(element);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal)
          setError("Playback stopped. Please try this stream again.");
      });
    } else if (element.canPlayType("application/vnd.apple.mpegurl"))
      element.src = session.url;
    else setError("This browser does not support HLS playback.");
    return () => {
      attachedUrlRef.current = null;
      hls?.destroy();
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [playRequested, session?.url, session?.state === "ready" || session?.state === "ended"]);

  const seek = async (target: number, resume = false) => {
    const id = sessionId.current;
    if (!id || !session || seekingRef.current) return;
    if (!Number.isFinite(session.duration) || session.duration <= 0) return;
    const desired = Math.max(
      0,
      Math.min(Math.max(0, session.duration - 0.5), target),
    );
    seekVersion.current++;
    const resumeAfterSeek =
      resume || !!(video.current && !video.current.paused);
    pendingPlayUrlRef.current = null;
    suppressPauseRef.current = true;
    setSeeking(true);
    seekingRef.current = true;
    setError("");
    try {
      const next = await jsonRequest<Session>(
        `/api/sessions/${encodeURIComponent(id)}/seek`,
        "POST",
        { position: desired },
      );
      if (sessionId.current !== id) return;
      pendingPlayUrlRef.current = resumeAfterSeek ? next.url : null;
      setSession(next);
      setPosition(next.offset);
      setSeekTarget(null);
      resumeNeedsSeekRef.current = false;
      if (next.state === "failed")
        setError(next.error || "Could not seek in this video.");
    } catch (cause) {
      if (sessionId.current === id) setError(message(cause));
      pendingPlayUrlRef.current = null;
      suppressPauseRef.current = false;
    } finally {
      setSeeking(false);
      seekingRef.current = false;
    }
  };
  const togglePlay = async () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) {
      if (
        resumeNeedsSeekRef.current &&
        (session?.state === "ready" || session?.state === "ended") &&
        session.duration > 0
      ) {
        await seek(position, true);
        return;
      }
      try {
        await element.play();
        setError("");
      } catch {
        setError("Playback could not start. Try pressing play again.");
      }
    } else element.pause();
  };
  const finishPlayback = () => {
    const id = sessionId.current;
    if (id && !releasedRef.current) {
      releasedRef.current = true;
      releasePromiseRef.current = releaseSession(id);
      sessionId.current = null;
      onSessionChange();
    }
    setViewerFinished(true);
    setPlaying(false);
  };
  const seasons = [...new Set(episodes.map((value) => value.season ?? 1))].sort(
    (a, b) => a - b,
  );
  const shownEpisodes = episodes.filter(
    (value) => (value.season ?? 1) === season,
  );
  const vod = activeItem?.kind === "movie" || activeItem?.kind === "episode";
  const absolutePosition = Math.min(
    session?.duration || 0,
    seekTarget ?? position,
  );

  return (
    <article className={`title-page ${playRequested ? "watching" : ""}`}>
      <button type="button" className="back-link" onClick={onClose}><ArrowLeft size={16} /> Back to library</button>
      <div className="title-hero">
        <div className="title-art"><Artwork item={item} /></div>
        <div className="title-information">
          <span className="eyebrow">{item.kind === "series" ? "SERIES" : item.kind === "live" ? "LIVE TV" : "MOVIE"}</span>
          <h1>{item.name}</h1>
          <p className="title-category">{item.category || (item.kind === "live" ? "Live channel" : "Entertainment")}{item.number && ` · Channel ${item.number}`}</p>
          {item.description && <p className="title-description">{item.description}</p>}
          {item.kind === "live" && <div className="title-guide"><h2>On this channel</h2><EpgPreview programs={programs} now={now} /></div>}
          {item.kind === "series" && episode && <p className="selected-episode">Selected · S{episode.season ?? 1} E{episode.episode ?? "—"} · {episode.name}</p>}
          <Button className="hero-play" disabled={item.kind === "series" && !episode} onClick={() => { if (item.kind === "series") setPlayingEpisode(episode); setPlayRequested(true); }}><Play size={17} fill="currentColor" /> {item.kind === "series" ? "Play episode" : "Play"}</Button>
        </div>
      </div>
        {item.kind === "series" && (
          <div className="episode-browser">
            <div className="episode-heading">
              <h3>Episodes</h3>
              {seasons.length > 0 && (
                <label>
                  <span className="sr-only">Season</span>
                  <select
                    value={season ?? ""}
                    onChange={(event) => {
                      const nextSeason = Number(event.target.value);
                      setSeason(nextSeason);
                      setEpisode(episodes.find((value) => (value.season ?? 1) === nextSeason) || null);
                    }}
                  >
                    {seasons.map((value) => (
                      <option key={value} value={value}>
                        Season {value}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {episodesLoading ? (
              <p role="status">Loading episodes…</p>
            ) : episodesError ? (
              <div role="alert" className="inline-error episode-error">
                <span>{episodesError}</span>
                <Button onClick={() => setEpisodeRetry((value) => value + 1)}>Retry episodes</Button>
              </div>
            ) : shownEpisodes.length ? (
              <div className="episode-list">
                {shownEpisodes.map((value) => (
                  <button
                    key={value.id}
                    className={
                      (playRequested ? playingEpisode?.id : episode?.id) === value.id
                        ? "episode-row selected"
                        : "episode-row"
                    }
                    onClick={() => { setEpisode(value); if (playRequested) setPlayingEpisode(value); }}
                  >
                    <span className="episode-number">
                      {value.episode ?? "▶"}
                    </span>
                    <span>
                      <strong>{value.name}</strong>
                      <small>{value.description || "Select to watch"}</small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="episode-empty">No episodes are available.</p>
            )}
          </div>
        )}
        {playRequested && activeItem && (
          <section className="watch-section" aria-label="Player"><div className="watch-heading"><h2>Now playing</h2><button className="icon-button close-button" aria-label="Close player" onClick={() => setPlayRequested(false)}><X size={18} /></button></div>
          <div className="playback-area" ref={playbackArea}>
            <div className="video-wrap">
              <video
                ref={video}
                playsInline
                controls={!vod}
                onPlay={() => {
                  setPlaying(true);
                  suppressPauseRef.current = false;
                }}
                onPause={() => {
                  if (playing && vod && !suppressPauseRef.current)
                    resumeNeedsSeekRef.current = true;
                  setPlaying(false);
                }}
                onCanPlay={() => {
                  suppressPauseRef.current = false;
                  if (
                    pendingPlayUrlRef.current &&
                    pendingPlayUrlRef.current === attachedUrlRef.current &&
                    video.current
                  ) {
                    pendingPlayUrlRef.current = null;
                    void video.current
                      .play()
                      .catch(() =>
                        setError(
                          "Playback could not start. Press play to try again.",
                        ),
                      );
                  }
                }}
                onEnded={finishPlayback}
                onTimeUpdate={(event) =>
                  setPosition(
                    (session?.offset || 0) + event.currentTarget.currentTime,
                  )
                }
                onError={() => {
                  if (session?.state === "ready")
                    setError("The video could not be played.");
                }}
                aria-label={`${activeItem?.name} video`}
              />
              {session?.state === "starting" && (
                <div className="video-overlay" role="status">
                  <span className="spinner" />
                  Starting stream…
                </div>
              )}
              {!session && !error && (
                <div className="video-overlay" role="status">
                  <span className="spinner" />
                  Getting stream…
                </div>
              )}
              {viewerFinished && (
                <div className="video-overlay" role="status">
                  Playback finished
                </div>
              )}
            </div>
            {error && (
              <div className="player-error" role="alert">
                <span>{error}</span><Button onClick={() => setPlayAttempt((value) => value + 1)}>Try again</Button>
              </div>
            )}
            {vod &&
              (session?.state === "ready" || session?.state === "ended") && (
                <div className="video-controls">
                  <button
                    className="control-button"
                    onClick={() => void togglePlay()}
                    aria-label={playing ? "Pause" : "Play"}
                    disabled={viewerFinished}
                  >
                    {playing ? (
                      <Pause size={17} fill="currentColor" />
                    ) : (
                      <Play size={17} fill="currentColor" />
                    )}
                  </button>
                  <span className="time-readout">
                    {formatDuration(absolutePosition)}
                  </span>
                  <input
                    type="range"
                    className="timeline"
                    aria-label="Seek position"
                    min={0}
                    max={Math.max(1, session.duration)}
                    step={1}
                    value={absolutePosition}
                    disabled={
                      seeking ||
                      viewerFinished ||
                      !Number.isFinite(session.duration) ||
                      session.duration <= 0
                    }
                    onChange={(event) =>
                      setSeekTarget(Number(event.target.value))
                    }
                    onPointerUp={(event) => {
                      const target = Number(event.currentTarget.value);
                      void seek(target);
                    }}
                    onKeyUp={(event) => {
                      if (
                        [
                          "ArrowLeft",
                          "ArrowRight",
                          "Home",
                          "End",
                          "PageUp",
                          "PageDown",
                        ].includes(event.key)
                      )
                        void seek(Number(event.currentTarget.value));
                    }}
                  />
                  <span className="time-readout">
                    {formatDuration(session.duration)}
                  </span>
                  <button
                    className="control-button"
                    onClick={() => {
                      if (video.current) {
                        video.current.muted = !video.current.muted;
                        setMuted(video.current.muted);
                      }
                    }}
                    aria-label={muted ? "Unmute" : "Mute"}
                  >
                    {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
                  </button>
                  <button
                    className="control-button fullscreen"
                    onClick={() =>
                      void playbackArea.current?.requestFullscreen?.()
                    }
                    aria-label="Full screen"
                  >
                    <Maximize2 size={17} />
                  </button>
                </div>
              )}
            <div className="player-meta">
              <div>
                <h3>{activeItem?.name}</h3>
                {activeItem?.description && <p>{activeItem.description}</p>}
              </div>
              {item.kind === "live" && (
                <span className="live-badge">
                  <span className="status-dot" />
                  LIVE
                </span>
              )}
            </div>
          </div>
          </section>
        )}
    </article>
  );
}

export default App;
