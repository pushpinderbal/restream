import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useAuth } from "./auth";
import { appScroller } from "./lib/app-scroll";
import type Hls from "hls.js";
import hlsWorkerUrl from "hls.js/dist/hls.worker.js?url";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { Radio, ChevronRight, Pause, Play, X } from "lucide-react";
import type { RefreshTarget } from "./components/settings-page";
import { PlayerControls } from "./components/player-controls";
import { useProviderSubtitles } from "./use-provider-subtitles";
import { useSubtitleAppearance } from "./subtitle-appearance";
import { AppNavigation } from "./components/app-navigation";
import { LibraryBrowser } from "./components/library-browser";
import { SearchPage } from "./components/search-page";
import { Button } from "./components/ui/button";
import { PlayButton } from "./components/ui/play-button";
import { Skeleton } from "./components/ui/skeleton";
import { Artwork } from "./components/artwork";
import { Dashboard } from "./components/dashboard";
import {
  MovieSuggestions,
  LiveChannelSuggestions,
} from "./components/watch-suggestions";
import { useWatchHistory, type WatchHistoryEntry } from "./watch-history";
import { createContentPolicy } from "./content-preferences";
import { Spinner } from "./components/spectrumui/spinner-dependencies";
import InfiniteScroll from "./components/spectrumui/infinite-scroll";
import { AnimatedAlert } from "./components/spectrumui/animated-alert";
import { LoadingButton } from "./components/spectrumui/loading-button";
import { UndoPill } from "./components/spectrumui/undo-pill";
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
  loadBrowsePage,
  waitForRefresh,
  releaseSession,
  request,
  type BrowsePage,
  type Category,
  type Item,
  type Program,
  type Session,
  type Status,
  type Preferences,
} from "./api";

const SettingsPage = lazy(() =>
  import("./components/settings-page").then((module) => ({
    default: module.SettingsPage,
  })),
);

function hasMediaSource() {
  return (
    "MediaSource" in window ||
    "ManagedMediaSource" in window ||
    "WebKitMediaSource" in window
  );
}

