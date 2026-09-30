import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type Hls from "hls.js";
import hlsWorkerUrl from "hls.js/dist/hls.worker.js?url";
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  Radio,
  Clapperboard,
  ChevronLeft,
  ChevronRight,
  Film,
  ListFilter,
  MonitorPlay,
  Pause,
  Play,
  Settings,
  Square,
} from "lucide-react";
import type { RefreshTarget } from "./components/settings-page";
import { PlayerControls } from "./components/player-controls";
import { GalaxyBackdrop } from "./components/galaxy-backdrop";
import { Button } from "./components/ui/button";
import { Skeleton } from "./components/ui/skeleton";
import { BeamSearch } from "./components/spectrumui/beam-search";
import { Artwork } from "./components/artwork";
import { Spinner } from "./components/spectrumui/spinner-dependencies";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
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

const SettingsPage = lazy(() =>
  import("./components/settings-page").then((module) => ({
    default: module.SettingsPage,
  })),
);

type Tab = "live" | "movie" | "series";
type PlaybackSelection = { item: Item; title: Item };
type EpisodeDestination = {
  titleId: string;
  season: number;
  episodeId: string;
};
type PlaybackDestination = "library" | "category" | "title" | "season";
function locationSelection() {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get("section");
  const season = Number(params.get("season"));
  return {
    tab: (kind === "movie" || kind === "series" ? kind : "live") as Tab,
    category: params.get("category") || "*",
    search: params.get("search") || "",
    item: params.get("item") || "",
    settings: params.get("view") === "settings",
    episodeDestination:
      params.get("item") && Number.isInteger(season) && season > 0
        ? {
            titleId: params.get("item")!,
            season,
            episodeId: params.get("episode") || "",
          }
        : null,
  };
}
function writeLocation(
  tab: Tab,
  category: string,
  search: string,
  replace = false,
  item = "",
  settings = false,
  episodeDestination: EpisodeDestination | null = null,
) {
  window.history[replace ? "replaceState" : "pushState"](
    {},
    "",
    selectionURL(tab, category, search, item, settings, episodeDestination),
  );
}
function selectionURL(
  tab: Tab,
  category: string,
  search: string,
  item = "",
  settings = false,
  episodeDestination: EpisodeDestination | null = null,
) {
  const url = new URL(window.location.href);
  if (settings) url.searchParams.set("view", "settings");
  else url.searchParams.delete("view");
  if (tab === "live") url.searchParams.delete("section");
  else url.searchParams.set("section", tab);
  if (category === "*") url.searchParams.delete("category");
  else url.searchParams.set("category", category);
  if (search) url.searchParams.set("search", search);
  else url.searchParams.delete("search");
  if (item) url.searchParams.set("item", item);
  else url.searchParams.delete("item");
  if (item && episodeDestination) {
    url.searchParams.set("season", String(episodeDestination.season));
    url.searchParams.set("episode", episodeDestination.episodeId);
  } else {
    url.searchParams.delete("season");
    url.searchParams.delete("episode");
  }
  return url;
}
const sections = [
  { id: "live" as Tab, label: "Live TV", icon: MonitorPlay },
  { id: "movie" as Tab, label: "Movies", icon: Film },
  { id: "series" as Tab, label: "Series", icon: Clapperboard },
  { id: "settings" as const, label: "Settings", icon: Settings },
];
const noRoom =
  "No room available. All streaming slots are in use. Try again when someone stops watching.";
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
function normalizeSearch(text: string) {
  return text
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\p{M}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <img src="/favicon.svg?v=orbit" width={36} height={36} alt="" />
    </span>
  );
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState("");
  const [statusCheckedAt, setStatusCheckedAt] = useState<number | null>(null);
  const statusLoaded = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(
    () => locationSelection().settings,
  );
  const [liveItems, setLiveItems] = useState<Item[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(() => locationSelection().tab);
  const [category, setCategory] = useState(() => locationSelection().category);
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
  const [playbackDetailsId, setPlaybackDetailsId] = useState("");
  const [livePlaybackRequested, setLivePlaybackRequested] = useState(false);
  const [playback, setPlayback] = useState<PlaybackSelection | null>(null);
  const [episodeDestination, setEpisodeDestination] =
    useState<EpisodeDestination | null>(
      () => locationSelection().episodeDestination,
    );
  const opener = useRef<HTMLButtonElement | null>(null);
  const playbackTransition = useRef<Promise<void>>(Promise.resolve());
  const expandedArea = useRef<HTMLElement | null>(null);
  const scrolledExpansion = useRef("");
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  const [catalogGrid, setCatalogGrid] = useState<HTMLDivElement | null>(null);
  const [playerDock, setPlayerDock] = useState<HTMLDivElement | null>(null);
  const [gridColumns, setGridColumns] = useState(1);
  const libraryScroll = useRef(0);
  const categoryRail = useRef<HTMLDivElement | null>(null);
  const [loadSentinel, setLoadSentinel] = useState<HTMLDivElement | null>(null);
  const browseAbort = useRef<AbortController | null>(null);
  const browseGeneration = useRef(0);
  const searchPending = useRef(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [visibleCount, setVisibleCount] = useState(72);
  const [categoryRailOpen, setCategoryRailOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");

  useLayoutEffect(() => {
    if (!playerDock) return;
    const measure = () => {
      document.documentElement.style.setProperty(
        "--player-dock-height",
        `${playerDock.getBoundingClientRect().height}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(playerDock);
    measure();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--player-dock-height");
    };
  }, [playerDock]);

  useEffect(() => {
    let alive = true;
    void request<Status>("/api/status")
      .then((value) => {
        if (alive) {
          setStatus(value);
          statusLoaded.current = true;
          setStatusError("");
          setStatusCheckedAt(Date.now());
          if (!value.configured) {
            setLoading(false);
            setError("");
          }
        }
      })
      .catch((cause) => {
        if (alive) {
          setStatusError(message(cause));
          if (!statusLoaded.current) {
            setError(message(cause));
            setLoading(false);
          }
        }
      });
    const interval = window.setInterval(
      () => {
        void request<Status>("/api/status")
          .then((value) => {
            if (alive) {
              setStatus(value);
              statusLoaded.current = true;
              setStatusError("");
              setStatusCheckedAt(Date.now());
            }
          })
          .catch((cause) => {
            if (alive) setStatusError(message(cause));
          });
      },
      settingsOpen || status?.refreshing ? 2000 : 10000,
    );
    const clock = window.setInterval(() => setNow(Date.now()), 30000);
    return () => {
      alive = false;
      clearInterval(interval);
      clearInterval(clock);
    };
  }, [settingsOpen, status?.refreshing]);
  useEffect(() => {
    const restore = () => {
      const next = locationSelection();
      searchPending.current = false;
      setTab(next.tab);
      setSettingsOpen(next.settings);
      setCategory(next.category);
      setSearch(next.search);
      setDebouncedSearch(next.search);
      setSelectedId(next.item);
      setPlaybackDetailsId("");
      setEpisodeDestination(next.episodeDestination);
      setSelected((old) => (old?.id === next.item ? old : null));
      window.requestAnimationFrame(() =>
        window.scrollTo({ top: libraryScroll.current }),
      );
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!selectedId || selected?.id === selectedId || !status?.configured)
      return;
    let alive = true;
    setDetailError("");
    void request<{ item: Item }>(`/api/items/${encodeURIComponent(selectedId)}`)
      .then(({ item }) => {
        if (alive) setSelected(item);
      })
      .catch((cause) => {
        if (alive) setDetailError(message(cause));
      });
    return () => {
      alive = false;
    };
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
    if (!searchPending.current) return;
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
      writeLocation(
        tab,
        category,
        search.trim(),
        true,
        selectedId,
        settingsOpen,
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [search, tab, category, selectedId, settingsOpen]);

  const fetchPage = useCallback(
    (page: number, generation: number, pagesToLoad = 3) => {
      if (tab === "live") return;
      browseAbort.current?.abort();
      const controller = new AbortController();
      browseAbort.current = controller;
      setBrowseLoading(true);
      setBrowseError("");
      const isCurrent = () =>
        !controller.signal.aborted && generation === browseGeneration.current;
      void (async () => {
        try {
          const collected: Item[] = [];
          let populatedPages = 0;
          // Portal pages may mix movies and series. Check a few pages per action
          // so a filtered empty page does not make a section look empty.
          for (let nextPage = page; nextPage < page + 5; nextPage++) {
            const params = new URLSearchParams({
              kind: tab,
              category,
              search: debouncedSearch,
              page: String(nextPage),
            });
            const result = await request<BrowsePage>(`/api/browse?${params}`, {
              signal: controller.signal,
            });
            if (!isCurrent()) return;
            setBrowsePage(nextPage);
            setHasMore(result.hasMore);
            if (result.items?.length) {
              collected.push(...result.items);
              populatedPages++;
              if (populatedPages >= pagesToLoad) break;
            }
            if (!result.hasMore) break;
          }
          if (collected.length && isCurrent())
            setBrowseItems((old) => {
              const previous = page === 1 ? [] : old;
              const existing = new Set(previous.map((item) => item.id));
              return [
                ...previous,
                ...collected.filter((item) => {
                  if (existing.has(item.id)) return false;
                  existing.add(item.id);
                  return true;
                }),
              ];
            });
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
    status?.libraryUpdatedAt,
    fetchPage,
  ]);

  useEffect(() => {
    if (!catalogGrid) return;
    const measure = () =>
      setGridColumns(
        getComputedStyle(catalogGrid).gridTemplateColumns.split(" ").length ||
          1,
      );
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(catalogGrid);
    return () => observer.disconnect();
  }, [catalogGrid]);

  const liveCategories = useMemo(
    () => categories.filter((value) => value.kind === "live"),
    [categories],
  );
  const liveSearchIndex = useMemo(
    () => liveItems.map((item) => ({ item, name: normalizeSearch(item.name) })),
    [liveItems],
  );
  const liveTerms = useMemo(
    () => normalizeSearch(search).split(/\s+/).filter(Boolean),
    [search],
  );
  const selectedLiveCategoryName =
    category === "*"
      ? null
      : liveCategories.find((value) => value.id === category)?.name;
  const filteredLive = useMemo(
    () =>
      liveSearchIndex
        .filter(
          ({ item, name }) =>
            (category === "*" ||
              item.categoryId === category ||
              selectedLiveCategoryName === item.category) &&
            liveTerms.every((token) => name.includes(token)),
        )
        .map(({ item }) => item),
    [liveSearchIndex, selectedLiveCategoryName, category, liveTerms],
  );
  const items = tab === "live" ? filteredLive : browseItems;
  const shownItems = tab === "live" ? items.slice(0, visibleCount) : items;
  // Keep the selected tile available as its close control when search filters it out.
  const displayedItems =
    selected && !shownItems.some((item) => item.id === selected.id)
      ? [selected, ...shownItems]
      : shownItems;
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
  const currentPrograms = useMemo(() => {
    const current = new Map<string, Program>();
    for (const [channelId, schedule] of epgByChannel) {
      const program = schedule.find(
        (value) =>
          Date.parse(value.start) <= now && now < Date.parse(value.end),
      );
      if (program?.title.trim()) current.set(channelId, program);
    }
    return current;
  }, [epgByChannel, now]);
  const onLivePlaybackChange = useCallback((active: boolean) => {
    setLivePlaybackRequested(active);
  }, []);
  const selectCategory = (nextTab: Tab, nextCategory = "*") => {
    setSettingsOpen(false);
    searchPending.current = false;
    writeLocation(nextTab, nextCategory, "");
    setTab(nextTab);
    setCategory(nextCategory);
    setSearch("");
    setDebouncedSearch("");
    setVisibleCount(72);
    setSelected(null);
    setSelectedId("");
    setPlaybackDetailsId("");
    setEpisodeDestination(null);
  };
  const navigateSection = (next: Tab | "settings") => {
    if (next === "settings") {
      if (settingsOpen) return;
      libraryScroll.current = window.scrollY;
      writeLocation(tab, category, search, false, selectedId, true);
      setSettingsOpen(true);
      window.scrollTo({ top: 0 });
    } else if (settingsOpen && next === tab) {
      writeLocation(tab, category, search, false, selectedId);
      setSettingsOpen(false);
      window.requestAnimationFrame(() =>
        window.scrollTo({ top: libraryScroll.current }),
      );
    } else selectCategory(next);
  };
  const checkStatus = useCallback(async () => {
    try {
      const next = await request<Status>("/api/status");
      setStatus(next);
      setStatusError("");
      setStatusCheckedAt(Date.now());
    } catch (cause) {
      setStatusError(message(cause));
      throw cause;
    }
  }, []);
  const forceRefresh = useCallback(
    async (target: RefreshTarget) => {
      await jsonRequest("/api/refresh", "POST", { target });
      await checkStatus();
    },
    [checkStatus],
  );
  const updateStatus = useCallback(() => {
    void request<Status>("/api/status")
      .then(setStatus)
      .catch(() => {});
  }, []);
  const requestPlayback = useCallback(
    (item: Item, title: Item) => {
      const knownTitle = [...liveItems, ...browseItems].find(
        (value) => value.id === title.id,
      );
      const categoryID =
        title.categoryId ||
        knownTitle?.categoryId ||
        (tab === title.kind && category !== "*" ? category : "");
      const titleCategory = categories.find(
        (value) => value.kind === title.kind && value.id === categoryID,
      );
      setPlayback({
        item,
        title: {
          ...title,
          categoryId: categoryID || undefined,
          category:
            titleCategory?.name || title.category || knownTitle?.category || "",
        },
      });
      setLivePlaybackRequested(item.kind === "live");
    },
    [liveItems, browseItems, categories, tab, category],
  );
  const closePlayer = useCallback(() => {
    if (playback?.title.id === selectedId) {
      setPlayback(null);
      setLivePlaybackRequested(false);
    }
    setSelected(null);
    setSelectedId("");
    setDetailError("");
    scrolledExpansion.current = "";
    writeLocation(tab, category, search, true);
    window.requestAnimationFrame(() => {
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLInputElement>(".header-search input");
      if (opener.current?.isConnected)
        opener.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
      target?.focus({ preventScroll: true });
    });
  }, [tab, category, search, playback?.title.id, selectedId]);
  const stopPlayback = () => {
    setPlayback(null);
    setLivePlaybackRequested(false);
    if (playback?.title.id === selectedId) closePlayer();
  };
  const playbackCategory =
    playback &&
    categories.find(
      (value) =>
        value.kind === playback.title.kind &&
        (playback.title.categoryId
          ? value.id === playback.title.categoryId
          : normalizeSearch(value.name) ===
            normalizeSearch(playback.title.category)),
    );
  const navigatePlayback = (destination: PlaybackDestination) => {
    if (!playback) return;
    const nextTab = playback.title.kind as Tab;
    const nextCategory =
      destination === "library" ? "*" : playbackCategory?.id || "*";
    selectCategory(nextTab, nextCategory);
    if (destination === "title" || destination === "season") {
      scrolledExpansion.current = "";
      setDetailError("");
      setSelected(playback.title);
      setSelectedId(playback.title.id);
      setPlaybackDetailsId(playback.title.id);
      const episodeTarget =
        playback.title.kind === "series"
          ? {
              titleId: playback.title.id,
              season: playback.item.season ?? 1,
              episodeId: playback.item.id,
            }
          : null;
      setEpisodeDestination(episodeTarget);
      writeLocation(
        nextTab,
        nextCategory,
        "",
        true,
        playback.title.id,
        false,
        episodeTarget,
      );
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };
  const sectionCategories = useMemo(
    () => categories.filter((value) => value.kind === tab),
    [categories, tab],
  );
  const visibleCategories = useMemo(() => {
    const terms = normalizeSearch(categorySearch).split(/\s+/).filter(Boolean);
    if (!terms.length) return sectionCategories;
    return sectionCategories.filter((value) => {
      const name = normalizeSearch(value.name);
      return terms.every((term) => name.includes(term));
    });
  }, [categorySearch, sectionCategories]);
  useEffect(() => {
    setCategorySearch("");
    setCategoryRailOpen(false);
  }, [tab]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      categoryRail.current
        ?.querySelector<HTMLElement>('[aria-current="page"]')
        ?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tab, category]);
  useEffect(() => {
    const target = loadSentinel;
    if (!target || browseLoading || browseError) return;
    const hasNext = tab === "live" ? items.length > visibleCount : hasMore;
    if (!hasNext) return;
    let active = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!active || !entry.isIntersecting) return;
        if (tab === "live")
          setVisibleCount((count) => Math.min(count + 72, items.length));
        else fetchPage(browsePage + 1, browseGeneration.current, 2);
      },
      { rootMargin: "900px 0px" },
    );
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [
    loadSentinel,
    browseError,
    browseLoading,
    browsePage,
    fetchPage,
    hasMore,
    items.length,
    selectedId,
    tab,
    visibleCount,
  ]);
  const openTitle = (item: Item, element?: HTMLButtonElement) => {
    if (selectedId === item.id) {
      if (element) closePlayer();
      else
        expandedArea.current?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      return;
    }
    if (element) opener.current = element;
    libraryScroll.current = window.scrollY;
    scrolledExpansion.current = "";
    searchPending.current = false;
    setDetailError("");
    setSelected(item);
    setPlaybackDetailsId("");
    setEpisodeDestination(null);
    setSelectedId(item.id);
    if (item.kind === "live" && livePlaybackRequested)
      requestPlayback(item, item);
    writeLocation(tab, category, search, false, item.id);
  };
  const selectedIndex = displayedItems.findIndex(
    (item) => item.id === selectedId,
  );
  const rowEnd =
    selectedIndex < 0
      ? -1
      : Math.min(
          displayedItems.length - 1,
          Math.ceil((selectedIndex + 1) / gridColumns) * gridColumns - 1,
        );
  const inlineDetails = (
    <AnimatePresence mode="wait" initial={false}>
      {selectedId && (
        <motion.section
          key={selectedId}
          ref={expandedArea}
          id="inline-title-details"
          className="inline-expansion"
          aria-label="Expanded title"
          style={{ order: rowEnd * 2 + 1 }}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          onAnimationComplete={() => {
            if (
              selectionRef.current !== selectedId ||
              scrolledExpansion.current === selectedId
            )
              return;
            scrolledExpansion.current = selectedId;
            expandedArea.current?.scrollIntoView({
              block: "nearest",
              behavior: "smooth",
            });
            const focusTarget =
              expandedArea.current?.querySelector<HTMLElement>(
                ".playback-area",
              ) || expandedArea.current?.querySelector<HTMLElement>("h1");
            focusTarget?.focus({ preventScroll: true });
          }}
        >
          {selected ? (
            <PlayerPage
              key={`${selected.kind}:${selected.id}`}
              item={selected}
              programs={epgByChannel.get(selected.id) || []}
              now={now}
              playback={playback}
              refreshRevision={status?.libraryUpdatedAt}
              showDetails={playbackDetailsId === selected.id}
              episodeDestination={
                episodeDestination?.titleId === selected.id
                  ? episodeDestination
                  : null
              }
              onPlay={requestPlayback}
            />
          ) : detailError ? (
            <div className="inline-detail-state" role="alert">
              <h2>Couldn’t open this title</h2>
              <p>{detailError}</p>
            </div>
          ) : (
            <div className="inline-detail-state inline-loading" role="status">
              <Spinner size="medium" className="app-spinner" />
              Opening title…
            </div>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
  return (
    <MotionConfig reducedMotion="user">
      <div className="app-shell">
        <GalaxyBackdrop active={!playback} />
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <header
          className={`site-header${settingsOpen ? " settings-header" : ""}`}
        >
          <div className="header-inner">
            <div className="brand">
              <BrandMark />
              <span className="brand-name">RESTREAM</span>
            </div>
            <LayoutGroup id="library-sections">
              <nav className="top-navigation" aria-label="Library">
                {sections.map((section) => {
                  const Icon = section.icon;
                  const active =
                    section.id === "settings"
                      ? settingsOpen
                      : !settingsOpen && tab === section.id;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={active ? "active" : ""}
                      aria-current={active ? "page" : undefined}
                      onClick={() => navigateSection(section.id)}
                    >
                      {active && (
                        <motion.span
                          className="top-navigation-indicator"
                          layoutId="active-library-section"
                          transition={{
                            type: "spring",
                            stiffness: 430,
                            damping: 34,
                          }}
                        />
                      )}
                      <Icon size={15} aria-hidden="true" />
                      <span>{section.label}</span>
                    </button>
                  );
                })}
              </nav>
            </LayoutGroup>
            {!settingsOpen && (
              <BeamSearch
                className="header-search"
                theme="dark"
                colorVariant="mono"
                value={search}
                ariaLabel={`Search ${tab === "live" ? "channels" : "titles"}`}
                placeholder={`Search ${tab === "live" ? "channels" : tab === "movie" ? "movies" : "series"}`}
                onChange={(value) => {
                  searchPending.current = true;
                  setSearch(value);
                  setVisibleCount(72);
                }}
              />
            )}
          </div>
        </header>
        <div className="player-dock" ref={setPlayerDock} />
        <AnimatePresence mode="wait" initial={false}>
          {playback && (
            <PlaybackPlayer
              key={`${playback.item.kind}:${playback.item.id}`}
              selection={playback}
              category={playbackCategory || null}
              onNavigate={navigatePlayback}
              onLivePlaybackChange={onLivePlaybackChange}
              onSessionChange={updateStatus}
              transitionRef={playbackTransition}
              playerDock={playerDock}
              onClose={stopPlayback}
            />
          )}
        </AnimatePresence>
        <div className="library-layout">
          <main id="main-content" className="main-content">
            {settingsOpen && (
              <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                <SettingsPage
                  status={status}
                  statusError={statusError}
                  checkedAt={statusCheckedAt}
                  onRefresh={forceRefresh}
                />
              </Suspense>
            )}
            <div hidden={settingsOpen} className="library-content">
              {loading ? (
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
                  <p>
                    Ask your administrator to finish setting up the library.
                  </p>
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
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={tab}
                    className="section-view"
                    initial={{ opacity: 0, y: 8, filter: "blur(3px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -5, filter: "blur(2px)" }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {status?.error && (
                      <div className="notice" role="alert">
                        {status.error}
                      </div>
                    )}
                    <div
                      className={`category-browser ${categoryRailOpen ? "open" : ""}`}
                    >
                      <div className="category-browser-toolbar">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="category-filter-toggle"
                          aria-expanded={categoryRailOpen}
                          aria-controls="category-filter-panel"
                          aria-label={
                            categoryRailOpen
                              ? "Close category filters"
                              : "Open category filters"
                          }
                          onClick={() => setCategoryRailOpen((open) => !open)}
                        >
                          <ListFilter aria-hidden="true" />
                        </Button>
                      </div>
                      <AnimatePresence initial={false}>
                        {categoryRailOpen && (
                          <motion.div
                            id="category-filter-panel"
                            className="category-filter-panel"
                            initial={{ height: 0, opacity: 0, y: -6 }}
                            animate={{ height: "auto", opacity: 1, y: 0 }}
                            exit={{ height: 0, opacity: 0, y: -6 }}
                            transition={{
                              duration: 0.28,
                              ease: [0.22, 1, 0.36, 1],
                            }}
                          >
                            <BeamSearch
                              autoFocus
                              className="category-beam-search"
                              theme="dark"
                              colorVariant="colorful"
                              value={categorySearch}
                              ariaLabel="Search categories"
                              placeholder="Search categories"
                              onChange={setCategorySearch}
                            />
                            <div className="category-rail-shell">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="category-scroll-button"
                                aria-label="Previous categories"
                                onClick={() =>
                                  categoryRail.current?.scrollBy({
                                    left: -320,
                                    behavior: "smooth",
                                  })
                                }
                              >
                                <ChevronLeft />
                              </Button>
                              <LayoutGroup id={`category-selector-${tab}`}>
                                <nav
                                  key={tab}
                                  ref={categoryRail}
                                  className="category-rail"
                                  aria-label={`${sections.find((value) => value.id === tab)?.label} categories`}
                                >
                                  <button
                                    type="button"
                                    className={category === "*" ? "active" : ""}
                                    aria-current={
                                      category === "*" ? "page" : undefined
                                    }
                                    onClick={() => selectCategory(tab)}
                                  >
                                    {category === "*" && (
                                      <motion.span
                                        className="category-selection-indicator"
                                        layoutId="active-category-selection"
                                        transition={{
                                          type: "spring",
                                          stiffness: 430,
                                          damping: 34,
                                        }}
                                      />
                                    )}
                                    <span>All</span>
                                  </button>
                                  {visibleCategories.map((value) => (
                                    <button
                                      key={value.id}
                                      type="button"
                                      className={
                                        category === value.id ? "active" : ""
                                      }
                                      aria-current={
                                        category === value.id
                                          ? "page"
                                          : undefined
                                      }
                                      onClick={() =>
                                        selectCategory(tab, value.id)
                                      }
                                    >
                                      {category === value.id && (
                                        <motion.span
                                          className="category-selection-indicator"
                                          layoutId="active-category-selection"
                                          transition={{
                                            type: "spring",
                                            stiffness: 430,
                                            damping: 34,
                                          }}
                                        />
                                      )}
                                      <span>{value.name}</span>
                                    </button>
                                  ))}
                                  {visibleCategories.length === 0 && (
                                    <span className="category-search-empty">
                                      No matching categories
                                    </span>
                                  )}
                                </nav>
                              </LayoutGroup>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="category-scroll-button"
                                aria-label="More categories"
                                onClick={() =>
                                  categoryRail.current?.scrollBy({
                                    left: 320,
                                    behavior: "smooth",
                                  })
                                }
                              >
                                <ChevronRight />
                              </Button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    {(items.length > 0 || selectedId) && (
                      <div
                        ref={setCatalogGrid}
                        className={
                          tab === "live"
                            ? "catalog-grid live-grid"
                            : "catalog-grid"
                        }
                      >
                        {displayedItems.map((item, index) => (
                          <button
                            type="button"
                            key={item.id}
                            className={`media-card ${selectedId === item.id ? "expanded" : ""}`}
                            style={{ order: index * 2 }}
                            aria-expanded={selectedId === item.id}
                            aria-controls={
                              selectedId === item.id
                                ? "inline-title-details"
                                : undefined
                            }
                            onClick={(event) => {
                              openTitle(item, event.currentTarget);
                            }}
                            title={
                              selectedId === item.id
                                ? `Close ${item.name}`
                                : undefined
                            }
                            aria-label={`Open ${item.name}`}
                          >
                            <div className="card-art">
                              <Artwork item={item} />
                              {tab === "live" && (
                                <span
                                  className="card-live-icon"
                                  title="Live channel"
                                >
                                  <Radio size={15} aria-hidden="true" />
                                  <span className="sr-only">Live channel</span>
                                </span>
                              )}
                              <span className="card-play" aria-hidden="true">
                                <Play size={13} fill="currentColor" />
                              </span>
                            </div>
                            <div className="card-content">
                              <div className="card-title-row">
                                <h3>{item.name}</h3>
                              </div>
                              {item.kind === "live" &&
                                currentPrograms.has(item.id) && (
                                  <p
                                    className="card-programme"
                                    aria-label={`On now: ${currentPrograms.get(item.id)?.title}`}
                                    title={currentPrograms.get(item.id)?.title}
                                  >
                                    <span
                                      className="on-air-dot"
                                      aria-hidden="true"
                                    />
                                    <span>
                                      {currentPrograms.get(item.id)?.title}
                                    </span>
                                  </p>
                                )}
                            </div>
                          </button>
                        ))}
                        {inlineDetails}
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
                    {browseLoading && items.length === 0 && (
                      <div className="page-status" role="status">
                        <Spinner size="small" className="app-spinner" /> Loading{" "}
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
                    {((tab === "live" && items.length > visibleCount) ||
                      (tab !== "live" && hasMore && !browseError)) && (
                      <div ref={setLoadSentinel} className="auto-loader">
                        {browseLoading && (
                          <span role="status">
                            <Spinner size="small" className="app-spinner" />{" "}
                            Loading more…
                          </span>
                        )}
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              )}
            </div>
          </main>
        </div>
        <nav className="mobile-bottom-nav" aria-label="Primary navigation">
          {sections.map((section) => {
            const Icon = section.icon;
            const active =
              section.id === "settings"
                ? settingsOpen
                : !settingsOpen && tab === section.id;
            return (
              <button
                key={section.id}
                type="button"
                className={active ? "active" : ""}
                aria-current={active ? "page" : undefined}
                onClick={() => navigateSection(section.id)}
              >
                <Icon size={20} />
                <span>{section.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </MotionConfig>
  );
}

function PlayerPage({
  item,
  programs,
  now,
  playback,
  refreshRevision,
  showDetails,
  episodeDestination,
  onPlay,
}: {
  item: Item;
  programs: Program[];
  now: number;
  playback: PlaybackSelection | null;
  refreshRevision?: string;
  showDetails: boolean;
  episodeDestination: EpisodeDestination | null;
  onPlay: (item: Item, title: Item) => void;
}) {
  const [episode, setEpisode] = useState<Item | null>(null);
  const [episodes, setEpisodes] = useState<Item[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(
    item.kind === "series",
  );
  const [episodesError, setEpisodesError] = useState("");
  const [episodeRetry, setEpisodeRetry] = useState(0);
  const [season, setSeason] = useState<number | null>(null);
  const episodeSelection = useRef({ season, episode });
  episodeSelection.current = { season, episode };
  const appliedDestination = useRef<EpisodeDestination | null>(null);
  const playRequested = playback?.title.id === item.id;
  const playingEpisode = playRequested ? playback?.item : null;
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
          const current = episodeSelection.current;
          const target =
            result.items.find((value) => value.id === current.episode?.id) ||
            result.items.find(
              (value) => (value.season ?? 1) === current.season,
            ) ||
            result.items[0];
          setSeason(target?.season ?? 1);
          setEpisode(target || null);
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
  }, [item, episodeRetry, refreshRevision]);

  useEffect(() => {
    if (
      !episodeDestination ||
      !episodes.length ||
      appliedDestination.current === episodeDestination
    )
      return;
    const target =
      episodes.find((value) => value.id === episodeDestination.episodeId) ||
      episodes.find(
        (value) => (value.season ?? 1) === episodeDestination.season,
      );
    if (target) {
      appliedDestination.current = episodeDestination;
      setSeason(target.season ?? 1);
      setEpisode(target);
    }
  }, [episodeDestination, episodes]);

  const seasons = [...new Set(episodes.map((value) => value.season ?? 1))].sort(
    (a, b) => a - b,
  );
  const shownEpisodes = episodes.filter(
    (value) => (value.season ?? 1) === season,
  );
  return (
    <article
      className={`title-page kind-${item.kind} ${playRequested ? "watching" : ""} ${showDetails ? "show-details" : ""}`}
    >
      <div className="title-hero">
        <div className="title-art">
          <Artwork item={item} />
        </div>
        <div className="title-information">
          <span className="eyebrow">
            {item.kind === "series"
              ? "SERIES"
              : item.kind === "live"
                ? "LIVE TV"
                : "MOVIE"}
          </span>
          <h1 tabIndex={-1}>{item.name}</h1>
          <p className="title-category">
            {item.category ||
              (item.kind === "live" ? "Live channel" : "Entertainment")}
            {item.number && ` · Channel ${item.number}`}
          </p>
          {item.description && (
            <p className="title-description">{item.description}</p>
          )}
          {item.kind === "series" && episode && (
            <p className="selected-episode">
              Selected · S{episode.season ?? 1} E{episode.episode ?? "—"} ·{" "}
              {episode.name}
            </p>
          )}
          <Button
            className="hero-play"
            disabled={item.kind === "series" && !episode}
            onClick={() => {
              const target = item.kind === "series" ? episode : item;
              if (target) onPlay(target, item);
            }}
          >
            <Play size={17} fill="currentColor" />{" "}
            {item.kind === "series" ? "Play episode" : "Play"}
          </Button>
        </div>
        {item.kind === "live" && (
          <section className="title-guide" aria-label="On this channel">
            <h2>On this channel</h2>
            <div
              className="channel-schedule"
              tabIndex={0}
              aria-label="Scroll channel schedule"
            >
              {programs.some((program) => Date.parse(program.end) > now) ? (
                <ol>
                  {programs
                    .filter((program) => Date.parse(program.end) > now)
                    .map((program) => {
                      const onAir = Date.parse(program.start) <= now;
                      return (
                        <li
                          key={`${program.start}:${program.title}`}
                          className={onAir ? "on-air" : ""}
                        >
                          <div className="schedule-time">
                            <time dateTime={program.start}>
                              {new Date(program.start).toLocaleDateString([], {
                                weekday: "short",
                              })}
                              {" · "}
                              {formatTime(program.start)} –{" "}
                              {formatTime(program.end)}
                            </time>
                            {onAir && (
                              <span className="schedule-on-air">
                                <Radio size={12} aria-hidden="true" /> On air
                              </span>
                            )}
                          </div>
                          <strong>{program.title}</strong>
                          {program.description && <p>{program.description}</p>}
                        </li>
                      );
                    })}
                </ol>
              ) : (
                <p className="epg-unavailable">
                  The provider hasn’t supplied an upcoming schedule for this
                  channel.
                </p>
              )}
            </div>
          </section>
        )}
      </div>
      {item.kind === "series" && (
        <div className="episode-browser">
          <div className="episode-heading">
            <h3>Episodes</h3>
            {seasons.length > 0 && (
              <Select
                value={String(season ?? "")}
                onValueChange={(value) => {
                  const nextSeason = Number(value);
                  setSeason(nextSeason);
                  setEpisode(
                    episodes.find(
                      (value) => (value.season ?? 1) === nextSeason,
                    ) || null,
                  );
                }}
              >
                <SelectTrigger className="season-trigger" aria-label="Season">
                  <SelectValue placeholder="Choose a season" />
                </SelectTrigger>
                <SelectContent className="season-menu" position="popper">
                  {seasons.map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      Season {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {episodesLoading ? (
            <p role="status" className="inline-loading">
              <Spinner size="small" className="app-spinner" />
              Loading episodes…
            </p>
          ) : episodesError ? (
            <div role="alert" className="inline-error episode-error">
              <span>{episodesError}</span>
              <Button onClick={() => setEpisodeRetry((value) => value + 1)}>
                Retry episodes
              </Button>
            </div>
          ) : shownEpisodes.length ? (
            <div className="episode-list">
              {shownEpisodes.map((value) => (
                <button
                  key={value.id}
                  className={
                    (playRequested ? playingEpisode?.id : episode?.id) ===
                    value.id
                      ? "episode-row selected"
                      : "episode-row"
                  }
                  onClick={() => {
                    setEpisode(value);
                    onPlay(value, item);
                  }}
                >
                  <span className="episode-number">
                    {value.episode ?? "▶"}
                  </span>
                  <span>
                    <strong>{value.name}</strong>
                    <small>{value.description || "Play episode"}</small>
                  </span>
                  <Play size={17} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <p className="episode-empty">No episodes are available.</p>
          )}
        </div>
      )}
    </article>
  );
}

function PlaybackPlayer({
  selection,
  category,
  onNavigate,
  onLivePlaybackChange,
  onSessionChange,
  transitionRef,
  playerDock,
  onClose,
}: {
  selection: PlaybackSelection;
  category: Category | null;
  onNavigate: (destination: PlaybackDestination) => void;
  onLivePlaybackChange: (active: boolean) => void;
  onSessionChange: () => void;
  transitionRef: RefObject<Promise<void>>;
  playerDock: HTMLDivElement | null;
  onClose: () => void;
}) {
  const isPresent = useIsPresent();
  const reducedMotion = useReducedMotion();
  const item = selection.title;
  const activeItem = selection.item;
  const playbackArea = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const sessionId = useRef<string | null>(null);
  const seekVersion = useRef(0);
  const seekingRef = useRef(false);
  const pendingPlayUrlRef = useRef<string | null>(null);
  const attachedUrlRef = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const clearMediaRef = useRef<(() => void) | null>(null);
  const videoPointer = useRef("mouse");
  const releasedRef = useRef(false);
  const releasePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const [playAttempt, setPlayAttempt] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const latestSession = useRef<Session | null>(null);
  latestSession.current = session;
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [position, setPosition] = useState(0);
  const [liveDelay, setLiveDelay] = useState<number | null>(null);
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>(
    [],
  );
  const [buffering, setBuffering] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [viewerFinished, setViewerFinished] = useState(false);
  const [playbackFeedback, setPlaybackFeedback] = useState<{
    id: number;
    action: "play" | "pause";
  } | null>(null);
  const feedbackSequence = useRef(0);
  useLayoutEffect(() => {
    if (isPresent) return;
    pendingPlayUrlRef.current = null;
    clearMediaRef.current?.();
  }, [isPresent]);
  useEffect(() => {
    if (!isPresent) return;
    let alive = true;
    let timer: number | undefined;
    let heartbeat: number | undefined;
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
      clearMediaRef.current?.();
      if (timer) clearTimeout(timer);
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
    pendingPlayUrlRef.current = null;
    setSession(null);
    setPlaybackUrl("");
    setError("");
    setPosition(0);
    setBuffered([]);
    setBuffering(true);
    setSeeking(false);
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
          const poll = () => {
            if (!alive || releasedRef.current) return;
            if (seekingRef.current) {
              timer = window.setTimeout(poll, 300);
              return;
            }
            const version = seekVersion.current;
            void request<Session>(
              `/api/sessions/${encodeURIComponent(value.id)}`,
            )
              .then((next) => {
                if (!alive || version !== seekVersion.current) return;
                setSession((current) =>
                  current &&
                  current.id === next.id &&
                  current.state === next.state &&
                  current.url === next.url &&
                  current.offset === next.offset &&
                  current.duration === next.duration &&
                  current.error === next.error
                    ? current
                    : next,
                );
                if (next.state === "failed") {
                  clearMediaRef.current?.();
                  setError(next.error || "This stream failed.");
                }
              })
              .catch((cause) => {
                if (alive) setError(message(cause));
              })
              .finally(() => {
                if (alive && !releasedRef.current)
                  timer = window.setTimeout(
                    poll,
                    latestSession.current?.state === "starting" ? 300 : 2000,
                  );
              });
          };
          timer = window.setTimeout(poll, 300);
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
  }, [activeItem?.id, playAttempt, onSessionChange, isPresent]);
  useEffect(() => {
    seekingRef.current = seeking;
  }, [seeking]);

  useEffect(() => {
    if (
      session?.url &&
      (session.state === "ready" || session.state === "ended")
    )
      setPlaybackUrl(session.url);
  }, [session?.url, session?.state]);

  useEffect(() => {
    const element = video.current;
    if (!element || !playbackUrl || !isPresent || viewerFinished) return;
    let disposed = false;
    let hls: Hls | undefined;
    const clearMedia = () => {
      if (disposed) return;
      disposed = true;
      attachedUrlRef.current = null;
      hlsRef.current = null;
      hls?.destroy();
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
    clearMediaRef.current = clearMedia;
    setPlaying(false);
    setBuffering(true);
    attachedUrlRef.current = playbackUrl;
    element.pause();
    element.removeAttribute("src");
    element.load();
    // Native HLS avoids a JS player and worker on browsers that support it.
    if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = playbackUrl;
    } else {
      void import("hls.js")
        .then(({ default: Hls }) => {
          // The player may close or switch sources while the chunk is loading.
          if (disposed) return;
          if (!Hls.isSupported()) {
            setError("This browser does not support HLS playback.");
            return;
          }
          hls = new Hls({
            enableWorker: true,
            // The ESM distribution requires an explicit worker URL.
            workerPath: hlsWorkerUrl,
            startPosition: activeItem.kind === "live" ? -1 : 0,
            maxBufferLength: 30,
            maxMaxBufferLength: 30,
            backBufferLength: 30,
            frontBufferFlushThreshold: 30,
            // VOD is an append-only event playlist; never jump to its live edge.
            liveSyncOnStallIncrease: activeItem.kind === "live" ? 1 : 0,
            liveSyncDuration: activeItem.kind === "live" ? undefined : 86400,
          });
          hlsRef.current = hls;
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              // HLS may still finish its error dispatch before releasing context.
              queueMicrotask(clearMedia);
              setBuffering(false);
              setError("Playback stopped. Please try this stream again.");
            }
          });
          hls.loadSource(playbackUrl);
          hls.attachMedia(element);
        })
        .catch(() => {
          if (!disposed) {
            setBuffering(false);
            setError("Playback could not load. Please try this stream again.");
          }
        });
    }
    return () => {
      clearMedia();
      if (clearMediaRef.current === clearMedia) clearMediaRef.current = null;
    };
  }, [playbackUrl, activeItem.kind, isPresent, viewerFinished]);

  // Use HLS's safe live sync point; native HLS exposes its window via seekable.
  const liveTarget = useCallback(() => {
    const element = video.current;
    if (!element || activeItem?.kind !== "live") return null;
    const sync = hlsRef.current?.liveSyncPosition;
    if (sync !== null && sync !== undefined && Number.isFinite(sync))
      return sync;
    const ranges = element.seekable;
    if (!ranges.length) return null;
    const last = ranges.length - 1;
    return Math.max(ranges.start(last), ranges.end(last) - 0.5);
  }, [activeItem?.kind]);

  useEffect(() => {
    const element = video.current;
    if (!element || !playbackUrl || activeItem?.kind !== "live") {
      setLiveDelay(null);
      return;
    }
    const update = () => {
      const target = liveTarget();
      setLiveDelay(
        target === null
          ? null
          : Math.max(0, Math.round(target - element.currentTime)),
      );
    };
    update();
    const timer = window.setInterval(update, 1000);
    element.addEventListener("timeupdate", update);
    element.addEventListener("progress", update);
    element.addEventListener("durationchange", update);
    return () => {
      clearInterval(timer);
      element.removeEventListener("timeupdate", update);
      element.removeEventListener("progress", update);
      element.removeEventListener("durationchange", update);
    };
  }, [playbackUrl, activeItem?.kind, liveTarget]);

  const goLive = async () => {
    const element = video.current;
    const target = liveTarget();
    if (!element || target === null) return;
    element.currentTime = target;
    setLiveDelay(0);
    try {
      await element.play();
      setError("");
    } catch {
      setError("Press play to resume live TV.");
    }
  };

  const seek = async (target: number, resume = false) => {
    const id = sessionId.current;
    if (!id || !session || seekingRef.current) return;
    if (!Number.isFinite(session.duration) || session.duration <= 0) return;
    const desired = Math.max(
      0,
      Math.min(Math.max(0, session.duration - 0.5), target),
    );
    const element = video.current;
    const local = desired - session.offset;
    const details = hlsRef.current?.levels[hlsRef.current.loadLevel]?.details;
    // Native EVENT playback can expose buffered media before seekable ranges.
    const windows = element ? [element.seekable, element.buffered] : [];
    const available =
      attachedUrlRef.current === session.url &&
      local >= 0 &&
      ((details && local < details.edge - 0.25) ||
        windows.some((ranges) =>
          Array.from({ length: ranges.length }, (_, i) => i).some(
            (i) => local >= ranges.start(i) && local < ranges.end(i) - 0.25,
          ),
        ));
    if (element && available) {
      element.currentTime = local;
      setPosition(desired);
      if (resume)
        void element.play().catch(() => setError("Press play to resume."));
      return;
    }
    seekVersion.current++;
    const resumeAfterSeek =
      resume || !!(video.current && !video.current.paused);
    pendingPlayUrlRef.current = null;
    video.current?.pause();
    hlsRef.current?.stopLoad();
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
      if (next.state === "failed")
        setError(next.error || "Could not seek in this video.");
    } catch (cause) {
      if (sessionId.current === id) {
        setError(message(cause));
        hlsRef.current?.startLoad();
        if (resumeAfterSeek) void video.current?.play().catch(() => {});
      }
      pendingPlayUrlRef.current = null;
    } finally {
      setSeeking(false);
      seekingRef.current = false;
    }
  };
  const togglePlay = async () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) {
      try {
        await element.play();
        if (!releasedRef.current && !element.paused)
          setPlaybackFeedback({
            id: ++feedbackSequence.current,
            action: "play",
          });
        setError("");
      } catch {
        setError("Playback could not start. Try pressing play again.");
      }
    } else {
      element.pause();
      setPlaybackFeedback({ id: ++feedbackSequence.current, action: "pause" });
    }
  };
  const enterFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (playbackArea.current?.requestFullscreen) {
        await playbackArea.current.requestFullscreen();
        return;
      }
      if (video.current?.requestFullscreen) {
        await video.current.requestFullscreen();
        return;
      }
      const mobileVideo = video.current as HTMLVideoElement & {
        webkitEnterFullscreen?: () => void;
      };
      mobileVideo?.webkitEnterFullscreen?.();
    } catch {
      setError("Full screen could not be opened.");
    }
  };
  const finishPlayback = () => {
    const id = sessionId.current;
    if (id && !releasedRef.current) {
      releasedRef.current = true;
      releasePromiseRef.current = releaseSession(id);
      sessionId.current = null;
      onSessionChange();
    }
    clearMediaRef.current?.();
    pendingPlayUrlRef.current = null;
    if (item.kind === "live") onLivePlaybackChange(false);
    setViewerFinished(true);
    setPlaying(false);
  };
  const vod = activeItem?.kind === "movie" || activeItem?.kind === "episode";
  const streamPreparing = session?.state === "starting";
  const absolutePosition = Math.min(session?.duration || 0, position);
  const breadcrumbLink = (destination: PlaybackDestination) => {
    const showTitle = destination === "title" || destination === "season";
    return {
      href: selectionURL(
        item.kind as Tab,
        destination === "library" ? "*" : category?.id || "*",
        "",
        showTitle ? item.id : "",
        false,
        showTitle && item.kind === "series"
          ? {
              titleId: item.id,
              season: activeItem.season ?? 1,
              episodeId: activeItem.id,
            }
          : null,
      ).toString(),
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onNavigate(destination);
      },
    };
  };

  return playerDock
    ? createPortal(
        <motion.section
          className="watch-section"
          aria-label="Player"
          inert={!isPresent}
          data-closing={!isPresent || undefined}
          initial={false}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{
            duration: reducedMotion ? 0 : 0.3,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <div className="dock-caption">
            <div className="dock-heading">
              <nav
                className="dock-breadcrumbs"
                aria-label="Playback breadcrumbs"
              >
                <ol>
                  <li>
                    <Button asChild variant="ghost" className="dock-crumb">
                      <a {...breadcrumbLink("library")}>
                        {item.kind === "live"
                          ? "Live TV"
                          : item.kind === "series"
                            ? "Series"
                            : "Movies"}
                      </a>
                    </Button>
                  </li>
                  {(category || item.category) && (
                    <li>
                      <ChevronRight aria-hidden="true" />
                      {category ? (
                        <Button asChild variant="ghost" className="dock-crumb">
                          <a {...breadcrumbLink("category")}>{category.name}</a>
                        </Button>
                      ) : (
                        <span className="dock-crumb-label">
                          {item.category}
                        </span>
                      )}
                    </li>
                  )}
                  {item.kind === "series" && (
                    <>
                      <li>
                        <ChevronRight aria-hidden="true" />
                        <Button
                          asChild
                          variant="ghost"
                          className="dock-crumb dock-series-crumb"
                          title={item.name}
                        >
                          <a {...breadcrumbLink("title")}>{item.name}</a>
                        </Button>
                      </li>
                      <li>
                        <ChevronRight aria-hidden="true" />
                        <Button asChild variant="ghost" className="dock-crumb">
                          <a {...breadcrumbLink("season")}>
                            Season {activeItem.season ?? 1}
                          </a>
                        </Button>
                      </li>
                    </>
                  )}
                </ol>
              </nav>
              <h2 className="dock-title" title={activeItem.name}>
                <a {...breadcrumbLink("title")} title="Open title details">
                  {activeItem.name}
                </a>
              </h2>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="dock-stop"
              onClick={onClose}
              aria-label="Stop playback"
              title="Close player"
            >
              <Square className="size-4" strokeWidth={1.5} aria-hidden="true" />
            </Button>
          </div>
          <div
            className="playback-area"
            ref={playbackArea}
            tabIndex={0}
            aria-label="Video player"
          >
            <div className="video-wrap">
              <video
                ref={video}
                playsInline
                controls={false}
                preload="auto"
                onPointerDown={(event) => {
                  videoPointer.current = event.pointerType;
                }}
                onClick={() => {
                  if (
                    videoPointer.current === "mouse" &&
                    !streamPreparing &&
                    !seeking
                  )
                    void togglePlay();
                }}
                onDoubleClick={() => {
                  if (videoPointer.current === "mouse") void enterFullscreen();
                }}
                onWaiting={() => setBuffering(true)}
                onPlaying={() => setBuffering(false)}
                onSeeked={() => setBuffering(false)}
                onProgress={(event) => {
                  const ranges = event.currentTarget.buffered;
                  if (attachedUrlRef.current === session?.url) {
                    const offset = session?.offset || 0;
                    setBuffered(
                      Array.from({ length: ranges.length }, (_, i) => ({
                        start: offset + ranges.start(i),
                        end: offset + ranges.end(i),
                      })),
                    );
                  }
                }}
                onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
                onPlay={() => {
                  setPlaying(true);
                }}
                onPause={() => setPlaying(false)}
                onCanPlay={() => {
                  setBuffering(false);
                  if (
                    isPresent &&
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
                onTimeUpdate={(event) => {
                  if (attachedUrlRef.current === session?.url)
                    setPosition(
                      (session?.offset || 0) + event.currentTarget.currentTime,
                    );
                }}
                onError={() => {
                  if (session?.state === "ready")
                    setError("The video could not be played.");
                }}
                aria-label={`${activeItem?.name} video`}
              />
              {isPresent && playbackFeedback && (
                <motion.div
                  key={playbackFeedback.id}
                  className="playback-feedback"
                  data-action={playbackFeedback.action}
                  aria-hidden="true"
                  initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.85 }}
                  animate={{
                    opacity: [0, 1, 1, 0],
                    scale: reducedMotion ? 1 : [0.85, 1, 1, 1.12],
                  }}
                  transition={{
                    duration: 0.55,
                    times: [0, 0.16, 0.45, 1],
                    ease: "easeOut",
                  }}
                  onAnimationComplete={() => {
                    setPlaybackFeedback((current) =>
                      current?.id === playbackFeedback.id ? null : current,
                    );
                  }}
                >
                  {playbackFeedback.action === "play" ? (
                    <Play strokeWidth={1.5} />
                  ) : (
                    <Pause strokeWidth={1.5} />
                  )}
                </motion.div>
              )}
              {(streamPreparing || seeking || buffering) &&
                !error &&
                !viewerFinished && (
                  <div className="playback-loading" role="status">
                    <Spinner size="large" className="app-spinner" />
                    <span className="sr-only">Loading playback</span>
                  </div>
                )}
              {viewerFinished && (
                <div className="video-overlay" role="status">
                  <div className="playback-ended">
                    <p>You’ve reached the end</p>
                    <Button
                      onClick={() => setPlayAttempt((value) => value + 1)}
                    >
                      <Play size={17} fill="currentColor" /> Play again
                    </Button>
                  </div>
                </div>
              )}
              <PlayerControls
                area={playbackArea}
                playing={playing}
                muted={muted}
                busy={streamPreparing || seeking || !playbackUrl}
                finished={viewerFinished}
                position={absolutePosition}
                duration={session?.duration || 0}
                buffered={buffered}
                live={!vod}
                liveDelay={liveDelay}
                onGoLive={() => void goLive()}
                onPlay={() => void togglePlay()}
                onSeek={(target) => void seek(target)}
                onMute={() => {
                  if (video.current) video.current.muted = !video.current.muted;
                }}
                onFullscreen={() => void enterFullscreen()}
              />
            </div>
            {error && (
              <div className="player-error" role="alert">
                <span>{error}</span>
                <Button onClick={() => setPlayAttempt((value) => value + 1)}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        </motion.section>,
        playerDock,
      )
    : null;
}

export default App;
