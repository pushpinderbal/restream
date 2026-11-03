import { matchRoutes } from "react-router";

export type Tab = "live" | "movie" | "series";
export type EpisodeDestination = {
  titleId: string;
  season: number;
  episodeId: string;
};
export type Selection = {
  tab: Tab;
  category: string;
  search: string;
  item: string;
  settings: boolean;
  searchView: boolean;
  dashboard: boolean;
  player: boolean;
  episodeDestination: EpisodeDestination | null;
};

const libraries = { live: "live", movie: "movies", series: "shows" } as const;
const routes = [
  { path: "/", handle: { view: "dashboard" } },
  { path: "/settings", handle: { view: "settings" } },
  { path: "/search", handle: { view: "search" } },
  ...Object.entries(libraries).flatMap(([tab, path]) => [
    { path: `/${path}`, handle: { tab, view: "library" } },
    { path: `/${path}/:id`, handle: { tab, view: "library" } },
    { path: `/${path}/:id/watch`, handle: { tab, view: "player" } },
  ]),
];

export function locationSelection(href = window.location.href): Selection {
  const url = new URL(href, window.location.href);
  const params = url.searchParams;
  const legacy =
    url.pathname === "/" &&
    ["view", "section", "category", "search", "item"].some((key) =>
      params.has(key),
    );
  const match = matchRoutes(routes, url.pathname)?.at(-1);
  const handle = match?.route.handle as { view: string; tab?: Tab } | undefined;
  const view = legacy ? params.get("view") || "library" : handle?.view;
  const kind = legacy
    ? params.get("section")
    : handle?.tab || params.get("kind");
  const tab = kind === "movie" || kind === "series" ? kind : "live";
  const item = legacy
    ? params.get("item") || ""
    : match?.params.id || (view === "search" ? params.get("item") || "" : "");
  const season = Number(params.get("season"));
  return {
    tab,
    category:
      view === "search" || view === "settings" || view === "dashboard"
        ? "*"
        : params.get("category") || "*",
    search:
      view === "settings" || view === "dashboard"
        ? ""
        : params.get(legacy ? "search" : "q") || "",
    item,
    settings: view === "settings",
    searchView: view === "search",
    dashboard: view === "dashboard",
    player: view === "player",
    episodeDestination:
      tab === "series" && item && Number.isInteger(season) && season > 0
        ? { titleId: item, season, episodeId: params.get("episode") || "" }
        : null,
  };
}

export function selectionURL({
  tab = "live",
  category = "*",
  search = "",
  item = "",
  settings = false,
  episodeDestination = null,
  dashboard = false,
  player = false,
  searchView = false,
}: Partial<Selection>) {
  const path = settings
    ? "/settings"
    : dashboard
      ? "/"
      : searchView && !player
        ? "/search"
        : `/${libraries[tab]}${item ? `/${encodeURIComponent(item)}` : ""}${player && item ? "/watch" : ""}`;
  const url = new URL(path, window.location.origin);
  if (settings || dashboard) return url;
  if (!searchView && category !== "*")
    url.searchParams.set("category", category);
  if (search && !player) url.searchParams.set("q", search);
  if (searchView && !player && item) {
    url.searchParams.set("item", item);
    url.searchParams.set("kind", tab);
  }
  if (tab === "series" && item && episodeDestination) {
    url.searchParams.set("season", String(episodeDestination.season));
    if (episodeDestination.episodeId)
      url.searchParams.set("episode", episodeDestination.episodeId);
  }
  return url;
}