type Tab = "live" | "movie" | "series";
type PlaybackSelection = { item: Item; title: Item; start?: number };
type PlayerOrigin = { url: string; scroll: number; initialURL?: string };
function playerOriginFromHistory(): PlayerOrigin | null {
  const origin = window.history.state?.restreamPlayerOrigin;
  if (!origin || typeof origin.url !== "string") return null;
  try {
    if (
      new URL(origin.url, window.location.href).origin !==
      window.location.origin
    )
      return null;
    return {
      url: origin.url,
      initialURL:
        typeof origin.initialURL === "string" ? origin.initialURL : origin.url,
      scroll: Number.isFinite(origin.scroll) ? Math.max(0, origin.scroll) : 0,
    };
  } catch {
    return null;
  }
}
type EpisodeDestination = {
  titleId: string;
  season: number;
  episodeId: string;
};
type PlaybackDestination = "library" | "category" | "title" | "season";
function locationSelection(href = window.location.href) {
  const params = new URL(href, window.location.href).searchParams;
  const kind = params.get("section");
  const season = Number(params.get("season"));
  return {
    tab: (kind === "movie" || kind === "series" ? kind : "live") as Tab,
    category:
      params.get("view") === "search" ? "*" : params.get("category") || "*",
    search: params.get("search") || "",
    item: params.get("item") || "",
    settings: params.get("view") === "settings",
    searchView: params.get("view") === "search",
    dashboard:
      params.get("view") === "dashboard" ||
      (!params.has("view") &&
        !["section", "category", "search", "item"].some((key) =>
          params.has(key),
        )),
    player: params.get("view") === "player",
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
function browseSelectionForLocation() {
  const current = locationSelection();
  const origin = current.player ? playerOriginFromHistory() : null;
  return origin ? locationSelection(origin.url) : current;
}
function writeLocation(
  tab: Tab,
  category: string,
  search: string,
  replace = false,
  item = "",
  settings = false,
  episodeDestination: EpisodeDestination | null = null,
  dashboard = false,
  player = false,
  searchView = false,
) {
  window.history[replace ? "replaceState" : "pushState"](
    {},
    "",
    selectionURL(
      tab,
      category,
      search,
      item,
      settings,
      episodeDestination,
      dashboard,
      player,
      searchView,
    ),
  );
}
function selectionURL(
  tab: Tab,
  category: string,
  search: string,
  item = "",
  settings = false,
  episodeDestination: EpisodeDestination | null = null,
  dashboard = false,
  player = false,
  searchView = false,
) {
  const url = new URL(window.location.href);
  if (player) url.searchParams.set("view", "player");
  else if (settings) url.searchParams.set("view", "settings");
  else if (dashboard) url.searchParams.set("view", "dashboard");
  else if (searchView) url.searchParams.set("view", "search");
  else url.searchParams.delete("view");
  if (searchView && !item) url.searchParams.delete("section");
  else url.searchParams.set("section", tab);
  if (searchView || category === "*") url.searchParams.delete("category");
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
const noRoom = "All streaming slots are in use.";
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function displayTitle(item: Item) {
  const suffix = item.name.lastIndexOf(" - ");
  return suffix > 0 &&
    normalizeSearch(item.name.slice(suffix + 3)) ===
      normalizeSearch(item.category)
    ? item.name.slice(0, suffix)
    : item.name;
}
function durationLabel(seconds?: number) {
  if (!seconds || seconds <= 0) return "";
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}
function normalizeSearch(text: string) {
  return text
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\p{M}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function App() {
  const { canAdmin, user } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState("");
  const statusLoaded = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(
    () => locationSelection().settings,
  );
  const [dashboardOpen, setDashboardOpen] = useState(
    () => locationSelection().dashboard,
  );
  const [playerOpen, setPlayerOpen] = useState(
    () => locationSelection().player,
  );
  const [searchOpen, setSearchOpen] = useState(
    () => locationSelection().searchView,
  );
  const [playerError, setPlayerError] = useState("");
  const [playerRetry, setPlayerRetry] = useState(0);
  const [playerRetrying, setPlayerRetrying] = useState(false);
  const playerRetryMessage = useRef("");
  const playerOrigin = useRef<PlayerOrigin | null>(playerOriginFromHistory());
  const originScrollToRestore = useRef<number | null>(null);
  const playerOpenRef = useRef(playerOpen);
  playerOpenRef.current = playerOpen;
  const pendingPlayback = useRef<AbortController | null>(null);
  const navigationRevision = useRef(0);
  const cancelPlaybackIntent = useCallback(() => {
    originScrollToRestore.current = null;
    navigationRevision.current++;
    pendingPlayback.current?.abort();
    pendingPlayback.current = null;
    setPlayerRetrying(false);
  }, []);
  const watchHistory = useWatchHistory(user?.id);
  const historyEntries = useRef(watchHistory.entries);
  historyEntries.current = watchHistory.entries;
  const [liveItems, setLiveItems] = useState<Item[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [managedCategories, setManagedCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(() => browseSelectionForLocation().tab);
  const [category, setCategory] = useState(
    () => browseSelectionForLocation().category,
  );
  const [search, setSearch] = useState(
    () => browseSelectionForLocation().search,
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
  const [playback, setPlayback] = useState<PlaybackSelection | null>(null);
  const playingTitleRef = useRef(playback?.title.id);
  playingTitleRef.current = playback?.title.id;
  const [playbackDuration, setPlaybackDuration] = useState(0);
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
  const restoreOriginScroll = useCallback(() => {
    const top = originScrollToRestore.current;
    const area = expandedArea.current;
    // Search animates its returned details. Wait for their final height so the
    // browser can restore positions near the bottom without clamping the scroll.
    if (top === null || playerOpenRef.current || area?.style.height !== "auto")
      return false;
    originScrollToRestore.current = null;
    scrolledExpansion.current = selectionRef.current;
    appScroller().scrollTo({ top, behavior: "instant" });
    const target =
      area.querySelector<HTMLElement>(".play-action:not(:disabled)") ||
      area.querySelector<HTMLElement>("h1");
    target?.focus({ preventScroll: true });
    return true;
  }, []);
  const [catalogGrid, setCatalogGrid] = useState<HTMLDivElement | null>(null);
  const [gridColumns, setGridColumns] = useState(1);
  const libraryScroll = useRef(0);
  const browseAbort = useRef<AbortController | null>(null);
  const browseGeneration = useRef(0);
  const browseSnapshot = useRef<BrowsePage | null>(null);
  const [now, setNow] = useState(Date.now());
  const [visibleCount, setVisibleCount] = useState(72);
  const lastVodTab = useRef<"movie" | "series">(
    tab === "series" ? "series" : "movie",
  );
  useEffect(() => {
    if (tab !== "live") lastVodTab.current = tab;
  }, [tab]);
  const playerSource = (() => {
    const origin = playerOrigin.current;
    return origin ? locationSelection(origin.url) : locationSelection();
  })();
  const playerContext =
    playerSource.dashboard || playerSource.settings
      ? "dashboard"
      : playerSource.tab;
  const searchContext = searchOpen || (playerOpen && playerSource.searchView);
  const discoveryContext =
    dashboardOpen || (playerOpen && playerContext === "dashboard");
  const providerSetupRequired = status?.configured === false;
  const contentPolicy = useMemo(
    () => createContentPolicy(preferences, managedCategories),
    [preferences, managedCategories],
  );
  const visibleItem = contentPolicy.isVisible;
  const dashboardItem = contentPolicy.isDashboardAllowed;
  const visibleHistory = useMemo(
    () =>
      preferences
        ? watchHistory.entries.filter((entry) => visibleItem(entry.title))
        : [],
    [watchHistory.entries, preferences, visibleItem],
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      request<Preferences>("/api/preferences", { signal: controller.signal }),
      request<{ categories: Category[] }>(
        canAdmin ? "/api/categories?manage=1" : "/api/categories",
        {
          signal: controller.signal,
        },
      ),
    ])
      .then(([next, all]) => {
        if (controller.signal.aborted) return;
        setPreferences(next);
        setManagedCategories(all.categories || []);
      })
      .catch(() => {
        // Do not expose history before the server's category choices load.
      });
    return () => controller.abort();
  }, [status?.preferencesUpdatedAt, status?.catalogUpdatedAt, canAdmin]);
  useEffect(() => {
    if (
      !playback ||
      contentPolicy.categoryPreference(playback.title)?.visibility !== "block"
    )
      return;
    cancelPlaybackIntent();
    playerOpenRef.current = false;
    playerOrigin.current = null;
    setPlayback(null);
    setPlayerOpen(false);
    setSearchOpen(playerSource.searchView);
    setSelected(null);
    setSelectedId("");
    setEpisodeDestination(null);
    writeLocation(
      tab,
      category,
      search,
      true,
      "",
      false,
      null,
      false,
      false,
      playerSource.searchView,
    );
  }, [
    preferences,
    managedCategories,
    playback,
    tab,
    category,
    search,
    playerSource.searchView,
    cancelPlaybackIntent,
  ]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || !alive) return;
      clearTimeout(timer);
      checking = true;
      let nextDelay = 10000;
      try {
        const value = await request<Status>("/api/status", {
          signal: controller.signal,
        });
        if (alive) {
          setStatus(value);
          statusLoaded.current = true;
          setStatusError("");
          nextDelay = value.refreshing ? 2000 : settingsOpen ? 5000 : 10000;
          if (!value.configured) {
            setLoading(false);
            setError("");
          }
        }
      } catch (cause) {
        if (alive) {
          setStatusError(message(cause));
          if (!statusLoaded.current) {
            setError(message(cause));
            setLoading(false);
          }
        }
      } finally {
        checking = false;
        if (alive)
          timer = setTimeout(
            () => void check(),
            document.hidden ? 60000 : nextDelay,
          );
      }
    };
    const onVisibility = () => {
      if (!document.hidden) void check();
    };
    void check();
    document.addEventListener("visibilitychange", onVisibility);
    const clock = window.setInterval(() => setNow(Date.now()), 30000);
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [settingsOpen]);
  useEffect(() => {
    const restore = () => {
      cancelPlaybackIntent();
      const next = locationSelection();
      const browse = browseSelectionForLocation();
      const previousOrigin = playerOrigin.current;
      const returningToOrigin =
        previousOrigin &&
        new URL(previousOrigin.url, window.location.href).href ===
          window.location.href;
      if (!next.player && returningToOrigin && next.item && previousOrigin)
        originScrollToRestore.current = previousOrigin.scroll;
      playerOpenRef.current = next.player;
      playerOrigin.current = next.player ? playerOriginFromHistory() : null;

      setTab(browse.tab);
      setSettingsOpen(next.settings);
      setDashboardOpen(next.dashboard);
      setSearchOpen(next.searchView);
      setPlayerOpen(next.player);
      setPlayback(null);
      setPlayerError("");
      setCategory(browse.category);
      setSearch(browse.search);

      setSelectedId(next.item);
      setPlaybackDetailsId("");
      setEpisodeDestination(next.episodeDestination);
      setSelected((old) => (old?.id === next.item ? old : null));
      window.requestAnimationFrame(() =>
        appScroller().scrollTo({
          behavior: "instant",
          top: next.player
            ? 0
            : returningToOrigin && previousOrigin
              ? previousOrigin.scroll
              : libraryScroll.current,
        }),
      );
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [cancelPlaybackIntent]);
  useLayoutEffect(() => {
    if (!playerOpen) restoreOriginScroll();
  }, [playerOpen, selectedId, selected, restoreOriginScroll]);
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
        if (alive) {
          setDetailError(message(cause));
          setPlayerRetrying(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [selectedId, selected?.id, status?.configured, playerRetry]);
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
  }, [
    status?.configured,
    status?.catalogUpdatedAt,
    status?.epgUpdatedAt,
    status?.preferencesUpdatedAt,
  ]);
  const fetchPage = useCallback(
    (page: number, generation: number, refreshRange = false) => {
      if (tab === "live" || discoveryContext || searchContext || settingsOpen)
        return;
      browseAbort.current?.abort();
      const controller = new AbortController();
      browseAbort.current = controller;
      setBrowseLoading(true);
      const isCurrent = () =>
        !controller.signal.aborted && generation === browseGeneration.current;
      const params = new URLSearchParams({ kind: tab, category, search });
      void loadBrowsePage(
        params,
        page,
        browseSnapshot.current,
        controller.signal,
        (result) => {
          if (!isCurrent()) return;
          setBrowseError("");
          browseSnapshot.current = result;
          setBrowseItems(result.items);
          setBrowsePage(result.page);
          setHasMore(result.hasMore);
        },
        refreshRange,
      )
        .catch((cause) => {
          if (isCurrent()) setBrowseError(message(cause));
        })
        .finally(() => {
          if (isCurrent()) setBrowseLoading(false);
        });
    },
    [tab, category, search, discoveryContext, searchContext, settingsOpen],
  );
  useEffect(() => {
    browseGeneration.current++;
    browseAbort.current?.abort();
    browseSnapshot.current = null;
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
    search,
    status?.configured,
    fetchPage,
    status?.preferencesUpdatedAt,
  ]);

  const browseRevision = useRef(status?.libraryUpdatedAt);
  useEffect(() => {
    const previous = browseRevision.current;
    browseRevision.current = status?.libraryUpdatedAt;
    if (
      previous &&
      previous !== status?.libraryUpdatedAt &&
      browseSnapshot.current
    )
      fetchPage(1, browseGeneration.current, true);
  }, [status?.libraryUpdatedAt, fetchPage]);

  useEffect(() => {
    if (!catalogGrid) return;
    const measure = () => {
      if (!catalogGrid.clientWidth) return;
      setGridColumns(
        getComputedStyle(catalogGrid).gridTemplateColumns.split(" ").length ||
          1,
      );
    };
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
  const items = (tab === "live" ? filteredLive : browseItems).filter(
    visibleItem,
  );
  const shownItems = tab === "live" ? items.slice(0, visibleCount) : items;
  const catalogLoading =
    tab !== "live" && browseLoading && browseItems.length === 0;
  // Keep the selected tile available as its close control when search filters it out.
  const displayedItems =
    selected &&
    visibleItem(selected) &&
    !playerOpen &&
    !shownItems.some((item) => item.id === selected.id)
      ? [selected, ...shownItems]
      : shownItems;
  const epgByChannel = useMemo(() => {
    const grouped = new Map<string, Program[]>();
    for (const program of programs) {
      if (
        !program.title.trim() ||
        normalizeSearch(program.title) === "no information available"
      )
        continue;
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
  const selectCategory = (
    nextTab: Tab,
    nextCategory = "*",
    {
      replace = false,
      retainPlayback = false,
      searchView: nextSearchView = false,
      query: nextSearch = "",
    }: {
      replace?: boolean;
      retainPlayback?: boolean;
      searchView?: boolean;
      query?: string;
    } = {},
  ) => {
    if (
      retainPlayback &&
      playerOpen &&
      playback &&
      playerContext !== "dashboard"
    ) {
      cancelPlaybackIntent();

      setTab(nextTab);
      setCategory(nextCategory);
      setSearch(nextSearch);

      setVisibleCount(72);
      setSelected(playback.title);
      setSelectedId(playback.title.id);
      const origin = playerOrigin.current;
      if (origin)
        origin.url = selectionURL(
          nextTab,
          nextCategory,
          nextSearch.trim(),
          "",
          false,
          null,
          false,
          false,
          nextSearchView,
        ).href;
      window.history.replaceState(
        { restreamPlayerOrigin: origin },
        "",
        selectionURL(
          nextTab,
          nextCategory,
          nextSearch.trim(),
          playback.title.id,
          false,
          episodeDestination,
          false,
          true,
        ),
      );
      return;
    }
    cancelPlaybackIntent();
    playerOpenRef.current = false;
    setPlayback(null);
    setPlayerOpen(false);
    setPlayerError("");
    playerOrigin.current = null;
    setSettingsOpen(false);
    setDashboardOpen(false);
    setSearchOpen(nextSearchView);

    writeLocation(
      nextTab,
      nextCategory,
      nextSearch.trim(),
      replace,
      "",
      false,
      null,
      false,
      false,
      nextSearchView,
    );
    setTab(nextTab);
    setCategory(nextCategory);
    setSearch(nextSearch);

    setVisibleCount(72);
    setSelected(null);
    setSelectedId("");
    setPlaybackDetailsId("");
    setEpisodeDestination(null);
  };
  const navigateSection = (next: Tab | "dashboard" | "settings" | "search") => {
    if (next === "search" && searchOpen && !playerOpen) {
      document
        .querySelector<HTMLInputElement>('input[aria-label="Search library"]')
        ?.focus();
      return;
    }
    cancelPlaybackIntent();
    if (playerOpen) {
      playerOpenRef.current = false;
      setPlayback(null);
      setPlayerOpen(false);
      setPlayerError("");
    }
    if (next === "search") {
      const nextTab = dashboardOpen || settingsOpen ? lastVodTab.current : tab;
      selectCategory(nextTab, "*", { searchView: true });
      window.requestAnimationFrame(() =>
        document
          .querySelector<HTMLInputElement>('input[aria-label="Search library"]')
          ?.focus(),
      );
      appScroller().scrollTo({ top: 0 });
    } else if (next === "dashboard") {
      if (dashboardOpen) return;

      writeLocation(tab, category, search, false, "", false, null, true);
      setDashboardOpen(true);
      setSettingsOpen(false);
      setSearchOpen(false);
      setSelected(null);
      setSelectedId("");
      setPlaybackDetailsId("");
      setEpisodeDestination(null);
      setDetailError("");
      appScroller().scrollTo({ top: 0 });
    } else if (next === "settings") {
      if (settingsOpen) return;
      libraryScroll.current = appScroller().scrollTop;
      writeLocation(tab, category, search, false, selectedId, true);
      setSettingsOpen(true);
      setDashboardOpen(false);
      setSearchOpen(false);
      appScroller().scrollTo({ top: 0 });
    } else selectCategory(next);
  };
  const openDetails = (
    title: Item,
    episodeItem: Item | null = null,
    replace = false,
  ) => {
    const nextTab = title.kind as Tab;
    selectCategory(nextTab, "*", { replace });
    const episodeTarget =
      title.kind === "series" && episodeItem
        ? {
            titleId: title.id,
            season: episodeItem.season || 1,
            episodeId: episodeItem.id,
          }
        : null;
    opener.current = null;
    scrolledExpansion.current = "";
    setDetailError("");
    setSelected(title);
    setSelectedId(title.id);
    setEpisodeDestination(episodeTarget);
    writeLocation(nextTab, "*", "", true, title.id, false, episodeTarget);
  };
  const openHistory = (entry: WatchHistoryEntry, title: Item) =>
    openDetails(title, entry.item);
  const checkStatus = useCallback(async () => {
    try {
      const next = await request<Status>("/api/status");
      setStatus(next);
      setStatusError("");
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
    (item: Item, title: Item, start = 0) => {
      cancelPlaybackIntent();
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
      const playbackTitle = {
        ...title,
        categoryId: categoryID || undefined,
        category:
          titleCategory?.name || title.category || knownTitle?.category || "",
      };
      const episodeTarget =
        title.kind === "series"
          ? { titleId: title.id, season: item.season || 1, episodeId: item.id }
          : null;
      const alreadyOnPlayer = playerOpenRef.current;
      playerOpenRef.current = true;
      if (!alreadyOnPlayer) {
        const current = locationSelection();
        let url = window.location.href;
        if (
          !current.dashboard &&
          !current.settings &&
          current.item === title.id &&
          episodeTarget
        ) {
          url = selectionURL(
            current.tab,
            current.category,
            current.search,
            title.id,
            false,
            episodeTarget,
            false,
            false,
            current.searchView,
          ).href;
          window.history.replaceState(window.history.state, "", url);
        }
        playerOrigin.current = {
          url,
          initialURL: url,
          scroll: appScroller().scrollTop,
        };
      }
      const originSelection = playerOrigin.current
        ? locationSelection(playerOrigin.current.url)
        : locationSelection();
      const libraryOrigin =
        !originSelection.dashboard && !originSelection.settings;
      const browseTab = libraryOrigin
        ? originSelection.tab
        : (title.kind as Tab);
      const browseCategory = libraryOrigin
        ? originSelection.category
        : categoryID || "*";
      const browseSearch = libraryOrigin ? originSelection.search : "";
      window.history[alreadyOnPlayer ? "replaceState" : "pushState"](
        { restreamPlayerOrigin: playerOrigin.current },
        "",
        selectionURL(
          browseTab,
          browseCategory,
          browseSearch,
          title.id,
          false,
          episodeTarget,
          false,
          true,
        ),
      );

      setPlayerError("");
      setPlayerOpen(true);
      setDashboardOpen(false);
      setSettingsOpen(false);
      setSearchOpen(false);
      setTab(browseTab);
      setCategory(browseCategory);
      setSearch(browseSearch);

      setSelected(playbackTitle);
      setSelectedId(title.id);
      setEpisodeDestination(episodeTarget);
      setPlayback({
        item,
        start: item.kind === "live" ? 0 : Math.max(0, start),
        title: playbackTitle,
      });
      setPlaybackDuration(0);
    },
    [liveItems, browseItems, categories, tab, category, cancelPlaybackIntent],
  );
  const closePlayer = useCallback(() => {
    cancelPlaybackIntent();
    if (playerOpen && playback) {
      setSelected(playback.title);
      setSelectedId(playback.title.id);
      setDetailError("");
      opener.current?.focus({ preventScroll: true });
      return;
    }
    if (playback?.title.id === selectedId) {
      setPlayback(null);
    }
    setSelected(null);
    setSelectedId("");
    setDetailError("");
    scrolledExpansion.current = "";
    writeLocation(
      tab,
      category,
      search,
      true,
      "",
      false,
      null,
      false,
      false,
      searchContext,
    );
    window.requestAnimationFrame(() => {
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLInputElement>(
            'input[aria-label="Search library"]',
          ) ||
          document.querySelector<HTMLButtonElement>(".category-select-trigger");
      if (opener.current?.isConnected)
        opener.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
      target?.focus({ preventScroll: true });
    });
  }, [
    tab,
    category,
    search,
    playback?.title.id,
    selectedId,
    cancelPlaybackIntent,
    playerOpen,
    playback,
    searchContext,
  ]);
  const stopPlayback = () => {
    if (!playerOpenRef.current) return;
    cancelPlaybackIntent();
    playerOpenRef.current = false;
    const title = playback?.title || selected;
    const episode = playback?.item.kind === "episode" ? playback.item : null;
    const origin = playerOrigin.current;
    // Let route restoration close the player and reveal its origin together.
    // Closing it before asynchronous history.back() temporarily unmounts Search.
    if (origin && origin.initialURL && origin.url !== origin.initialURL) {
      window.history.replaceState({}, "", origin.url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } else if (origin && playerOriginFromHistory() && window.history.length > 1)
      window.history.back();
    else if (title) openDetails(title, episode, true);
    else selectCategory(tab, "*", { replace: true });
  };
  const verifyDashboardTitle = async (title: Item, signal?: AbortSignal) => {
    const { item } = await request<{ item: Item }>(
      `/api/items/${encodeURIComponent(title.id)}`,
      { signal },
    );
    if (item.kind !== title.kind || item.kind === "episode")
      throw new Error("This title is no longer available.");
    return item;
  };
  const dashboardEpisode = async (
    title: Item,
    wanted?: Pick<Item, "id" | "season" | "episode">,
    signal?: AbortSignal,
  ) => {
    const result = await request<{ items: Item[] }>(
      `/api/series/${encodeURIComponent(title.id)}/episodes?season=${wanted?.season || (wanted ? 1 : "first")}`,
      { signal },
    );
    const episodes = (result.items || [])
      .filter((item) => item.kind === "episode")
      .sort(
        (a, b) =>
          (a.season || 1) - (b.season || 1) ||
          (a.episode || 0) - (b.episode || 0),
      );
    const episode = wanted
      ? episodes.find((item) => item.id === wanted.id) ||
        episodes.find(
          (item) =>
            wanted.episode !== undefined &&
            item.episode === wanted.episode &&
            (item.season || 1) === (wanted.season || 1),
        )
      : episodes[0];
    if (!episode) throw new Error("This episode is no longer available.");
    return episode;
  };
  const startDashboardPlayback = async (
    title: Item,
    wanted?: Item,
    start = 0,
  ) => {
    cancelPlaybackIntent();
    const revision = navigationRevision.current;
    const controller = new AbortController();
    pendingPlayback.current = controller;
    try {
      const verified = await verifyDashboardTitle(title, controller.signal);
      const target =
        verified.kind === "series"
          ? await dashboardEpisode(verified, wanted, controller.signal)
          : verified;
      if (controller.signal.aborted || revision !== navigationRevision.current)
        return;
      requestPlayback(target, verified, start);
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      if (pendingPlayback.current === controller)
        pendingPlayback.current = null;
    }
  };
  const playDashboardTitle = (title: Item) => startDashboardPlayback(title);
  const openDashboardDetails = async (title: Item) => {
    cancelPlaybackIntent();
    const revision = navigationRevision.current;
    const controller = new AbortController();
    pendingPlayback.current = controller;
    try {
      const verified = await verifyDashboardTitle(title, controller.signal);
      if (!controller.signal.aborted && revision === navigationRevision.current)
        openDetails(verified);
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      if (pendingPlayback.current === controller)
        pendingPlayback.current = null;
    }
  };
  const resumeDashboardTitle = (entry: WatchHistoryEntry) =>
    startDashboardPlayback(
      entry.title,
      entry.item,
      entry.completed ? 0 : entry.position,
    );
  const playDashboardEpisode = (title: Item, episode: Item) =>
    startDashboardPlayback(title, episode);
  useEffect(() => {
    if (!playerOpen || playback || !selected || !status?.configured) return;
    const controller = new AbortController();
    setPlayerError("");
    void (async () => {
      try {
        if (
          selected.kind !== "live" &&
          selected.kind !== "movie" &&
          selected.kind !== "series"
        )
          throw new Error("Choose a channel, movie or show to watch.");
        const target =
          selected.kind === "series"
            ? await dashboardEpisode(
                selected,
                episodeDestination?.episodeId
                  ? {
                      id: episodeDestination.episodeId,
                      season: episodeDestination.season,
                    }
                  : undefined,
                controller.signal,
              )
            : selected;
        if (controller.signal.aborted) return;
        const saved = historyEntries.current.find(
          (entry) =>
            entry.title.id === selected.id && entry.item.id === target.id,
        );
        requestPlayback(
          target,
          selected,
          saved && !saved.completed ? saved.position : 0,
        );
      } catch (cause) {
        if (!controller.signal.aborted) {
          setPlayerError(message(cause));
          setPlayerRetrying(false);
        }
      }
    })();
    return () => controller.abort();
  }, [
    playerOpen,
    playback?.item.id,
    selected?.id,
    episodeDestination?.episodeId,
    episodeDestination?.season,
    status?.configured,
    playerRetry,
  ]);
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
      appScroller().scrollTo({ top: 0, behavior: "smooth" });
    }
  };
  const sectionCategories = useMemo(
    () => categories.filter((value) => value.kind === tab),
    [categories, tab],
  );
  const openTitle = (item: Item, element?: HTMLButtonElement) => {
    cancelPlaybackIntent();
    if (playerOpen && item.id === playback?.title.id) {
      document
        .querySelector(".player-page")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
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
    if (searchContext) setTab(item.kind as Tab);
    libraryScroll.current = appScroller().scrollTop;
    scrolledExpansion.current = "";

    setDetailError("");
    setSelected(item);
    setPlaybackDetailsId("");
    setEpisodeDestination(null);
    setSelectedId(item.id);
    if (!playerOpen)
      writeLocation(
        searchContext ? (item.kind as Tab) : tab,
        searchContext ? "*" : category,
        search,
        false,
        item.id,
        false,
        null,
        false,
        false,
        searchContext,
      );
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
  // Search mounts details with their result group, so its first mount must
  // animate for the reveal handler to bring the title controls into view.
  const inlineDetails = (
    <AnimatePresence mode="wait" initial={searchContext}>
      {selectedId &&
        (!selected || visibleItem(selected)) &&
        (!playerOpen || (!!playback && selectedId !== playback.title.id)) && (
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
                (playerOpenRef.current &&
                  playingTitleRef.current === selectedId) ||
                selectionRef.current !== selectedId
              )
                return;
              if (originScrollToRestore.current !== null) {
                // Motion restores height:auto after the completion callback.
                window.requestAnimationFrame(restoreOriginScroll);
                return;
              }
              if (scrolledExpansion.current === selectedId) return;
              scrolledExpansion.current = selectedId;
              expandedArea.current?.scrollIntoView({
                block: "start",
                behavior: "smooth",
              });
              const focusTarget =
                expandedArea.current?.querySelector<HTMLElement>(
                  ".playback-area",
                ) || expandedArea.current?.querySelector<HTMLElement>("h1");
              focusTarget?.focus({ preventScroll: true });
            }}
          >
            <Button
              variant="ghost"
              size="icon"
              className="inline-close"
              aria-label="Close title details"
              onClick={closePlayer}
            >
              <X size={18} aria-hidden="true" />
            </Button>
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
              <AnimatedAlert title="Couldn’t open this title">
                {detailError}
              </AnimatedAlert>
            ) : (
              <div
                className="inline-detail-state inline-loading"
                role="status"
                aria-label="Opening title"
              >
                <Spinner size="medium" className="app-spinner" />
              </div>
            )}
          </motion.section>
        )}
    </AnimatePresence>
  );
  const navigationContext = playerOpen
    ? playerContext
    : dashboardOpen
      ? "dashboard"
      : tab;
  const activeNavigation = settingsOpen
    ? "settings"
    : searchContext
      ? "search"
      : navigationContext === "dashboard"
        ? "home"
        : navigationContext === "live"
          ? "live"
          : "vod";
  return (
    <MotionConfig reducedMotion="user">
      <div
        className={`app-shell${dashboardOpen ? " dashboard-active" : ""}${playerOpen ? " player-active" : ""}`}
      >
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <AppNavigation
          active={activeNavigation}
          onNavigate={(destination) => {
            const next =
              destination === "home"
                ? "dashboard"
                : destination === "vod"
                  ? lastVodTab.current
                  : destination;
            navigateSection(next);
            appScroller().scrollTo({ top: 0 });
          }}
        />
        <div className="library-layout" id="app-scroll">
          <main id="main-content" className="main-content">
            {providerSetupRequired && !settingsOpen && (
              <AnimatedAlert variant="info" aria-label="Provider setup">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    {canAdmin
                      ? "Connect your provider to start watching."
                      : "Ask an administrator to connect your provider to start watching."}
                  </span>
                  {canAdmin && (
                    <Button
                      size="sm"
                      onClick={() => navigateSection("settings")}
                    >
                      Open settings
                    </Button>
                  )}
                </div>
              </AnimatedAlert>
            )}
            <section
              className="player-page"
              aria-label="Watch workspace"
              hidden={!playerOpen || providerSetupRequired}
            >
              <div className="watch-workspace-grid">
                <AnimatePresence mode="wait" initial={false}>
                  {playerOpen && playback && !providerSetupRequired && (
                    <PlaybackPlayer
                      key={`${playback.item.kind}:${playback.item.id}:${playback.start || 0}`}
                      selection={playback}
                      onSessionChange={updateStatus}
                      onPlaybackStarted={watchHistory.record}
                      onPlaybackProgress={watchHistory.updateProgress}
                      onFlushProgress={watchHistory.flushProgress}
                      transitionRef={playbackTransition}
                      onDurationResolved={setPlaybackDuration}
                    />
                  )}
                </AnimatePresence>
                {playerOpen && playback && !providerSetupRequired && (
                  <aside className="watch-sidebar" aria-label="Watch context">
                    <PlayerPage
                      key={`${playback.title.kind}:${playback.title.id}`}
                      compact
                      item={playback.title}
                      programs={epgByChannel.get(playback.title.id) || []}
                      now={now}
                      playback={playback}
                      refreshRevision={status?.libraryUpdatedAt}
                      showDetails={false}
                      episodeDestination={episodeDestination}
                      onPlay={requestPlayback}
                      onClose={stopPlayback}
                      onDetails={() => navigatePlayback("title")}
                      duration={playbackDuration}
                    />
                    {playback.title.kind === "movie" && (
                      <MovieSuggestions
                        item={playback.title}
                        refreshRevision={status?.libraryUpdatedAt}
                        onPlay={playDashboardTitle}
                        items={
                          playerContext === "dashboard" || searchContext
                            ? undefined
                            : items
                        }
                      />
                    )}
                    {playback.title.kind === "live" && (
                      <LiveChannelSuggestions
                        items={
                          playerContext === "dashboard" || searchContext
                            ? liveItems.filter(visibleItem)
                            : items
                        }
                        activeItem={playback.title}
                        currentPrograms={currentPrograms}
                        onPlay={(item) => requestPlayback(item, item)}
                      />
                    )}
                  </aside>
                )}
              </div>
              {playerOpen && !playback && !providerSetupRequired && (
                <div
                  className="player-page-state"
                  role={
                    playerError || detailError || playerRetrying
                      ? undefined
                      : "status"
                  }
                >
                  {playerError || detailError || playerRetrying ? (
                    <AnimatedAlert title="Couldn’t open the player">
                      <p>
                        {playerError ||
                          detailError ||
                          playerRetryMessage.current}
                      </p>
                      <LoadingButton
                        loading={playerRetrying}
                        loadingLabel="Retrying…"
                        onClick={() => {
                          playerRetryMessage.current =
                            playerError || detailError;
                          setPlayerRetrying(true);
                          setPlayerError("");
                          setDetailError("");
                          setPlayerRetry((value) => value + 1);
                        }}
                      >
                        Try again
                      </LoadingButton>
                    </AnimatedAlert>
                  ) : !selectedId ? (
                    <>
                      <h2>No title selected</h2>
                      <Button onClick={() => navigateSection("dashboard")}>
                        Open Home
                      </Button>
                    </>
                  ) : (
                    <>
                      <Spinner size="medium" className="app-spinner" />
                      <span className="sr-only">Opening player…</span>
                    </>
                  )}
                </div>
              )}
            </section>
            {discoveryContext && !providerSetupRequired && (
              <Dashboard
                key={status?.preferencesUpdatedAt || "default"}
                refreshRevision={status?.libraryUpdatedAt}
                playbackActive={playerOpen}
                entries={visibleHistory}
                persistent={watchHistory.persistent}
                configured={status?.configured !== false}
                liveItems={liveItems.filter(dashboardItem)}
                isDashboardAllowed={dashboardItem}
                programs={programs}
                now={now}
                onBrowse={(kind) => {
                  selectCategory(kind);
                  appScroller().scrollTo({ top: 0 });
                }}
                onOpen={openHistory}
                onResume={resumeDashboardTitle}
                onPlay={playDashboardTitle}
                onPlayEpisode={playDashboardEpisode}
                onOpenTitle={openDashboardDetails}
                onRemove={watchHistory.remove}
                onClear={watchHistory.clear}
              />
            )}
            {settingsOpen && (
              <Suspense
                fallback={
                  <div role="status" aria-label="Loading settings">
                    <Skeleton className="h-48 w-full" />
                  </div>
                }
              >
                <SettingsPage
                  status={status}
                  statusError={statusError}
                  onRefresh={forceRefresh}
                  onSaved={() => {
                    void request<Status>("/api/status")
                      .then(setStatus)
                      .catch(() => {});
                  }}
                />
              </Suspense>
            )}
            {searchContext && !providerSetupRequired && (
              <div hidden={playerOpen} className="search-page-container">
                <SearchPage
                  value={search}
                  onQueryChange={(value) => {
                    cancelPlaybackIntent();
                    setSearch(value);
                    setCategory("*");
                    setSelected(null);
                    setSelectedId("");
                    setPlaybackDetailsId("");
                    setEpisodeDestination(null);
                    setDetailError("");
                    scrolledExpansion.current = "";
                    opener.current = null;
                    writeLocation(
                      tab,
                      "*",
                      value.trim(),
                      true,
                      "",
                      false,
                      null,
                      false,
                      false,
                      true,
                    );
                  }}
                  enabled={status?.configured === true && preferences !== null}
                  liveItems={liveItems}
                  currentPrograms={currentPrograms}
                  refreshRevision={`${status?.libraryUpdatedAt || ""}:${status?.preferencesUpdatedAt || ""}`}
                  isVisible={visibleItem}
                  onOpen={openTitle}
                  selectedItem={selected}
                  selectedId={selectedId}
                  details={inlineDetails}
                  setCatalogGrid={setCatalogGrid}
                  gridColumns={gridColumns}
                />
              </div>
            )}
            {!searchContext && !providerSetupRequired && (
              <div
                hidden={settingsOpen || discoveryContext}
                className={`library-content${playerOpen ? " library-during-playback" : ""}${!searchContext && tab !== "live" && !playerOpen ? " library-vod" : ""}`}
              >
                <LibraryBrowser
                  mode={tab === "live" ? "live" : "vod"}
                  tab={tab}
                  categories={sectionCategories}
                  category={category}
                  playerActive={playerOpen}
                  onTabChange={(nextTab) => selectCategory(nextTab)}
                  onCategoryChange={(value) =>
                    selectCategory(tab, value, { retainPlayback: true })
                  }
                >
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
                  ) : error ? (
                    <AnimatedAlert title="Couldn’t load the library">
                      <p>{error}</p>
                      <LoadingButton onClick={() => window.location.reload()}>
                        Try again
                      </LoadingButton>
                    </AnimatedAlert>
                  ) : (
                    <>
                      {status?.error && (
                        <AnimatedAlert>{status.error}</AnimatedAlert>
                      )}
                      <div className="listing-summary">
                        <h2 className="current-listing-heading">
                          {search.trim()
                            ? `Results for “${search.trim()}”`
                            : sectionCategories.find(
                                (value) => value.id === category,
                              )?.name ||
                              `All ${tab === "movie" ? "movies" : tab === "series" ? "shows" : "channels"}`}
                        </h2>
                        <span>
                          {catalogLoading ? (
                            ""
                          ) : (
                            <>
                              {items.length}
                              {hasMore ? "+" : ""}{" "}
                              {tab === "live" ? "channel" : "title"}
                              {items.length === 1 && !hasMore ? "" : "s"}
                            </>
                          )}
                        </span>
                      </div>
                      {catalogLoading ? (
                        <div
                          className="catalog-grid catalog-skeleton"
                          role="status"
                          aria-label="Loading titles"
                        >
                          {Array.from({ length: 8 }, (_, index) => (
                            <div
                              className="catalog-skeleton-card"
                              key={index}
                              aria-hidden="true"
                            >
                              <Skeleton className="catalog-skeleton-poster" />
                              <Skeleton className="h-4 w-3/4 mt-3" />
                              <Skeleton className="h-3 w-1/2 mt-2" />
                            </div>
                          ))}
                        </div>
                      ) : (
                        (items.length > 0 || selectedId) && (
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
                                aria-expanded={
                                  selectedId === item.id &&
                                  (!playerOpen ||
                                    item.id !== playback?.title.id)
                                }
                                aria-current={
                                  playerOpen && item.id === playback?.title.id
                                    ? "true"
                                    : undefined
                                }
                                aria-controls={
                                  selectedId === item.id &&
                                  (!playerOpen ||
                                    item.id !== playback?.title.id)
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
                                      <span className="sr-only">
                                        Live channel
                                      </span>
                                    </span>
                                  )}
                                  <span
                                    className="card-play"
                                    aria-hidden="true"
                                  >
                                    <Play size={13} fill="currentColor" />
                                  </span>
                                </div>
                                <div className="card-content">
                                  <div className="card-title-row">
                                    <h3>{item.name}</h3>
                                  </div>
                                  {item.kind !== "live" && (
                                    <p className="card-metadata">
                                      <span>
                                        {item.category ||
                                          (item.kind === "series"
                                            ? "Show"
                                            : "Movie")}
                                      </span>
                                      {!!item.duration && (
                                        <span>
                                          {durationLabel(item.duration)}
                                        </span>
                                      )}
                                    </p>
                                  )}
                                  {item.kind === "live" &&
                                    currentPrograms.has(item.id) && (
                                      <p
                                        className="card-programme"
                                        aria-label={`On now: ${currentPrograms.get(item.id)?.title}`}
                                        title={
                                          currentPrograms.get(item.id)?.title
                                        }
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
                        )
                      )}
                      {!browseLoading &&
                        !browseError &&
                        !hasMore &&
                        items.length === 0 && (
                          <div className="empty-state" role="status">
                            <h3>
                              {search
                                ? "No matches found"
                                : tab === "live"
                                  ? "No channels yet"
                                  : "No titles in this category"}
                            </h3>
                            {(search.trim() || category !== "*") && (
                              <Button
                                variant="secondary"
                                onClick={() =>
                                  selectCategory(tab, "*", {
                                    retainPlayback: true,
                                    searchView: searchContext,
                                  })
                                }
                              >
                                Clear filters
                              </Button>
                            )}
                          </div>
                        )}
                      {browseError && (
                        <AnimatedAlert>
                          <span>{browseError}</span>
                          <LoadingButton
                            loading={browseLoading}
                            loadingLabel="Retrying…"
                            onClick={() =>
                              fetchPage(
                                browsePage + 1,
                                browseGeneration.current,
                              )
                            }
                          >
                            Retry page
                          </LoadingButton>
                        </AnimatedAlert>
                      )}
                      {(browseLoading ||
                        (tab === "live" && items.length > visibleCount) ||
                        (tab !== "live" && hasMore && !browseError)) && (
                        <InfiniteScroll
                          scrollRoot="#app-scroll"
                          isLoading={browseLoading}
                          hasMore={
                            !discoveryContext &&
                            !searchContext &&
                            !settingsOpen &&
                            !browseError &&
                            (tab === "live"
                              ? items.length > visibleCount
                              : hasMore)
                          }
                          next={() => {
                            if (tab === "live")
                              setVisibleCount((count) =>
                                Math.min(count + 72, items.length),
                              );
                            else
                              fetchPage(
                                browsePage + 1,
                                browseGeneration.current,
                              );
                          }}
                        >
                          <div className="auto-loader">
                            {browseLoading && (
                              <span role="status" aria-label="Loading">
                                <Spinner size="small" className="app-spinner" />
                              </span>
                            )}
                          </div>
                        </InfiniteScroll>
                      )}
                    </>
                  )}
                </LibraryBrowser>
              </div>
            )}
          </main>
        </div>
        <div className="discovery-history-undo">
          <UndoPill
            resetKey={watchHistory.pendingUndo?.id}
            open={watchHistory.pendingUndo !== null}
            label={watchHistory.pendingUndo?.label}
            duration={8}
            onUndo={watchHistory.undoRemoval}
            onExpire={watchHistory.dismissUndo}
          />
        </div>
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
  compact = false,
  onClose,
  onDetails,
  duration,
}: {
  item: Item;
  programs: Program[];
  now: number;
  playback: PlaybackSelection | null;
  refreshRevision?: string;
  showDetails: boolean;
  episodeDestination: EpisodeDestination | null;
  onPlay: (item: Item, title: Item) => void;
  compact?: boolean;
  onClose?: () => void;
  onDetails?: () => void;
  duration?: number;
}) {
  const [episode, setEpisode] = useState<Item | null>(null);
  const [episodes, setEpisodes] = useState<Item[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(
    item.kind === "series",
  );
  const [episodesError, setEpisodesError] = useState("");
  const [episodeRetry, setEpisodeRetry] = useState(0);
  const [season, setSeason] = useState<number | null>(null);
  const [requestedSeason, setRequestedSeason] = useState<number | null>(
    episodeDestination?.season ?? null,
  );
  const [seasonOptions, setSeasonOptions] = useState<number[]>([]);
  const episodeCache = useRef(
    new Map<string, { items: Item[]; seasons?: number[]; season?: number }>(),
  );
  const episodeSelection = useRef({ season, episode });
  episodeSelection.current = { season, episode };
  const appliedDestination = useRef<EpisodeDestination | null>(null);
  const playRequested = playback?.title.id === item.id;
  const playingEpisode = playRequested ? playback?.item : null;
  useEffect(() => {
    if (item.kind !== "series") return;
    const controller = new AbortController();
    setEpisodesLoading(true);
    const key = `${item.id}:${refreshRevision}:${requestedSeason ?? "first"}`;
    const apply = (result: {
      items: Item[];
      seasons?: number[];
      season?: number;
    }) => {
      if (!controller.signal.aborted) {
        setEpisodesError("");
        setEpisodes(result.items);
        setSeasonOptions(
          result.seasons ??
            [...new Set(result.items.map((value) => value.season ?? 1))].sort(
              (a, b) => a - b,
            ),
        );
        const current = episodeSelection.current;
        const target =
          result.items.find((value) => value.id === current.episode?.id) ||
          result.items.find(
            (value) => (value.season ?? 1) === current.season,
          ) ||
          result.items[0];
        setSeason(result.season ?? target?.season ?? requestedSeason ?? 1);
        setEpisode(target || null);
        setEpisodesLoading(false);
      }
    };
    const cached = episodeCache.current.get(key);
    if (cached) apply(cached);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    const load = async () => {
      if (loading || document.hidden || controller.signal.aborted) return;
      clearTimeout(timer);
      loading = true;
      try {
        const deadline = Date.now() + 180000;
        for (;;) {
          const result = await request<{
            items: Item[];
            seasons?: number[];
            season?: number;
            refreshing?: boolean;
            stale?: boolean;
            refreshAfterSeconds?: number;
          }>(
            `/api/series/${encodeURIComponent(item.id)}/episodes?season=${requestedSeason ?? "first"}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          episodeCache.current.set(key, result);
          if (result.season !== undefined)
            episodeCache.current.set(
              `${item.id}:${refreshRevision}:${result.season}`,
              result,
            );
          apply(result);
          if (!result.refreshing || Date.now() >= deadline) {
            const seconds = result.refreshAfterSeconds ?? 15 * 60;
            if (seconds > 0) {
              const delay = Math.max(result.stale ? 60 : 1, seconds);
              timer = setTimeout(() => void load(), delay * 1000);
            }
            return;
          }
          await waitForRefresh(controller.signal);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setEpisodesError(message(cause));
          setEpisodesLoading(false);
        }
      } finally {
        loading = false;
      }
    };
    const resume = () => {
      if (document.hidden) clearTimeout(timer);
      else void load();
    };
    void load();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [item.id, item.kind, episodeRetry, refreshRevision, requestedSeason]);

  useEffect(() => {
    if (episodeDestination) setRequestedSeason(episodeDestination.season);
  }, [episodeDestination]);

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

  const seasons = seasonOptions;
  const shownEpisodes = episodes.filter(
    (value) => (value.season ?? 1) === season,
  );
  return (
    <article
      className={`title-page kind-${item.kind} ${compact ? "watch-companion" : ""} ${playRequested ? "watching" : ""} ${showDetails ? "show-details" : ""}`}
    >
      <div className="title-hero">
        {(!compact || item.kind === "live") && (
          <div className="title-art">
            <Artwork item={item} />
          </div>
        )}
        <div className="title-information">
          {!compact && (
            <span className="eyebrow">
              {item.kind === "series"
                ? "SHOW"
                : item.kind === "live"
                  ? "LIVE TV"
                  : "MOVIE"}
            </span>
          )}
          {compact ? (
            <div className="watch-companion-heading">
              <h2 className="dock-title" tabIndex={-1}>
                {displayTitle(item)}
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="dock-stop"
                onClick={onClose}
                aria-label="Stop playback"
                title="Close player"
              >
                <X size={20} strokeWidth={1.5} aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <h1 tabIndex={-1}>{item.name}</h1>
          )}
          {!compact && (item.category || item.number) && (
            <p className="title-category">
              {[item.category, item.number && `Channel ${item.number}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {compact && item.kind !== "live" && (
            <p className="watch-media-meta">
              {item.kind === "series"
                ? `Season ${playingEpisode?.season ?? 1} · Episode ${playingEpisode?.episode ?? "—"}`
                : ["Movie", durationLabel(duration)]
                    .filter(Boolean)
                    .join(" · ")}
              <Button
                variant="link"
                size="xs"
                className="watch-details-link"
                onClick={onDetails}
              >
                Title details <ChevronRight size={14} aria-hidden="true" />
              </Button>
            </p>
          )}
          {item.description && (
            <p className="title-description">{item.description}</p>
          )}
          {!compact && item.kind === "series" && episode && (
            <p className="selected-episode">
              Selected · S{episode.season ?? 1} E{episode.episode ?? "—"} ·{" "}
              {episode.name}
            </p>
          )}
          {!compact && (
            <PlayButton
              className="hero-play"
              size="lg"
              disabled={item.kind === "series" && !episode}
              onClick={() => {
                const target = item.kind === "series" ? episode : item;
                if (target) onPlay(target, item);
              }}
            >
              Play
            </PlayButton>
          )}
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
                    .slice(0, compact ? 2 : undefined)
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
                          {compact && onAir && (
                            <div
                              className="schedule-progress"
                              aria-hidden="true"
                            >
                              <span
                                style={{
                                  width: `${Math.max(0, Math.min(100, ((now - Date.parse(program.start)) / (Date.parse(program.end) - Date.parse(program.start))) * 100))}%`,
                                }}
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                </ol>
              ) : (
                <p className="epg-unavailable">No programme guide</p>
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
                  setRequestedSeason(nextSeason);
                  setEpisode(
                    episodes.find(
                      (value) => (value.season ?? 1) === nextSeason,
                    ) || null,
                  );
                }}
              >
                <SelectTrigger
                  variant={compact ? "inline" : "default"}
                  className="season-trigger"
                  aria-label="Season"
                >
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
          {episodesLoading && !shownEpisodes.length && !episodesError ? (
            <div
              className="episode-list"
              role="status"
              aria-label="Loading episodes"
            >
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-19 w-full" />
              ))}
            </div>
          ) : episodesError && !shownEpisodes.length ? (
            <AnimatedAlert>
              <span>{episodesError}</span>
              <LoadingButton
                loading={episodesLoading}
                loadingLabel="Retrying…"
                onClick={() => setEpisodeRetry((value) => value + 1)}
              >
                Retry episodes
              </LoadingButton>
            </AnimatedAlert>
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
                  aria-label={`Play ${value.name}`}
                  aria-current={
                    compact && playingEpisode?.id === value.id
                      ? true
                      : undefined
                  }
                  disabled={compact && playingEpisode?.id === value.id}
                  onClick={() => {
                    setEpisode(value);
                    onPlay(value, item);
                  }}
                >
                  {compact && (value.image || item.image) ? (
                    <span className="watch-episode-art">
                      <Artwork
                        item={{ ...value, image: value.image || item.image }}
                      />
                      <span className="watch-episode-index">
                        {value.episode}
                      </span>
                    </span>
                  ) : (
                    <span className="episode-number">
                      {value.episode ?? "—"}
                    </span>
                  )}
                  <span className="episode-copy">
                    <strong>{value.name}</strong>
                    {value.description && <small>{value.description}</small>}
                  </span>
                  <Play size={17} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <p className="episode-empty">No episodes</p>
          )}
        </div>
      )}
    </article>
  );
}

function PlaybackPlayer({
  selection,
  onSessionChange,
  onPlaybackStarted,
  onPlaybackProgress,
  onFlushProgress,
  transitionRef,
  onDurationResolved,
}: {
  selection: PlaybackSelection;
  onSessionChange: () => void;
  onPlaybackStarted: (selection: PlaybackSelection) => void;
  onPlaybackProgress: (
    selection: PlaybackSelection,
    position: number,
    duration: number,
    completed?: boolean,
  ) => void;
  onFlushProgress: () => void;
  transitionRef: RefObject<Promise<void>>;
  onDurationResolved: (duration: number) => void;
}) {
  const isPresent = useIsPresent();
  const reducedMotion = useReducedMotion();
  const activeItem = selection.item;
  const historyRecorded = useRef(false);
  const historyFinished = useRef(false);
  const playbackArea = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  useLayoutEffect(() => {
    const area = playbackArea.current;
    if (!isPresent || !area) return;
    // Reveal the committed player before loading the stream. An instant scroll
    // also cancels any smooth title reveal left over from the browsing view.
    area.scrollIntoView({ block: "start", behavior: "instant" });
    area.focus({ preventScroll: true });
  }, [isPresent, selection]);
  const { style: subtitleStyle } = useSubtitleAppearance();
  const sessionId = useRef<string | null>(null);
  const seekVersion = useRef(0);
  const seekingRef = useRef(false);
  const pendingPlayUrlRef = useRef<string | null>(null);
  const pollSessionRef = useRef<(() => void) | null>(null);
  const attachedUrlRef = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const clearMediaRef = useRef<(() => void) | null>(null);
  const videoPointer = useRef("mouse");
  const releasedRef = useRef(false);
  const releasePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const [playAttempt, setPlayAttempt] = useState(0);
  const playbackStart = useRef(selection.start || 0);
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    if (
      activeItem.kind !== "live" &&
      (session?.state === "ready" || session?.state === "ended") &&
      Number.isFinite(session.duration) &&
      session.duration > 0
    )
      onDurationResolved(session.duration);
  }, [activeItem.kind, session?.state, session?.duration, onDurationResolved]);
  const latestSession = useRef<Session | null>(null);
  latestSession.current = session;
  const saveProgress = useCallback(
    (completed = false) => {
      const element = video.current;
      const current = latestSession.current;
      if (
        !historyRecorded.current ||
        (historyFinished.current && !completed) ||
        !element ||
        !current ||
        activeItem.kind === "live" ||
        attachedUrlRef.current !== current.url
      )
        return;
      onPlaybackProgress(
        selection,
        current.offset + element.currentTime,
        current.duration || activeItem.duration || 0,
        completed,
      );
    },
    [activeItem.kind, activeItem.duration, onPlaybackProgress, selection],
  );
  const saveProgressRef = useRef(saveProgress);
  saveProgressRef.current = saveProgress;
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const retryMessage = useRef("");
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
    saveProgressRef.current();
    onFlushProgress();
    pendingPlayUrlRef.current = null;
    clearMediaRef.current?.();
  }, [isPresent, onFlushProgress]);
  useEffect(() => {
    if (!isPresent) return;
    historyRecorded.current = false;
    historyFinished.current = false;
    let alive = true;
    let timer: number | undefined;
    let heartbeat: number | undefined;
    let pollBusy = false;
    let pollRequested = false;
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
      if (
        keepalive &&
        activeItem.kind !== "live" &&
        video.current &&
        latestSession.current &&
        attachedUrlRef.current === latestSession.current.url
      )
        playbackStart.current = historyFinished.current
          ? 0
          : latestSession.current.offset + video.current.currentTime;
      saveProgressRef.current();
      onFlushProgress();
      stopped = true;
      releaseKeepalive = keepalive;
      alive = false;
      pollSessionRef.current = null;
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
    // Download the decoder while the provider and FFmpeg prepare the stream.
    // Browsing alone does not load it; native-only browsers do not need it.
    if (hasMediaSource()) void import("hls.js").catch(() => {});
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
        start: playbackStart.current,
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
          setRetrying(false);
          sessionId.current = value.id;
          setSession(value);
          pendingPlayUrlRef.current = value.url;
          onSessionChange();
          if (value.state === "failed") {
            setError(value.error || "This stream is unavailable.");
            return;
          }
          const poll = () => {
            if (timer) clearTimeout(timer);
            if (!alive || releasedRef.current) return;
            if (seekingRef.current) {
              timer = window.setTimeout(poll, 300);
              return;
            }
            if (pollBusy) return;
            pollBusy = true;
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
                  current.playbackRate === next.playbackRate &&
                  current.subtitleOffset === next.subtitleOffset &&
                  current.duration === next.duration &&
                  JSON.stringify(current.subtitles) ===
                    JSON.stringify(next.subtitles) &&
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
                pollBusy = false;
                const delay = pollRequested
                  ? 0
                  : latestSession.current?.state === "starting"
                    ? 300
                    : 2000;
                pollRequested = false;
                if (alive && !releasedRef.current)
                  timer = window.setTimeout(poll, delay);
              });
          };
          pollSessionRef.current = () => {
            if (timer) clearTimeout(timer);
            if (pollBusy) pollRequested = true;
            else timer = window.setTimeout(poll, 0);
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
          if (alive) {
            setRetrying(false);
            setError(
              cause instanceof ApiError &&
                (cause.status === 409 || cause.code === "capacity")
                ? noRoom
                : message(cause),
            );
          } else finishTransition();
        });
    });
    const onPageHide = () => stop(true);
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPlayAttempt((value) => value + 1);
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      stop();
    };
  }, [
    activeItem?.id,
    selection.start,
    playAttempt,
    onSessionChange,
    onFlushProgress,
    isPresent,
  ]);
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
      element.removeEventListener("error", onMediaError);
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
    const rate = latestSession.current?.playbackRate ?? 1;
    element.pause();
    element.removeAttribute("src");
    element.load();
    element.defaultPlaybackRate = rate;
    element.playbackRate = rate;
    const startNative = () => {
      if (element.canPlayType("application/vnd.apple.mpegurl"))
        element.src = playbackUrl;
      else {
        setBuffering(false);
        setError("This browser does not support HLS playback.");
      }
    };
    const startHls = () => {
      void import("hls.js")
        .then(({ default: Hls }) => {
          // The player may close or switch sources while the chunk is loading.
          if (disposed) return;
          if (!Hls.isSupported()) {
            startNative();
            return;
          }
          hls = new Hls({
            enableWorker: true,
            // Inspect A53/CEA-608 data even when the upstream provider omitted
            // caption renditions. The subtitle picker manages native tracks.
            enableCEA708Captions: true,
            renderTextTracksNatively: true,
            // The ESM distribution requires an explicit worker URL.
            workerPath: hlsWorkerUrl,
            startPosition: activeItem.kind === "live" ? -1 : 0,
            // Keep 30 seconds of viewing time, including at faster speeds.
            maxBufferLength: 30 * rate,
            maxMaxBufferLength: 30 * rate,
            backBufferLength: 30 * rate,
            frontBufferFlushThreshold: 30 * rate,
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
    };
    const onMediaError = () => {
      // HLS.js owns its error recovery; native-only playback has no decoder.
      if (disposed || hls) return;
      queueMicrotask(clearMedia);
      setBuffering(false);
      setError("The video could not be played.");
    };
    element.addEventListener("error", onMediaError);
    // Prefer HLS.js. Native support claims do not guarantee stream compatibility.
    if (hasMediaSource()) startHls();
    else startNative();
    return () => {
      clearMedia();
      if (clearMediaRef.current === clearMedia) clearMediaRef.current = null;
    };
  }, [playbackUrl, activeItem.kind, isPresent, viewerFinished]);

  const subtitles = useProviderSubtitles(
    video,
    session,
    isPresent && !viewerFinished && !seeking && playbackUrl === session?.url,
  );

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

  const seek = async (target: number, resume = false, rate?: number) => {
    saveProgress();
    onFlushProgress();
    const id = sessionId.current;
    if (!id || !session || seekingRef.current) return;
    const hasDuration =
      Number.isFinite(session.duration) && session.duration > 0;
    if (!Number.isFinite(target) || (!hasDuration && rate === undefined))
      return;
    const desired = Math.max(
      0,
      hasDuration
        ? Math.min(Math.max(0, session.duration - 0.5), target)
        : target,
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
    if (element && available && rate === undefined) {
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
        `/api/sessions/${encodeURIComponent(id)}/${rate === undefined ? "seek" : "speed"}`,
        "POST",
        { position: desired, ...(rate === undefined ? {} : { rate }) },
      );
      if (sessionId.current !== id) return;
      pendingPlayUrlRef.current = resumeAfterSeek ? next.url : null;
      setSession(next);
      setPosition(next.offset);
      setBuffered([]);
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
      if (sessionId.current === id) pollSessionRef.current?.();
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
      pendingPlayUrlRef.current = null;
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
    saveProgress(true);
    historyFinished.current = true;
    onFlushProgress();
    const id = sessionId.current;
    if (id && !releasedRef.current) {
      releasedRef.current = true;
      releasePromiseRef.current = releaseSession(id);
      sessionId.current = null;
      onSessionChange();
    }
    clearMediaRef.current?.();
    pendingPlayUrlRef.current = null;
    setViewerFinished(true);
    setPlaying(false);
  };
  const vod = activeItem?.kind === "movie" || activeItem?.kind === "episode";
  const streamPreparing = session?.state === "starting";
  const absolutePosition = Math.min(session?.duration || 0, position);

  return (
    <motion.section
      className="watch-section"
      aria-label="Player"
      inert={!isPresent}
      data-closing={!isPresent || undefined}
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{
        duration: reducedMotion ? 0 : 0.3,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      <div
        className="playback-area"
        ref={playbackArea}
        tabIndex={0}
        aria-label="Video player"
      >
        <div className="video-wrap" style={subtitleStyle}>
          <video
            ref={video}
            playsInline
            controls={false}
            preload="auto"
            onLoadedMetadata={(event) => {
              const rate = latestSession.current?.playbackRate ?? 1;
              event.currentTarget.defaultPlaybackRate = rate;
              event.currentTarget.playbackRate = rate;
            }}
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
            onPlaying={() => {
              setBuffering(false);
              if (isPresent && !historyRecorded.current) {
                historyRecorded.current = true;
                onPlaybackStarted(selection);
              }
            }}
            onSeeked={() => {
              setBuffering(false);
              saveProgress();
              onFlushProgress();
            }}
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
            onPause={() => {
              setPlaying(false);
              saveProgress();
              onFlushProgress();
            }}
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
              saveProgress();
              if (attachedUrlRef.current === session?.url)
                setPosition(
                  (session?.offset || 0) + event.currentTarget.currentTime,
                );
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
                <p>Playback ended</p>
                <PlayButton
                  onClick={() => {
                    playbackStart.current = 0;
                    setPlayAttempt((value) => value + 1);
                  }}
                >
                  Play again
                </PlayButton>
              </div>
            </div>
          )}
          <PlayerControls
            subtitles={subtitles}
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
            playbackRate={session?.playbackRate ?? 1}
            onPlaybackRate={(rate) => {
              const current = latestSession.current;
              if (
                current &&
                video.current &&
                rate !== (current.playbackRate ?? 1)
              )
                void seek(
                  current.offset + video.current.currentTime,
                  false,
                  rate,
                );
            }}
            onGoLive={() => void goLive()}
            onPlay={() => void togglePlay()}
            onSeek={(target) => void seek(target)}
            onMute={() => {
              if (video.current) video.current.muted = !video.current.muted;
            }}
            onFullscreen={() => void enterFullscreen()}
          />
        </div>
        {(error || retrying) && (
          <AnimatedAlert className="mt-3">
            <span>{error || retryMessage.current}</span>
            <LoadingButton
              loading={retrying}
              loadingLabel="Retrying…"
              onClick={() => {
                retryMessage.current = error;
                setRetrying(true);
                setPlayAttempt((value) => value + 1);
              }}
            >
              Try again
            </LoadingButton>
          </AnimatedAlert>
        )}
      </div>
    </motion.section>
  );
}

export default App;
