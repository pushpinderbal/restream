export type Kind = "live" | "movie" | "series" | "episode";
export type Category = {
  id: string;
  name: string;
  kind: "live" | "movie" | "series";
};
export type BrowsePage = {
  items: Item[];
  page: number;
  total: number;
  hasMore: boolean;
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
  libraryUpdatedAt?: string;
  configured: boolean;
  refreshing: boolean;
  catalogUpdatedAt?: string;
  catalogRefreshCompletedAt?: string;
  epgUpdatedAt?: string;
  error?: string;
  activeStreams: number;
  maxStreams: number;
  sync?: { catalog: RefreshState; epg: RefreshState };
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
};
export type Session = {
  id: string;
  url: string;
  state: "starting" | "ready" | "ended" | "failed";
  duration: number;
  offset: number;
  error?: string;
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
