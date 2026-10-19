type Kind = "live" | "movie" | "series" | "episode";
export type Category = {
  id: string;
  name: string;
  kind: "live" | "movie" | "series";
};
type CategoryVisibility = "show" | "block";
export type CategoryPreference = {
  kind: Category["kind"];
  id: string;
  visibility: CategoryVisibility;
  dashboard: boolean;
};
export type Preferences = {
  refreshIntervalSeconds: number;
  categories: CategoryPreference[];
  configuration?: {
    dashboardCategories: string[];
    blockedCategories: string[];
  };
};
export type AppSettings = {
  providerEnvironment: (keyof AppSettings["provider"])[];
  provider: {
    portalUrl: string;
    mac: string;
    timezone: string;
    serialNumber: string;
    deviceId: string;
    deviceId2: string;
  };
  library: {
    refreshIntervalSeconds: number;
    dashboardCategories: string[];
    blockedCategories: string[];
    guideHours: number;
  };
  discovery: { tmdbTokenConfigured: boolean };
  playback: {
    maxStreams: number;
    transcodeMode: "auto" | "copy" | "transcode";
  };
  updatedAt: string;
};
export type SettingsUpdate = {
  provider?: Partial<AppSettings["provider"]>;
  library?: Partial<AppSettings["library"]>;
  discovery?: { tmdbReadAccessToken?: string };
  playback?: Partial<AppSettings["playback"]>;
};
export const getSettings = (signal?: AbortSignal) =>
  request<AppSettings>("/api/settings", { signal });
export const updateSettings = (settings: SettingsUpdate) =>
  jsonRequest<AppSettings>("/api/settings", "PATCH", settings);

export type BrowsePage = {
  items: Item[];
  page: number;
  total: number;
  hasMore: boolean;
  revision?: number;
  stale?: boolean;
  refreshing?: boolean;
};
export type DiscoveryTitle = {
  tmdbId?: number;
  item: Item;
  name: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  releaseDate?: string;
  year?: number;
  rating?: number;
  genres?: string[];
};
export type Discovery = {
  configured: boolean;
  refreshing: boolean;
  updatedAt?: string;
  error?: string;
  trendingMovies: DiscoveryTitle[];
  trendingSeries: DiscoveryTitle[];
  exploreMovies: DiscoveryTitle[];
  exploreSeries: DiscoveryTitle[];
};
export type Item = {
  id: string;
  kind: Kind;
  name: string;
  category: string;
  categoryId?: string;
  image?: string;
  number?: string;
  description?: string;
  duration?: number;
  season?: number;
  episode?: number;
};
export type Program = {
  channelId: string;
  title: string;
  description?: string;
  start: string;
  end: string;
};
export type Status = {
  preferencesUpdatedAt?: string;
  libraryUpdatedAt?: string;
  configured: boolean;
  refreshing: boolean;
  catalogUpdatedAt?: string;
  catalogRefreshCompletedAt?: string;
  epgUpdatedAt?: string;
  error?: string;
  activeStreams?: number;
  maxStreams?: number;
  sync?: { catalog: RefreshState; epg: RefreshState; discovery?: RefreshState };
  portalCooldownUntil?: string;
  timezone?: string;
  guideHours?: number;
  library?: {
    liveChannels: number;
    categories: number;
    cachedMovies: number;
    cachedSeries: number;
    programmes: number;
    guideStartsAt?: string;
    guideEndsAt?: string;
  };
  playback?: { transcodeMode: string; sessionTimeoutSeconds: number };
};
export type RefreshState = {
  queued: boolean;
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  nextRefreshAt?: string;
  lastSuccessfulAt?: string;
  intervalSeconds: number;
  error?: string;
  paused?: boolean;
  failures?: number;
};
export type Session = {
  id: string;
  url: string;
  state: "starting" | "ready" | "ended" | "failed";
  duration: number;
  offset: number;
  error?: string;
  subtitles?: SubtitleTrack[];
  subtitleOffset?: number;
};

export type SubtitleTrack = {
  id: string;
  label: string;
  language?: string;
  url: string;
  default?: boolean;
  forced?: boolean;
  source?: "embedded";
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    if (
      path !== "/api/auth" &&
      (response.status === 401 ||
        (response.status === 403 && body?.code === "forbidden"))
    )
      window.dispatchEvent(
        new CustomEvent("restream:auth-changed", { detail: response.status }),
      );
    throw new ApiError(
      body?.error || `Request failed (${response.status})`,
      response.status,
      body?.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const jsonRequest = <T>(path: string, method: string, data: unknown) =>
  request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

export function releaseSession(id: string, keepalive = false) {
  return fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    keepalive,
  })
    .then(() => {})
    .catch(() => {});
}

// Poll only work the server has already started; navigation aborts both fetches
// and waits. A stalled provider must not leave an open view polling forever.
export function waitForRefresh(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function distinctItems(items: Item[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export async function loadBrowsePage(
  params: URLSearchParams,
  page: number,
  previous: BrowsePage | null,
  signal: AbortSignal,
  apply: (result: BrowsePage) => void,
  refreshRange = false,
) {
  const deadline = Date.now() + 180000;
  let through = refreshRange ? previous?.page || 0 : 0;
  for (;;) {
    let result: BrowsePage;
    if (through) {
      const chunks: BrowsePage[] = [];
      // The API bounds each range to 100 raw pages. Keep larger loaded views
      // intact and publish only when every chunk has the same revision.
      for (let start = 1; start <= through; start += 100) {
        params.set("page", String(start));
        params.set("through", String(Math.min(start + 99, through)));
        const chunk = await request<BrowsePage>(`/api/browse?${params}`, {
          signal,
        });
        chunks.push(chunk);
        if (!chunk.hasMore) break;
      }
      const changed = new Set(chunks.map((chunk) => chunk.revision)).size > 1;
      result = {
        ...chunks[chunks.length - 1],
        items: distinctItems(chunks.flatMap((chunk) => chunk.items)),
        stale: changed || chunks.some((chunk) => chunk.stale),
        refreshing: changed || chunks.some((chunk) => chunk.refreshing),
      };
    } else {
      params.set("page", String(page));
      result = await request<BrowsePage>(`/api/browse?${params}`, { signal });
    }
    if (signal.aborted) return;
    if (
      !through &&
      previous &&
      page > 1 &&
      (result.stale ||
        result.refreshing ||
        result.revision !== previous.revision)
    ) {
      // A changed earlier page can shift every following page. Ask for one
      // coherent range, keeping the displayed range until it is ready.
      through = Math.max(previous.page, page);
      continue;
    }
    if (through) {
      if (!result.stale && !result.refreshing) apply(result);
      else if (!result.refreshing)
        throw new Error("This listing could not be refreshed. Please retry.");
    } else {
      const items =
        page === 1
          ? result.items
          : distinctItems([...(previous?.items || []), ...result.items]);
      apply({ ...result, items });
    }
    if (!result.refreshing) return;
    if (Date.now() >= deadline)
      throw new Error("Refresh is taking longer than expected. Please retry.");
    await waitForRefresh(signal);
  }
}
