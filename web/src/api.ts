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
  retryStopped?: boolean;
  refreshError?: string;
  refreshAfterSeconds?: number;
  // The last requested range is retained locally for a targeted manual reset.
  retryPage?: number;
  retryThrough?: number;
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
  playbackRate?: number;
  error?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
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
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}

function retryAfterMilliseconds(value: string | null) {
  if (!value) return 0;
  const seconds = Number(value);
  return (
    Math.max(
      0,
      Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(value) - Date.now(),
    ) || 0
  );
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Send mutations once; each read and write has a finite, cancellable deadline.
  const signal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  const response = await fetch(path, { ...init, signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    if (
      path !== "/api/auth" &&
      ((response.status === 401 && body?.code === "unauthorized") ||
        (response.status === 403 && body?.code === "forbidden"))
    )
      window.dispatchEvent(
        new CustomEvent("restream:auth-changed", { detail: response.status }),
      );
    throw new ApiError(
      body?.error || `Request failed (${response.status})`,
      response.status,
      body?.code,
      retryAfterMilliseconds(response.headers.get("Retry-After")),
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
    signal: AbortSignal.timeout(10000),
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
  retry = false,
) {
  const deadline = Date.now() + 180000;
  signal = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
  if (retry) {
    await request<void>("/api/browse/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: params.get("kind"),
        category: params.get("category"),
        search: params.get("search"),
        page: previous?.retryPage || page,
        ...(previous?.retryThrough ? { through: previous.retryThrough } : {}),
      }),
      signal,
    });
    if (previous?.retryThrough) refreshRange = true;
  }
  let through = refreshRange ? Math.max(previous?.page || 0, page) : 0;
  let attempts = 0;
  const checkBudget = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline || attempts++ >= 60)
      throw new Error("Refresh is taking longer than expected. Please retry.");
  };
  for (;;) {
    checkBudget();
    let result: BrowsePage;
    if (through) {
      const chunks: BrowsePage[] = [];
      // The API bounds each range to 100 raw pages. Keep larger loaded views
      // intact and publish only when every chunk has the same revision.
      for (let start = 1; start <= through; start += 100) {
        if (start > 1) checkBudget();
        params.set("page", String(start));
        params.set("through", String(Math.min(start + 99, through)));
        if (previous) {
          previous.retryPage = start;
          previous.retryThrough = Math.min(start + 99, through);
        }
        const chunk = await request<BrowsePage>(`/api/browse?${params}`, {
          signal,
        });
        if (
          chunk.retryStopped ||
          (!chunk.refreshing && (chunk.stale || chunk.refreshError))
        )
          throw new Error(
            chunk.refreshError ||
              "This listing could not be refreshed. Please retry.",
          );
        chunks.push(chunk);
        if (!chunk.hasMore) break;
      }
      const changed = new Set(chunks.map((chunk) => chunk.revision)).size > 1;
      result = {
        ...chunks[chunks.length - 1],
        items: distinctItems(chunks.flatMap((chunk) => chunk.items)),
        stale: changed || chunks.some((chunk) => chunk.stale),
        refreshing: changed || chunks.some((chunk) => chunk.refreshing),
        retryStopped: chunks.some((chunk) => chunk.retryStopped),
        refreshError: chunks.find((chunk) => chunk.refreshError)?.refreshError,
      };
    } else {
      params.set("page", String(page));
      if (previous) {
        previous.retryPage = page;
        previous.retryThrough = undefined;
      }
      result = await request<BrowsePage>(`/api/browse?${params}`, { signal });
    }
    if (signal.aborted) return;
    if (result.retryStopped || (result.refreshError && !result.refreshing)) {
      if (!previous && result.items.length) apply(result);
      throw new Error(
        result.refreshError ||
          "This listing could not be refreshed. Please retry.",
      );
    }
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
