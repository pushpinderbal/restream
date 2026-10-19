import { expect, test, type Page, type Locator } from "@playwright/test";
import {
  createHistoryFixture,
  type HistoryFixture,
} from "./watch-history-fixture";

// Tailwind's shadow-none can serialize as several transparent, zero-size shadows.
const noVisibleShadow =
  /^(?:none|(?:rgba\(0, 0, 0, 0\) 0px 0px 0px 0px,? ?)+)$/;

const live = {
  id: "live-1",
  kind: "live",
  name: "North News",
  category: "News",
  number: "7",
};
const movie = {
  id: "movie-1",
  kind: "movie",
  name: "The Quiet Coast",
  category: "Drama",
  description: "A journey along the sea.",
  duration: 3600,
};
const series = {
  id: "series-1",
  kind: "series",
  name: "Night Shift",
  category: "Drama",
};
const episodes = [
  {
    id: "episode-1",
    kind: "episode",
    name: "First Light",
    category: "Drama",
    episode: 1,
    duration: 1800,
  },
  {
    id: "episode-2",
    kind: "episode",
    name: "After Hours",
    category: "Drama",
    episode: 2,
    duration: 1800,
  },
  {
    id: "episode-3",
    kind: "episode",
    name: "Fresh Start",
    category: "Drama",
    season: 2,
    episode: 1,
    duration: 1800,
  },
];
const now = Date.now();

type BrowserPreferences = {
  refreshIntervalSeconds: number;
  configuration: {
    dashboardCategories: string[];
    blockedCategories: string[];
  };
  categories: {
    kind: "live" | "movie" | "series";
    id: string;
    visibility: "show" | "block";
    dashboard: boolean;
  }[];
};
const programs = [
  {
    channelId: "live-1",
    title: "Morning Report",
    start: new Date(now - 60000).toISOString(),
    end: new Date(now + 3600000).toISOString(),
  },
  {
    channelId: "live-1",
    title: "City Desk",
    start: new Date(now + 3600000).toISOString(),
    end: new Date(now + 7200000).toISOString(),
  },
];

async function navigateLibrary(
  page: Page,
  section: "live" | "movie" | "series",
) {
  const navigation = page.getByRole("navigation", {
    name:
      (page.viewportSize()?.width ?? 1440) <= 820
        ? "Primary navigation"
        : "Library",
    exact: true,
  });
  const destination = navigation.getByRole("button", {
    name: section === "live" ? "Live TV" : "VOD",
    exact: true,
  });
  const types = page.getByRole("tablist", { name: "VOD type", exact: true });
  if (section === "live" || !(await types.isVisible()))
    await destination.click();
  if (section !== "live") {
    await page
      .getByRole("tablist", { name: "VOD type", exact: true })
      .getByRole("tab", {
        name: section === "movie" ? "Movies" : "Shows",
        exact: true,
      })
      .click();
  }
}

async function reviewInteraction(page: Page, target: Locator, label: string) {
  if (!process.env.INTERACTION_REVIEW) return;
  await target.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../output/interaction-review/${label}.png` });
}

async function focusUnderline(target: Locator, pseudo = "::before") {
  return target.evaluate((element, selector) => {
    const style = getComputedStyle(element, selector);
    return (
      style.content !== "none" &&
      style.content !== "normal" &&
      style.display !== "none" &&
      Number(style.opacity) > 0 &&
      parseFloat(style.width) > 0 &&
      parseFloat(style.height) > 0
    );
  }, pseudo);
}

async function expectPointerFocus(page: Page, target: Locator) {
  await expect(page.locator("html")).toHaveAttribute(
    "data-input-modality",
    "pointer",
  );
  await expect(target).toHaveCSS("outline-style", "none");
  await expect(target).toHaveCSS("box-shadow", noVisibleShadow);
  await expect(target).not.toHaveCSS("text-decoration-line", /underline/);
  if (
    await target.evaluate((element) => element.classList.contains("focus-icon"))
  )
    await expect.poll(() => focusUnderline(target)).toBe(false);
}

async function expectKeyboardIcon(page: Page, target: Locator) {
  await expect(page.locator("html")).toHaveAttribute(
    "data-input-modality",
    "keyboard",
  );
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS("outline-style", "none");
  await expect(target).toHaveCSS("box-shadow", noVisibleShadow);
  await expect.poll(() => focusUnderline(target)).toBe(true);
}

async function openSettings(page: Page) {
  await page
    .getByRole("button", { name: "Account", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("menu", { name: "Account", exact: true })
    .getByRole("menuitem", { name: "Settings", exact: true })
    .click();
}

async function openSearch(page: Page) {
  const nav = page.getByRole("navigation", {
    name:
      (page.viewportSize()?.width ?? 1440) <= 820
        ? "Primary navigation"
        : "Library",
    exact: true,
  });
  await nav.getByRole("button", { name: "Search", exact: true }).click();
  return page.getByRole("searchbox", { name: "Search library", exact: true });
}

async function expectHome(page: Page) {
  await expect(page.locator(".discovery-dashboard")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Home", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toHaveCount(0);
}

async function chooseCategory(page: Page, name: string) {
  const category = page.getByRole("combobox", {
    name: "Category",
    exact: true,
  });
  await category.click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect(category).toContainText(name);
}

async function collapseTitle(page: Page) {
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  });
  const stop = page.getByRole("button", { name: "Stop playback", exact: true });
  if (await stop.count()) {
    await stop.click();
    await expect(page.locator("video")).toHaveCount(0);
  }
  if (
    ["dashboard", "settings"].includes(
      new URL(page.url()).searchParams.get("view") || "",
    )
  )
    return;
  const selectedTile = page
    .locator('.media-card[aria-expanded="true"]')
    .first();
  if (await selectedTile.count()) {
    if (!(await selectedTile.isVisible())) {
      const section = new URL(page.url()).searchParams.get("section");
      await navigateLibrary(
        page,
        section === "movie" || section === "series" ? section : "live",
      );
    }
    if (!(await selectedTile.isVisible())) return;
    await selectedTile.click();
    await expect(
      page.getByRole("region", { name: "Expanded title" }),
    ).toHaveCount(0);
  }
}

async function navigatePlayer(
  page: Page,
  title: typeof movie | typeof series | typeof live,
  item: { id: string; season?: number } = title,
) {
  await page.evaluate(
    ({ title, item }) => {
      const url = new URL(location.href);
      url.searchParams.set("view", "player");
      url.searchParams.set("item", title.id);
      url.searchParams.set("section", title.kind);
      if (title.kind === "series") {
        url.searchParams.set("season", String(item.season || 1));
        url.searchParams.set("episode", item.id);
      } else {
        url.searchParams.delete("season");
        url.searchParams.delete("episode");
      }
      history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    { title, item },
  );
}

test.afterEach(async ({ page }) => {
  await collapseTitle(page);
});

async function mockApi(
  page: Page,
  options: {
    history?: HistoryFixture;
    user?: string;
    nativeHls?: boolean;
    mediaSource?: boolean;
    initialEmpty?: boolean;
    capacity?: boolean;
    producerEnded?: boolean;
    sessionDuration?: number;
    initialSessionDuration?: number;
    starting?: boolean | (() => boolean);
    refreshing?: boolean;
    refreshDelayMs?: number;
    refreshFailure?: boolean;
    unconfigured?: boolean;
    cooldown?: boolean;
    createDelayMs?: number;
    createGate?: Promise<void>;
    releaseDelayMs?: number;
    episodesFailureOnce?: boolean;
    episodeItems?: () => Record<string, unknown>[];
    episodesResponse?: (params: URLSearchParams) => Record<string, unknown>;
    catalogItems?: Record<string, unknown>[];
    categories?: { id: string; name: string; kind: string }[];
    guidePrograms?: Array<(typeof programs)[number] & { description?: string }>;
    discoveryResponse?: Record<string, unknown>;
    preferences?: BrowserPreferences;
    preferencesGate?: Promise<void>;
    preferencesFailure?: boolean | (() => boolean);
    settingsSaveFailure?: boolean | (() => boolean);
    settingsSaveGate?: Promise<void>;
    guideHours?: number;
    tmdbTokenConfigured?: boolean;
    providerEnvironment?: Array<
      | "portalUrl"
      | "mac"
      | "timezone"
      | "serialNumber"
      | "deviceId"
      | "deviceId2"
    >;
    browseResponse?: (params: URLSearchParams) => Promise<{
      items?: Record<string, unknown>[];
      page?: number;
      total?: number;
      hasMore?: boolean;
      revision?: number;
      stale?: boolean;
      refreshing?: boolean;
      error?: string;
      status?: number;
    }>;
  } = {},
) {
  // Workflow fixtures exercise controlled media state; real-playback.mjs
  // covers HLS decoding. Avoid starting an actual decoder on empty playlists.
  await page.addInitScript(
    ({ nativeHls, mediaSource }) => {
      const canPlayType = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (type) {
        return type === "application/vnd.apple.mpegurl"
          ? nativeHls
            ? "probably"
            : ""
          : canPlayType.call(this, type);
      };
      if (!mediaSource) {
        for (const name of [
          "MediaSource",
          "ManagedMediaSource",
          "WebKitMediaSource",
        ])
          Reflect.deleteProperty(window, name);
        // Empty workflow playlists are not real media. Keep their native errors
        // out of tests that explicitly control canplay, pause, and seek state.
        document.addEventListener(
          "error",
          (event) => {
            if (event.target instanceof HTMLMediaElement)
              event.stopImmediatePropagation();
          },
          true,
        );
      }
    },
    {
      nativeHls: options.nativeHls !== false,
      mediaSource: options.mediaSource ?? options.nativeHls === false,
    },
  );
  const history = options.history ?? createHistoryFixture();
  let catalogReady = !options.initialEmpty;
  let active = false;
  let nextId = 0;
  let polls = 0;
  let episodeAttempts = 0;
  const events: string[] = [];
  const sessionItemIds: string[] = [];
  const refreshRunning = { catalog: false, epg: false };
  const refreshUpdated = {
    catalog: "2026-09-28T12:00:00Z",
    epg: "2026-09-28T12:00:00Z",
  };
  const sessionStarts: number[] = [];
  const sessionOffsets = new Map<string, number>();
  let preferences: BrowserPreferences = structuredClone(
    options.preferences ?? {
      refreshIntervalSeconds: 21600,
      categories: [],
      configuration: {
        dashboardCategories: [],
        blockedCategories: [],
      },
    },
  );
  const mutations: { method: string; path: string }[] = [];
  let preferencesUpdatedAt: string | undefined;
  let providerConfigured = !options.unconfigured;
  const providerPatches: Record<string, unknown>[] = [];
  const settingsPatches: Record<string, unknown>[] = [];
  const settings = {
    providerEnvironment: options.providerEnvironment ?? [],
    provider: {
      portalUrl: providerConfigured ? "http://provider.example" : "",
      mac: providerConfigured ? "00:11:22:33:44:55" : "",
      timezone: "America/Toronto",
      serialNumber: "",
      deviceId: "",
      deviceId2: "",
    },
    library: {
      refreshIntervalSeconds: preferences.refreshIntervalSeconds,
      dashboardCategories: [...preferences.configuration.dashboardCategories],
      blockedCategories: [...preferences.configuration.blockedCategories],
      guideHours: options.guideHours ?? 48,
    },
    discovery: { tmdbTokenConfigured: options.tmdbTokenConfigured ?? false },
    playback: { maxStreams: 1, transcodeMode: "auto" },
    updatedAt: "2026-09-28T12:00:00Z",
  };
  for (const key of settings.providerEnvironment) settings.provider[key] = "";
  const applySettingsPolicy = () => {
    preferences.refreshIntervalSeconds =
      settings.library.refreshIntervalSeconds;
    preferences.configuration = {
      dashboardCategories: [...settings.library.dashboardCategories],
      blockedCategories: [...settings.library.blockedCategories],
    };
    const matches = (
      rule: string,
      category: { id: string; name: string; kind: string },
    ) => {
      const colon = rule.indexOf(":");
      const scope = colon < 0 ? "" : rule.slice(0, colon).toLowerCase();
      const value = (colon < 0 ? rule : rule.slice(colon + 1)).toLowerCase();
      return (
        (!scope || scope === category.kind) &&
        (value === "*" ||
          value === category.id.toLowerCase() ||
          value === category.name.toLowerCase())
      );
    };
    preferences.categories = allCategories.map((category) => ({
      kind: category.kind as "live" | "movie" | "series",
      id: category.id,
      visibility: settings.library.blockedCategories.some((rule) =>
        matches(rule, category),
      )
        ? ("block" as const)
        : ("show" as const),
      dashboard:
        !settings.library.dashboardCategories.length ||
        settings.library.dashboardCategories.some((rule) =>
          matches(rule, category),
        ),
    }));
    preferencesUpdatedAt = settings.updatedAt;
  };
  const allItems: Record<string, unknown>[] = options.catalogItems ?? [
    live,
    movie,
    series,
  ];
  const allCategories = options.categories ?? [
    { id: "news", name: "News", kind: "live" },
    { id: "drama-movie", name: "Drama", kind: "movie" },
    { id: "drama-series", name: "Drama", kind: "series" },
    { id: "documentary", name: "Documentary", kind: "live" },
  ];
  const categoryRule = (value: Record<string, unknown>) => {
    const item =
      value.kind === "episode"
        ? (allItems.find((candidate) => candidate.kind === "series") ?? value)
        : value;
    const id =
      item.categoryId ??
      allCategories.find(
        (category) =>
          category.kind === item.kind && category.name === item.category,
      )?.id;
    return preferences.categories.find(
      (rule) => rule.kind === item.kind && rule.id === id,
    );
  };
  const visible = (item: Record<string, unknown>) =>
    categoryRule(item)?.visibility !== "block";
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (await history.handle(route, options.user)) return;
    if (!["GET", "HEAD"].includes(method)) mutations.push({ method, path });
    const starting =
      typeof options.starting === "function"
        ? options.starting()
        : options.starting;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/auth") {
      return json(
        options.user
          ? {
              mode: "oidc",
              user: { id: options.user, name: options.user, role: "viewer" },
            }
          : { mode: "none", user: null },
      );
    }
    if (path === "/api/settings") {
      if (options.preferencesGate) await options.preferencesGate;
      if (
        typeof options.preferencesFailure === "function"
          ? options.preferencesFailure()
          : options.preferencesFailure
      )
        return json({ error: "Configuration is temporarily unavailable" }, 503);
      if (method === "PATCH") {
        settingsPatches.push(structuredClone(route.request().postDataJSON()));
        if (options.settingsSaveGate) await options.settingsSaveGate;
        if (
          typeof options.settingsSaveFailure === "function"
            ? options.settingsSaveFailure()
            : options.settingsSaveFailure
        )
          return json({ error: "Settings could not be saved" }, 503);
        const patch = route.request().postDataJSON();
        if (patch.provider) {
          providerPatches.push(structuredClone(patch.provider));
          if (
            settings.providerEnvironment.some((key) =>
              Object.hasOwn(patch.provider, key),
            )
          )
            return json(
              {
                code: "environment_managed",
                error:
                  "Provider settings managed by the environment cannot be changed here.",
              },
              403,
            );
        }
        for (const key of ["provider", "library", "playback"] as const)
          if (patch[key]) Object.assign(settings[key], patch[key]);
        if (
          patch.discovery &&
          Object.hasOwn(patch.discovery, "tmdbReadAccessToken")
        )
          settings.discovery.tmdbTokenConfigured =
            !!patch.discovery.tmdbReadAccessToken;
        providerConfigured =
          (!!settings.provider.portalUrl ||
            settings.providerEnvironment.includes("portalUrl")) &&
          (!!settings.provider.mac ||
            settings.providerEnvironment.includes("mac"));
        settings.updatedAt = new Date().toISOString();
        applySettingsPolicy();
      }
      return json(settings);
    }
    if (path === "/api/preferences") {
      if (method !== "GET")
        return json(
          { code: "read_only", error: "Configuration is read-only" },
          405,
        );
      if (method === "GET" && options.preferencesGate)
        await options.preferencesGate;
      if (
        typeof options.preferencesFailure === "function"
          ? options.preferencesFailure()
          : options.preferencesFailure
      )
        return json({ error: "Configuration is temporarily unavailable" }, 503);
      return json(preferences);
    }
    if (path === "/api/status") {
      return json({
        configured: providerConfigured,
        refreshing:
          options.refreshing || refreshRunning.catalog || refreshRunning.epg,
        catalogUpdatedAt: catalogReady ? refreshUpdated.catalog : undefined,
        libraryUpdatedAt: catalogReady ? refreshUpdated.catalog : undefined,
        epgUpdatedAt: refreshUpdated.epg,
        preferencesUpdatedAt,
        activeStreams: active ? 1 : 0,
        maxStreams: settings.playback.maxStreams,
        timezone: settings.provider.timezone,
        guideHours: settings.library.guideHours,
        playback: {
          transcodeMode: settings.playback.transcodeMode,
          sessionTimeoutSeconds: 45,
        },
        portalCooldownUntil: options.cooldown
          ? new Date(Date.now() + 60000).toISOString()
          : undefined,
        library: {
          liveChannels: 1,
          categories: 4,
          programmes: 2,
          cachedMovies: 1,
          cachedSeries: 1,
          guideEndsAt: programs[1].end,
        },
        sync: Object.fromEntries(
          (["catalog", "epg"] as const).map((target) => [
            target,
            {
              queued: false,
              running: options.refreshing || refreshRunning[target],
              lastSuccessfulAt: catalogReady
                ? refreshUpdated[target]
                : undefined,
              startedAt: refreshRunning[target]
                ? new Date().toISOString()
                : undefined,
              nextRefreshAt: new Date(Date.now() + 3600000).toISOString(),
              intervalSeconds: preferences.refreshIntervalSeconds,
            },
          ]),
        ),
      });
    }
    if (path === "/api/catalog")
      return json({
        items: catalogReady
          ? allItems.filter((item) => item.kind === "live" && visible(item))
          : [],
      });
    if (path === "/api/categories")
      return json({
        categories: allCategories.filter(
          (category) =>
            url.searchParams.get("manage") === "1" ||
            !preferences.categories.some(
              (rule) =>
                rule.kind === category.kind &&
                rule.id === category.id &&
                rule.visibility !== "show",
            ),
        ),
      });
    if (path === "/api/browse") {
      events.push(`BROWSE:${url.search}`);
      if (options.browseResponse) {
        const result = await options.browseResponse(url.searchParams);
        const { status, ...body } = result;
        return json(body, status ?? 200);
      }
      const kind = url.searchParams.get("kind");
      const category = url.searchParams.get("category");
      const search = (url.searchParams.get("search") || "").toLowerCase();
      const items = allItems.filter(
        (item) =>
          item.kind === kind &&
          visible(item) &&
          (category === "*" ||
            (options.categories
              ? item.categoryId === category
              : kind === "movie"
                ? category === "drama-movie"
                : category === "drama-series")) &&
          String(item.name).toLowerCase().includes(search),
      );
      return json({
        items,
        page: Number(url.searchParams.get("page")),
        total: items.length,
        hasMore: false,
      });
    }
    if (path === "/api/epg")
      return json({
        programs: (options.guidePrograms ?? programs).filter((program) => {
          const channel = allItems.find(
            (item) => item.id === program.channelId,
          );
          return !channel || visible(channel);
        }),
      });
    if (path === "/api/discovery") {
      events.push("DISCOVERY");
      const discovery: Record<string, unknown> = {
        ...(options.discoveryResponse ?? {
          configured: false,
          refreshing: false,
          trendingMovies: [],
          trendingSeries: [],
          exploreMovies: [{ item: movie, name: movie.name }],
          exploreSeries: [{ item: series, name: series.name }],
        }),
      };
      for (const key of [
        "trendingMovies",
        "trendingSeries",
        "exploreMovies",
        "exploreSeries",
      ]) {
        const titles = discovery[key];
        if (Array.isArray(titles))
          discovery[key] = titles.filter(
            (title) =>
              visible(title.item) &&
              categoryRule(title.item)?.dashboard !== false,
          );
      }
      return json(discovery);
    }
    if (path.startsWith("/api/items/")) {
      const id = decodeURIComponent(path.slice("/api/items/".length));
      const item = allItems.find((value) => value.id === id);
      if (item && categoryRule(item)?.visibility === "block")
        return json(
          { code: "blocked", error: "This category is blocked" },
          403,
        );
      return item ? json({ item }) : json({ error: "Title unavailable" }, 404);
    }
    if (path === "/api/refresh" && method === "POST") {
      events.push("REFRESH");
      if (options.refreshFailure)
        return json({ error: "Refresh is temporarily unavailable" }, 503);
      const target = route.request().postDataJSON().target as
        "all" | "catalog" | "epg";
      events.push(`REFRESH:${target}`);
      for (const kind of ["catalog", "epg"] as const) {
        if (target !== "all" && target !== kind) continue;
        refreshRunning[kind] = true;
        setTimeout(() => {
          refreshRunning[kind] = false;
          refreshUpdated[kind] = new Date().toISOString();
          catalogReady = true;
        }, options.refreshDelayMs ?? 1500);
      }
      return json({ accepted: true }, 202);
    }
    if (/^\/api\/series\/[^/]+\/episodes$/.test(path)) {
      const titleId = decodeURIComponent(path.split("/")[3]);
      const title = allItems.find((item) => item.id === titleId) ?? series;
      if (categoryRule(title)?.visibility === "block")
        return json(
          { code: "blocked", error: "This category is blocked" },
          403,
        );
      episodeAttempts++;
      events.push("EPISODES");
      if (options.episodesFailureOnce && episodeAttempts === 1)
        return json({ error: "Episodes are temporarily unavailable" }, 503);
      return json(
        options.episodesResponse?.(url.searchParams) ?? {
          items: options.episodeItems?.() ?? episodes,
        },
      );
    }
    if (path === "/api/sessions" && method === "POST") {
      events.push("POST");
      sessionItemIds.push(route.request().postDataJSON().itemId);
      sessionStarts.push(route.request().postDataJSON().start ?? 0);
      const selected = [
        ...allItems,
        ...(options.episodeItems?.() ?? episodes),
      ].find((item) => item.id === route.request().postDataJSON().itemId);
      if (selected && categoryRule(selected)?.visibility === "block")
        return json(
          { code: "blocked", error: "This category is blocked" },
          403,
        );
      if (options.capacity || active)
        return json(
          {
            code: "capacity",
            error:
              "No room available. All streaming slots are in use. Try again when someone stops watching.",
          },
          409,
        );
      active = true;
      nextId++;
      const offset = Number(route.request().postDataJSON().start) || 0;
      sessionOffsets.set(`session-${nextId}`, offset);
      polls = 0;
      if (options.createDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.createDelayMs),
        );
      if (options.createGate) await options.createGate;
      return json(
        {
          id: `session-${nextId}`,
          url: `/api/streams/session-${nextId}/0/index.m3u8`,
          state: starting ? "starting" : "ready",
          duration:
            (starting ? options.initialSessionDuration : undefined) ??
            options.sessionDuration ??
            1800,
          offset,
        },
        201,
      );
    }
    if (/^\/api\/sessions\/session-\d+$/.test(path) && method === "GET") {
      polls++;
      const id = path.split("/").at(-1);
      return json({
        id,
        url: `/api/streams/${id}/0/index.m3u8`,
        state: starting
          ? "starting"
          : options.producerEnded && polls > 1
            ? "ended"
            : "ready",
        duration:
          (starting ? options.initialSessionDuration : undefined) ??
          options.sessionDuration ??
          1800,
        offset: sessionOffsets.get(id!) ?? 0,
      });
    }
    if (/^\/api\/sessions\/session-\d+$/.test(path) && method === "DELETE") {
      events.push("DELETE");
      if (options.releaseDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.releaseDelayMs),
        );
      active = false;
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/heartbeat")) return route.fulfill({ status: 204 });
    if (path.endsWith("/seek"))
      return json({
        id: path.split("/")[3],
        url: "/api/streams/seek/1/index.m3u8",
        state: "ready",
        duration: 1800,
        offset: 100,
      });
    if (path.endsWith("/index.m3u8"))
      return route.fulfill({
        status: 200,
        contentType: "application/vnd.apple.mpegurl",
        body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-ENDLIST\n",
      });
    return json({ error: "Unexpected request" }, 404);
  });
  return {
    history,
    events,
    sessionItemIds,
    sessionStarts,
    mutations,
    effectivePreferences: () => structuredClone(preferences),
    effectiveSettings: () => structuredClone(settings),
    providerPatches,
    settingsPatches,
    deployConfiguration: (next: BrowserPreferences) => {
      preferences = structuredClone(next);
      preferencesUpdatedAt = new Date().toISOString();
      settings.library.refreshIntervalSeconds = next.refreshIntervalSeconds;
      settings.library.dashboardCategories = [
        ...next.configuration.dashboardCategories,
      ];
      settings.library.blockedCategories = [
        ...next.configuration.blockedCategories,
      ];
      settings.updatedAt = preferencesUpdatedAt;
    },
    publishSnapshot: () => {
      catalogReady = true;
      refreshUpdated.catalog = new Date().toISOString();
    },
  };
}

// Exercise the real player UI with a controlled media window, including native
// HLS's seekable fallback. Existing real-playback checks cover HLS decoding.
async function playableVideo(page: Page, position = 30, edge = 100) {
  await page.locator("video").evaluate(
    (element, { position, edge }) => {
      const video = element as HTMLVideoElement;
      let paused = false;
      let currentTime = position;
      Object.defineProperties(video, {
        paused: { configurable: true, get: () => paused },
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => {
            currentTime = value;
            video.dispatchEvent(new Event("timeupdate"));
          },
        },
        seekable: {
          configurable: true,
          get: () => ({ length: 1, start: () => 0, end: () => edge }),
        },
        play: {
          configurable: true,
          value: async () => {
            paused = false;
            video.dispatchEvent(new Event("play"));
            video.dispatchEvent(new Event("playing"));
          },
        },
        pause: {
          configurable: true,
          value: () => {
            paused = true;
            video.dispatchEvent(new Event("pause"));
          },
        },
      });
      video.dispatchEvent(new Event("play"));
      video.dispatchEvent(new Event("playing"));
      video.dispatchEvent(new Event("timeupdate"));
    },
    { position, edge },
  );
}

test("LIVE greys behind the stream and jumps to the latest seek point while resuming", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page
      .getByRole("button", { name: "Pause", exact: true })
      .or(page.locator(".primary-control")),
  ).toBeEnabled();
  await playableVideo(page);
  const liveButton = page.getByRole("button", { name: "Go to live" });
  const revealControls = async () => {
    await page.locator(".playback-area").press("ArrowUp");
    await expect(page.locator(".video-controls")).toHaveAttribute(
      "data-visible",
      "true",
    );
    await expect(page.locator(".video-controls")).toHaveJSProperty(
      "inert",
      false,
    );
    await page.locator(".primary-control").focus();
    await expect(page.locator(".primary-control")).toBeFocused();
    await expectKeyboardIcon(page, page.locator(".primary-control"));
    await expect(page.locator(".video-controls :focus-visible")).toHaveCount(1);
  };
  await revealControls();
  await expect(page.locator("#inline-title-details")).toHaveCount(0);
  await expect(page.locator(".primary-control")).toBeFocused();
  await expect(page.locator(".video-controls :focus-visible")).toHaveCount(1);
  await page.locator(".primary-control").click();
  await expectPointerFocus(page, page.locator(".primary-control"));
  await page.locator(".primary-control").click();
  await revealControls();
  await expect(liveButton).toHaveAttribute("data-behind", "true");
  await expect(liveButton).toHaveCSS("color", "rgb(146, 152, 165)");
  await page.getByRole("button", { name: "Pause", exact: true }).press("Enter");
  await revealControls();
  await liveButton.focus();
  await liveButton.press("Enter");
  await expect
    .poll(() =>
      page.locator("video").evaluate((video) => ({
        time: (video as HTMLVideoElement).currentTime,
        paused: (video as HTMLVideoElement).paused,
      })),
    )
    .toEqual({ time: 99.5, paused: false });
  await expect(liveButton).toHaveAttribute("data-behind", "false");
  await expect(liveButton).toHaveCSS("color", "rgb(255, 114, 124)");
  await page.locator("video").evaluate((video) => {
    (video as HTMLVideoElement).currentTime = 90;
  });
  await expect(liveButton).toHaveAttribute("data-behind", "false");
  await page.locator("video").evaluate((video) => {
    Object.defineProperty(video, "seekable", {
      configurable: true,
      get: () => ({ length: 1, start: () => 10, end: () => 130 }),
    });
    video.dispatchEvent(new Event("progress"));
  });
  await expect(liveButton).toHaveAttribute("data-behind", "true");
  await revealControls();
  await liveButton.focus();
  await liveButton.press("Enter");
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).currentTime),
    )
    .toBe(129.5);
  await page.locator("video").click();
  expect(
    await page
      .locator("video")
      .evaluate((video) => (video as HTMLVideoElement).paused),
  ).toBe(true);
  await page.locator("video").click();
  expect(
    await page
      .locator("video")
      .evaluate((video) => (video as HTMLVideoElement).paused),
  ).toBe(false);
  expect(api.sessionItemIds).toEqual([live.id]);
  expect(api.events).not.toContain("DELETE");
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`leaving the watch workspace stops playback before browsing at ${viewport.width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize(viewport);
    await page.goto("/?view=search&section=live&search=North");
    await page.getByRole("button", { name: "Open North News" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page).toHaveURL(/view=player/);
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    const originalVideo = await page.locator("video").elementHandle();
    await navigateLibrary(page, "series");
    await expect(page.locator("video")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Player", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(1);
    expect(
      await originalVideo!.evaluate((element) => element.isConnected),
    ).toBe(false);
    await page.getByRole("button", { name: "Open Night Shift" }).click();
    await expect(
      page.getByRole("button", { name: /After Hours/ }),
    ).toBeVisible();
    await navigateLibrary(page, "movie");
    await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
    expect(api.sessionItemIds).toEqual([live.id]);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => api.sessionItemIds).toEqual([live.id, movie.id]);
    await expect(page).toHaveURL(/view=player/);
    await expect(page.locator(".dock-title")).toHaveText(movie.name);
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Movies library", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Player", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(2);
    expect(new URL(page.url()).searchParams.get("view")).not.toBe("player");
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`closing the channel workspace restores its original details without another stream at ${viewport.width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize(viewport);
    await page.goto("/?view=search&section=live&search=North");
    await page.getByRole("button", { name: "Open North News" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(page).toHaveURL(/item=live-1/);
    expect(new URL(page.url()).searchParams.get("view")).not.toBe("player");
    await expect(
      page.getByRole("region", { name: "Expanded title", exact: true }),
    ).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(1);
    expect(api.sessionItemIds).toEqual([live.id]);
  });

  test(`series Title details stops playback and restores the watched season at ${viewport.width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize(viewport);
    await page.goto("/?view=search&section=series&search=Night");
    await page.getByRole("button", { name: "Open Night Shift" }).click();
    await page.getByRole("combobox", { name: "Season" }).click();
    await page.getByRole("option", { name: "Season 2" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page).toHaveURL(/view=player/);
    await expect(page).toHaveURL(/season=2/);
    await expect(page).toHaveURL(/episode=episode-3/);
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    const season = page.getByRole("combobox", { name: "Season", exact: true });
    await page.keyboard.press("Tab");
    await season.focus();
    await expect(season).toHaveCSS("text-decoration-line", "underline");
    await expect(season).toHaveCSS("border-top-width", "0px");
    await expect(season).toHaveCSS("outline-style", "none");
    await expect(season).toHaveCSS("box-shadow", noVisibleShadow);
    await reviewInteraction(page, season, `season-${viewport.width}-keyboard`);
    const details = page
      .getByRole("complementary", { name: "Watch context", exact: true })
      .getByRole("button", { name: "Title details", exact: true });
    await page.keyboard.press("Tab");
    await details.focus();
    await expect(details).toHaveCSS("text-decoration-line", "underline");
    await expect(details).toHaveCSS("outline-style", "none");
    const stop = page.getByRole("button", {
      name: "Stop playback",
      exact: true,
    });
    await page.keyboard.press("Tab");
    await stop.focus();
    await expectKeyboardIcon(page, stop);
    await reviewInteraction(page, stop, `player-${viewport.width}-keyboard`);
    await season.click();
    await page.getByRole("option", { name: "Season 2", exact: true }).click();
    await expect(season).toHaveText("Season 2");
    await expect(season).toBeFocused();
    await expectPointerFocus(page, season);
    await expect(season).toHaveCSS("border-top-width", "0px");
    await reviewInteraction(
      page,
      season,
      `season-${viewport.width}-pointer-selection`,
    );
    await stop.focus();
    await expectPointerFocus(page, stop);
    await reviewInteraction(
      page,
      stop,
      `player-${viewport.width}-pointer-restored`,
    );
    await details.click();
    await expect(page).toHaveURL(/section=series/);
    await expect(page).toHaveURL(/season=2/);
    await expect(page.getByRole("combobox", { name: "Season" })).toHaveText(
      "Season 2",
    );
    await expect(
      page.getByText("Selected · S2 E1 · Fresh Start"),
    ).toBeVisible();
    await expect(page.locator(".episode-row.selected")).toContainText(
      "Fresh Start",
    );
    await expect(page.locator("video")).toHaveCount(0);
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(1);
    expect(api.sessionItemIds).toEqual(["episode-3"]);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Season" })).toHaveText(
      "Season 2",
    );
    await expect(
      page.getByText("Selected · S2 E1 · Fresh Start"),
    ).toBeVisible();
    expect(api.sessionItemIds).toEqual(["episode-3"]);
  });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`closing the player releases media and restores its origin with ${reducedMotion} motion`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.emulateMedia({ reducedMotion });
    await page.goto("/?view=search&section=movie&search=Quiet");
    await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
    const origin = page.url();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    const media = await page.locator("video").elementHandle();
    await expect(
      page.getByRole("region", { name: "Player", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(page.locator("video")).toHaveCount(0);
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(1);
    expect(
      await media!.evaluate((element) => ({
        connected: element.isConnected,
        paused: (element as HTMLVideoElement).paused,
      })),
    ).toEqual({ connected: false, paused: true });
    await expect(page).toHaveURL(origin);
    await expect(
      page.getByRole("region", { name: "Expanded title" }),
    ).toBeVisible();
  });
}

for (const item of [live, movie, series]) {
  test(`searched ${item.kind} preserves its all-category listing and portal category metadata`, async ({
    page,
  }) => {
    const categoryName =
      item.kind === "series"
        ? "English TV Shows"
        : item.kind === "movie"
          ? "English Movies"
          : "English Channels";
    const categoryId = `english-${item.kind}`;
    const searchedItem = { ...item, category: "", categoryId };
    const api = await mockApi(page, {
      catalogItems: [searchedItem],
      categories: [{ id: categoryId, name: categoryName, kind: item.kind }],
    });
    await page.goto(
      `/?view=search&section=${item.kind}&search=${encodeURIComponent(item.name)}`,
    );
    await page.getByRole("button", { name: `Open ${item.name}` }).click();
    await page
      .getByRole("button", {
        name: "Play",
        exact: true,
      })
      .click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    expect(new URL(page.url()).searchParams.get("category")).toBeNull();
    expect(new URL(page.url()).searchParams.get("search")).toBe(item.name);
    await expect
      .poll(() => api.history.read()[0]?.title)
      .toMatchObject({
        id: item.id,
        categoryId,
        category: categoryName,
      });
    const sidebar = page.getByRole("complementary", {
      name: "Watch context",
      exact: true,
    });
    if (item.kind === "live")
      await page
        .getByRole("button", { name: "Stop playback", exact: true })
        .click();
    else
      await sidebar
        .getByRole("button", { name: "Title details", exact: true })
        .click();
    await expect(
      page.getByRole("region", { name: "Expanded title", exact: true }),
    ).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);
    expect(api.sessionItemIds).toHaveLength(1);
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(1);
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`episode lists form compact responsive columns at ${viewport.width}px`, async ({
    page,
  }) => {
    await mockApi(page);
    await page.setViewportSize(viewport);
    await page.goto("/?section=series");
    await page.getByRole("button", { name: "Open Night Shift" }).click();
    const rows = page.locator(".episode-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toBeVisible();
    // Read both positions in one frame while the expansion scrolls into view.
    const [first, second] = await rows.evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width } = element.getBoundingClientRect();
        return { x, y, width };
      }),
    );
    expect(first!.width).toBeLessThanOrEqual(341);
    if (viewport.width > 820) {
      expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
      expect(second!.x).toBeGreaterThan(first!.x);
    } else {
      expect(second!.y).toBeGreaterThan(first!.y);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
    }
    if (process.env.CAPTURE_SCREENSHOTS) {
      await expect(page.locator(".inline-expansion")).toHaveAttribute(
        "style",
        /height: auto/,
      );
      if (process.env.CAPTURE_SCREENSHOTS)
        await page.screenshot({
          path: `/tmp/restream-episodes-${viewport.width}.png`,
          fullPage: false,
        });
    }
  });

  test(`play and pause flash a fading feedback icon without caption state at ${viewport.width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize(viewport);
    await page.goto("/?section=movie");
    await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    await expect(
      page.getByRole("heading", {
        name: /Now playing|Connecting|Paused|Finished/,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(page.locator(".playback-feedback")).toHaveCount(0);
    await page.locator(".primary-control").click();
    await expect(
      page.locator('.playback-feedback[data-action="pause"]'),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate((element) => (element as HTMLVideoElement).paused),
      )
      .toBe(true);
    await expect(page.locator(".playback-feedback")).toHaveCSS(
      "pointer-events",
      "none",
    );
    await expect(page.locator(".playback-feedback")).toHaveCount(0);
    await page.locator(".primary-control").click();
    await expect(
      page.locator('.playback-feedback[data-action="play"]'),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate((element) => (element as HTMLVideoElement).paused),
      )
      .toBe(false);
    await expect(page.locator(".playback-feedback")).toHaveCount(0);
    if (viewport.width > 820) {
      await page.locator("video").click();
      await expect(
        page.locator('.playback-feedback[data-action="pause"]'),
      ).toHaveCount(1);
      await page
        .getByRole("region", { name: "Player" })
        .getByRole("button", { name: "Full screen" })
        .click();
      await expect
        .poll(() => page.evaluate(() => !!document.fullscreenElement))
        .toBe(true);
      await page.locator(".playback-area").focus();
      await page.keyboard.press("k");
      await expect(
        page.locator('.playback-feedback[data-action="play"]'),
      ).toHaveCount(1);
      await page
        .getByRole("button", { name: "Exit full screen", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => !!document.fullscreenElement))
        .toBe(false);
    }
    expect(api.sessionItemIds).toEqual([movie.id]);
    expect(api.events).not.toContain("DELETE");
  });
}

test("watch workspace fits responsive screens without replacing its decoder", async ({
  page,
}) => {
  const api = await mockApi(page, { sessionDuration: 7808 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".primary-control")).toBeEnabled();
  await playableVideo(page);
  const video = await page.locator("video").elementHandle();
  const player = page.getByRole("region", { name: "Player", exact: true });
  await expect(player).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Watch context", exact: true })
      .getByRole("heading", { name: movie.name, exact: true }),
  ).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page).toHaveURL(/view=player/);
    await expect(player).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Movies library", exact: true }),
    ).toBeVisible();
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.width > 0 && bounds.right > innerWidth + 1;
        })
        .slice(0, 12)
        .map((element) => ({
          element: element.tagName,
          class: element.className,
          right: element.getBoundingClientRect().right,
        })),
    }));
    expect(
      layout.width,
      JSON.stringify(layout.overflowing),
    ).toBeLessThanOrEqual(viewport.width);
    expect(
      await video!.evaluate(
        (element) => element === document.querySelector("video"),
      ),
    ).toBe(true);
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `/tmp/restream-player-${viewport.width}.png`,
      });
  }
  expect(api.sessionItemIds).toEqual([movie.id]);
  expect(api.events).not.toContain("DELETE");
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(player).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Movies library", exact: true }),
  ).toBeVisible();
  await expect.poll(() => api.events.includes("DELETE")).toBe(true);
});

test.describe("touch playback", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("fullscreen taps reveal controls without pausing and the pause button still works", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/?section=movie");
    await page.getByRole("button", { name: "Open The Quiet Coast" }).tap();
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    await page.getByRole("button", { name: "Full screen", exact: true }).tap();
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    await page
      .locator(".playback-area")
      .evaluate((area) => (area as HTMLElement).blur());
    const controls = page.locator(".video-controls");
    await expect(controls).toHaveAttribute("data-visible", "false", {
      timeout: 5000,
    });
    await page.locator("video").tap();
    await expect(controls).toHaveAttribute("data-visible", "true");
    expect(
      await page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
    await page.locator("video").tap();
    expect(
      await page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
    await page.getByRole("button", { name: "Pause", exact: true }).tap();
    expect(
      await page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(true);
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    expect(
      await page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
    await page.getByRole("button", { name: "Exit full screen" }).tap();
    await page.locator("video").tap();
    expect(
      await page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
  });
});

test("server snapshot fills library without a client refresh and filters EPG channels", async ({
  page,
}) => {
  const api = await mockApi(page, { initialEmpty: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/?section=live");
  await expect(page.getByText("No channels yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh now" })).toHaveCount(
    0,
  );
  api.publishSnapshot();
  await page.clock.fastForward(10000);
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(
    page.getByRole("region", { name: "On this channel" }),
  ).toContainText("Morning Report");
  await (await openSearch(page)).fill("not here");
  await expect(
    page
      .getByRole("region", { name: "Live TV results", exact: true })
      .getByText("No matches found.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open North News", exact: true }),
  ).toHaveCount(0);
  expect(api.events).not.toContain("REFRESH");
});

for (const width of [1280, 390, 320]) {
  test(`category dropdown opens independently of VOD tabs and Escape restores focus at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page);
    await page.goto("/?section=live");
    await navigateLibrary(page, "movie");
    const movies = page
      .getByRole("tablist", { name: "VOD type" })
      .getByRole("tab", { name: "Movies", exact: true });
    await expect(movies).toHaveAttribute("aria-selected", "true");
    const category = page.getByRole("combobox", {
      name: "Category",
      exact: true,
    });
    await expect(category).toContainText("All categories");
    expect(await category.evaluate((element) => element.tagName)).toBe(
      "BUTTON",
    );
    await category.click();
    await expect(
      page.getByRole("combobox", {
        name: "Category",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("option", { name: "Drama", exact: true }),
    ).toBeVisible();
    const search = page.getByPlaceholder("Find category…", { exact: true });
    await expect(search).toBeFocused();
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/category-focus/category-search-${width}.png`,
      });
    await expect(search).toHaveCSS("outline-style", "none");
    await expect(search).toHaveCSS("box-shadow", "none");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(category).toHaveAttribute("aria-expanded", "false");
    await expect(category).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute(
      "data-input-modality",
      "keyboard",
    );
    await expect.poll(() => focusUnderline(category, "::after")).toBe(true);
    await expect(category).toHaveCSS("outline-style", "none");
    await expect(category).toHaveCSS("box-shadow", "none");
    await reviewInteraction(
      page,
      category,
      `category-${width}-keyboard-escape`,
    );
    {
      await category.click();
      await search.fill("Drama");
      await page.getByRole("option", { name: "Drama", exact: true }).click();
      await expect(category).toBeFocused();
      await expectPointerFocus(page, category);
      await expect.poll(() => focusUnderline(category, "::after")).toBe(false);
      await reviewInteraction(
        page,
        category,
        `category-${width}-pointer-selection`,
      );
      await category.click();
      await search.fill("Drama");
      await page.keyboard.press("Escape");
      await expect(category).toBeFocused();
      await expect(page.locator("html")).toHaveAttribute(
        "data-input-modality",
        "keyboard",
      );
      await expect.poll(() => focusUnderline(category, "::after")).toBe(true);
      await expect(category).toHaveCSS("outline-style", "none");
      await expect(category).toHaveCSS("box-shadow", "none");
      await reviewInteraction(
        page,
        category,
        `category-${width}-searched-escape`,
      );
      await category.click();
      // A locator click waits for stability; raw mouse input can race Radix's
      // deferred outside-click listener when the menu has just mounted.
      await page.locator("html").click({
        position: { x: width - 8, y: 100 },
      });
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expectPointerFocus(page, category);
      await expect.poll(() => focusUnderline(category, "::after")).toBe(false);
      await reviewInteraction(
        page,
        category,
        `category-${width}-pointer-outside`,
      );
      await movies.click();
      await expectPointerFocus(page, movies);
      await expect.poll(() => focusUnderline(movies, "::after")).toBe(false);
      await reviewInteraction(page, movies, `tab-${width}-pointer-selection`);
      await page.keyboard.press("Tab");
      await movies.focus();
      await expect.poll(() => focusUnderline(movies, "::after")).toBe(true);
    }
    await expect(movies).toHaveAttribute("aria-selected", "true");
  });
}

test("All movies automatically passes empty provider pages and preserves the cursor", async ({
  page,
}) => {
  const api = await mockApi(page, {
    browseResponse: async (params) => {
      const number = Number(params.get("page"));
      return {
        items: number < 6 ? [] : [movie],
        page: number,
        total: 100,
        hasMore: number < 6,
      };
    },
  });
  await page.goto("/?section=live");
  await navigateLibrary(page, "movie");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  expect(
    api.events
      .filter((event) => event.startsWith("BROWSE:"))
      .map((event) =>
        Number(new URLSearchParams(event.split("?")[1]).get("page")),
      ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("episode list can retry without starting a stream", async ({ page }) => {
  const api = await mockApi(page, { episodesFailureOnce: true });
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Episodes are temporarily unavailable" }),
  ).toBeVisible();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: "Retry episodes" }).click();
  await expect(page.getByRole("button", { name: /First Light/ })).toBeVisible();
  expect(
    api.events.filter((event) => event === "EPISODES").length,
  ).toBeGreaterThanOrEqual(2);
  expect(api.events).not.toContain("POST");
});

test("season selection chooses its episode before opening the watch workspace", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  const season = page.getByRole("combobox", { name: "Season" });
  await expect(season).toHaveText("Season 1");
  await season.click();
  await page.getByRole("option", { name: "Season 2" }).click();
  await expect(page.getByText("Selected · S2 E1 · Fresh Start")).toBeVisible();
  expect(api.sessionItemIds).toHaveLength(0);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual(["episode-3"]);
  await expect(page).toHaveURL(/view=player/);
  await expect(page).toHaveURL(/episode=episode-3/);
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await season.click();
  await page.getByRole("option", { name: "Season 1" }).click();
  await expect(page.getByRole("button", { name: /After Hours/ })).toBeVisible();
  expect(api.sessionItemIds).toEqual(["episode-3"]);
  await page.getByRole("button", { name: /After Hours/ }).click();
  await expect
    .poll(() => api.sessionItemIds)
    .toEqual(["episode-3", "episode-2"]);
  await expect(page).toHaveURL(/view=player/);
  await expect(page).toHaveURL(/item=series-1/);
  await expect(page).toHaveURL(/episode=episode-2/);
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop playback" })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", { name: "Forward 10 seconds" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      api.events
        .filter((value) => value === "POST" || value === "DELETE")
        .slice(0, 3),
    )
    .toEqual(["POST", "DELETE", "POST"]);
  await collapseTitle(page);
  await expect
    .poll(() => api.events.filter((value) => value === "DELETE").length)
    .toBe(2);
});

test("opening details allocates no stream and player Back and Forward release then restore playback once", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/?view=search&section=live&search=North");
  await page.getByRole("button", { name: "Open North News" }).click();
  const origin = page.url();
  await expect(page).toHaveURL(/item=live-1/);
  await expect(
    page.getByRole("heading", { name: "North News", level: 1 }),
  ).toBeVisible();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page).toHaveURL(/view=player/);
  await expect.poll(() => api.sessionItemIds).toEqual([live.id]);
  await expect(
    page.getByRole("region", { name: "Player", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(origin);
  await expect(
    page.getByRole("region", { name: "Expanded title" }),
  ).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await page.goForward();
  await expect(page).toHaveURL(/view=player/);
  await expect(
    page.getByRole("region", { name: "Player", exact: true }),
  ).toBeVisible();
  await expect.poll(() => api.sessionItemIds).toEqual([live.id, live.id]);
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(page).toHaveURL(origin);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(2);
});

test("live keyword search matches nonadjacent words and deep links resolve", async ({
  page,
}) => {
  const api = await mockApi(page, {
    catalogItems: [
      live,
      { ...live, id: "live-colors", name: "Colors India 4K", level: 1 },
    ],
  });
  await page.goto("/?section=live");
  await (await openSearch(page)).fill("colors 4k");
  await expect(
    page.getByRole("button", { name: "Open Colors India 4K" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open Colors India 4K" }).click();
  expect(api.events).not.toContain("POST");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Colors India 4K", level: 1 }),
  ).toBeVisible();
  expect(api.events).not.toContain("POST");
});

test("episode switch releases previous session before creating next", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/?section=live");
  await navigateLibrary(page, "series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: /First Light/ }).click();
  await expect(
    page
      .getByRole("button", { name: "Pause", exact: true })
      .or(page.getByRole("button", { name: "Play", exact: true })),
  ).toBeVisible();
  await navigatePlayer(page, series, episodes[1]);
  await expect(
    page
      .getByRole("complementary", { name: "Watch context", exact: true })
      .getByRole("button", { name: "Play After Hours", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "All streaming slots are in use." }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      api.events
        .filter((event) => ["POST", "DELETE"].includes(event))
        .slice(0, 3),
    )
    .toEqual(["POST", "DELETE", "POST"]);
});

test("rapid episode switch releases a late session response", async ({
  page,
}) => {
  const api = await mockApi(page, { createDelayMs: 300 });
  await page.goto("/?section=live");
  await navigateLibrary(page, "series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await page.getByRole("button", { name: /First Light/ }).click();
  await expect
    .poll(
      () =>
        api.events.filter((event) => ["POST", "DELETE"].includes(event)).length,
    )
    .toBe(1);
  await navigatePlayer(page, series, episodes[1]);
  await expect
    .poll(() =>
      api.events
        .filter((event) => ["POST", "DELETE"].includes(event))
        .slice(0, 3),
    )
    .toEqual(["POST", "DELETE", "POST"]);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "All streaming slots are in use." }),
  ).toHaveCount(0);
});

test("producer ended state keeps player available", async ({ page }) => {
  let preparing = true;
  await mockApi(page, {
    producerEnded: true,
    starting: () => preparing,
    initialSessionDuration: 130,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/?section=live");
  await navigateLibrary(page, "movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  const firstPoll = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/sessions/session-1",
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await firstPoll;
  preparing = false;
  await expect(page.locator(".watch-media-meta")).toContainText("Movie · 30m");
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(4500);
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Playback ended")).toHaveCount(0);
});

test("browse batches only the selected section and retries a failed page", async ({
  page,
}) => {
  let secondAttempts = 0;
  const api = await mockApi(page, {
    browseResponse: async (params) => {
      const pageNumber = Number(params.get("page"));
      if (pageNumber === 1)
        return { items: [movie], page: 1, total: 3, hasMore: true };
      secondAttempts++;
      if (secondAttempts === 1)
        return { error: "Provider is busy", status: 503 };
      return {
        items: [movie, { ...movie, id: "movie-2", name: "Quiet Harbor" }],
        page: 2,
        total: 3,
        hasMore: false,
      };
    },
  });
  await page.goto("/?section=live");
  expect(
    api.events.filter((event) => event.startsWith("BROWSE:")),
  ).toHaveLength(0);
  await navigateLibrary(page, "movie");
  await expect(
    page.getByRole("alert").filter({ hasText: "Provider is busy" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry page" }).click();
  await expect(
    page.getByRole("button", { name: "Open Quiet Harbor" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toHaveCount(1);
  expect(
    api.events.filter((event) => event.startsWith("BROWSE:")),
  ).toHaveLength(3);
});

test("global Search debounces every kind, streams groups and discards stale work at 1440px", async ({
  page,
}) => {
  const width = 1440;
  const cancelled: string[] = [];
  page.on("requestfailed", (request) => {
    if (
      new URL(request.url()).pathname === "/api/browse" &&
      request.failure()?.errorText.includes("ERR_ABORTED")
    )
      cancelled.push(request.url());
  });
  const releases = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  for (const query of ["North", "Night", "pending"])
    for (const kind of ["movie", "series"])
      gates.set(
        `${query}:${kind}`,
        new Promise((resolve) => releases.set(`${query}:${kind}`, resolve)),
      );
  const api = await mockApi(page, {
    browseResponse: async (params) => {
      const query = params.get("search")!;
      const kind = params.get("kind")!;
      await gates.get(`${query}:${kind}`);
      const base = kind === "movie" ? movie : series;
      return {
        items: [{ ...base, id: `${query}-${kind}`, name: `${query} ${kind}` }],
        page: 1,
        total: 1,
        hasMore: false,
      };
    },
  });
  const clockStart = Date.now();
  await page.clock.install({ time: clockStart });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/?section=live");
  const search = await openSearch(page);
  // Pause after navigation settles so action scheduling cannot consume the debounce.
  await page.clock.pauseAt(clockStart + 60_000);
  const requests = () =>
    api.events.filter((event) => event.startsWith("BROWSE:"));
  try {
    await expect(search).toHaveValue("");
    await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
    await search.fill(" N ");
    await page.clock.runFor(450);
    expect(requests()).toEqual([]);
    await expect(
      page.getByRole("region", { name: "Movies results", exact: true }),
    ).toHaveCount(0);
    await search.fill("discarded");
    await page.clock.runFor(100);
    await search.fill("  North  ");
    await page.clock.runFor(349);
    expect(requests()).toEqual([]);
    await page.clock.runFor(1);
    await expect.poll(() => requests().length).toBe(2);
    expect(
      requests()
        .map((event) => {
          const params = new URLSearchParams(event.slice("BROWSE:".length));
          return {
            kind: params.get("kind"),
            category: params.get("category"),
            page: params.get("page"),
            search: params.get("search"),
          };
        })
        .sort((a, b) => a.kind!.localeCompare(b.kind!)),
    ).toEqual([
      { kind: "movie", category: "*", page: "1", search: "North" },
      { kind: "series", category: "*", page: "1", search: "North" },
    ]);
    await page.clock.resume();
    await expect(
      page
        .getByRole("region", { name: "Live TV results", exact: true })
        .getByRole("button", { name: "Open North News", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Loading shows", exact: true }),
    ).toBeVisible();
    releases.get("North:movie")!();
    await expect(
      page
        .getByRole("region", { name: "Movies results", exact: true })
        .getByRole("button", { name: "Open North movie", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Loading shows", exact: true }),
    ).toBeVisible();
    await search.fill("Night");
    await expect(page.getByRole("button", { name: /^Open North/ })).toHaveCount(
      0,
    );
    await expect.poll(() => requests().length).toBe(4);
    await expect
      .poll(() =>
        cancelled.some((value) => {
          const params = new URL(value).searchParams;
          return (
            params.get("search") === "North" && params.get("kind") === "series"
          );
        }),
      )
      .toBe(true);
    releases.get("North:series")!();
    releases.get("Night:series")!();
    await expect(
      page.getByRole("button", { name: "Open Night series", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open North series", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("status", { name: "Loading movies", exact: true }),
    ).toBeVisible();
    await search.fill("");
    await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
    await expect
      .poll(() =>
        cancelled.some((value) => {
          const params = new URL(value).searchParams;
          return (
            params.get("search") === "Night" && params.get("kind") === "movie"
          );
        }),
      )
      .toBe(true);
    releases.get("Night:movie")!();
    await search.fill("pending");
    await expect.poll(() => requests().length).toBe(6);
    await navigateLibrary(page, "live");
    releases.get("pending:movie")!();
    releases.get("pending:series")!();
    await openSearch(page);
    await expect(search).toHaveValue("");
    await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
    await page.waitForTimeout(450);
    expect(requests()).toHaveLength(6);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  } finally {
    for (const release of releases.values()) release();
  }
});

test("global Search retries one failed group and scrolls through remaining pages", async ({
  page,
}) => {
  let movieAttempts = 0;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const api = await mockApi(page, {
    browseResponse: async (params) => {
      const kind = params.get("kind");
      const pageNumber = Number(params.get("page"));
      if (kind === "movie" && ++movieAttempts === 1)
        return { error: "Movie provider is busy", status: 503 };
      if (kind === "movie" && pageNumber === 1) {
        await retryGate;
        return { items: [], page: 1, total: 2, hasMore: true };
      }
      const base = kind === "movie" ? movie : series;
      return {
        items: [
          {
            ...base,
            id: `${kind}-${pageNumber}`,
            name: `${base.name} ${pageNumber}`,
          },
        ],
        page: pageNumber,
        total: 2,
        hasMore: pageNumber === 1,
      };
    },
  });
  await page.goto("/?view=search&search=North");
  const movies = page.getByRole("region", {
    name: "Movies results",
    exact: true,
  });
  const shows = page.getByRole("region", {
    name: "Shows results",
    exact: true,
  });
  await expect(movies.getByRole("alert")).toContainText(
    "Movie provider is busy",
  );
  await expect(
    shows.getByRole("button", { name: "Open Night Shift 1", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Live TV results", exact: true })
      .getByRole("button", { name: "Open North News", exact: true }),
  ).toBeVisible();
  const retry = movies.getByRole("button", {
    name: "Retry movies",
    exact: true,
  });
  try {
    await retry.click();
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toHaveText("Retrying…");
    await expect(retry).toBeFocused();
    await expect(movies.getByRole("alert")).toContainText(
      "Movie provider is busy",
    );
    await retry.evaluate((button) => button.click());
    expect(movieAttempts).toBe(2);
  } finally {
    releaseRetry();
  }
  await expect(
    shows.getByRole("button", { name: "Open Night Shift 2", exact: true }),
  ).toBeVisible();
  await expect(
    shows.getByRole("button", { name: "Open Night Shift 1", exact: true }),
  ).toBeVisible();
  await expect(
    movies.getByRole("button", { name: "Open The Quiet Coast 2", exact: true }),
  ).toBeVisible();
  expect(
    api.events
      .filter((event) => event.startsWith("BROWSE:"))
      .map((event) => new URLSearchParams(event.slice(7)).get("kind"))
      .sort(),
  ).toEqual(["movie", "movie", "movie", "series", "series"]);
});

test("search query and selected result survive navigation and browser back", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/?view=search&section=live&category=news&search=Night");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("section") === "series",
  );
  const origin = page.url();
  await navigateLibrary(page, "live");
  await expect(
    page.getByRole("region", { name: "Live TV library", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(origin);
  await expect(
    page.getByRole("searchbox", { name: "Search library", exact: true }),
  ).toHaveValue("Night");
  await expect(
    page.getByRole("region", { name: "Expanded title", exact: true }),
  ).toBeVisible();
});

test("mobile navigation and category filters remain accessible", async ({
  page,
}) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?section=live");
  await navigateLibrary(page, "movie");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await chooseCategory(page, "Drama");
  await expect(page).toHaveURL(/category=drama/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("titles expand beneath their row then playback leaves the library and survives player resizing", async ({
  page,
}) => {
  const movies = Array.from({ length: 12 }, (_, index) => ({
    ...movie,
    id: index === 0 ? movie.id : `inline-${index}`,
    name: index === 0 ? movie.name : `Inline film ${index}`,
  }));
  const api = await mockApi(page, { catalogItems: movies });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?section=movie");
  const tile = page.getByRole("button", { name: "Open The Quiet Coast" });
  await tile.click();
  await expect(tile).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".catalog-hero")).toHaveCount(0);
  await expect(page.locator(".site-header")).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Collapse details" }),
  ).toHaveCount(0);
  const panel = page.getByRole("region", { name: "Expanded title" });
  await expect(panel).toBeVisible();
  const tileElement = await tile.elementHandle();
  const bounds = await panel.evaluate((panelElement, tileElement) => {
    const tileBounds = tileElement.getBoundingClientRect();
    const panelBounds = panelElement.getBoundingClientRect();
    return {
      tileBottom: tileBounds.y + tileBounds.height,
      panelY: panelBounds.y,
    };
  }, tileElement!);
  expect(bounds.panelY).toBeGreaterThan(bounds.tileBottom - 1);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([movie.id]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await page.waitForTimeout(400);
  expect(api.sessionItemIds).toEqual([movie.id]);
  expect(api.events).not.toContain("DELETE");
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(panel).toBeVisible();
  await collapseTitle(page);
  await expect(panel).toHaveCount(0);
  await expect(tile).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => api.events.includes("DELETE")).toBe(true);
});

test("switching watch workspace routes waits for a late stream session to be released", async ({
  page,
}) => {
  const api = await mockApi(page, {
    createDelayMs: 600,
    catalogItems: [movie, { ...movie, id: "movie-other", name: "Other Film" }],
  });
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.events.includes("POST")).toBe(true);
  await navigatePlayer(page, {
    ...movie,
    id: "movie-other",
    name: "Other Film",
  });
  await expect
    .poll(() => api.sessionItemIds)
    .toEqual([movie.id, "movie-other"]);
  expect(
    api.events
      .filter((event) => event === "POST" || event === "DELETE")
      .slice(0, 3),
  ).toEqual(["POST", "DELETE", "POST"]);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "All streaming slots are in use." }),
  ).toHaveCount(0);
});

test("cached thumbnails reveal after repeated section switches and failed artwork falls back", async ({
  page,
}) => {
  const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="#752535"/></svg>')}`;
  await page.route("**/broken-poster.svg", (route) =>
    route.fulfill({ status: 404 }),
  );
  await mockApi(page, {
    catalogItems: [
      ...Array.from({ length: 12 }, (_, index) => ({
        ...movie,
        id: `cached-${index}`,
        name: `Cached film ${index}`,
        image,
      })),
      {
        ...movie,
        id: "broken",
        name: "Missing poster",
        image: "/broken-poster.svg",
      },
      { ...series, image },
    ],
  });
  await page.goto("/?section=movie");
  const checkTop = async () => {
    for (let index = 0; index < 4; index++)
      await expect(
        page.locator(".media-card .artwork-reveal").nth(index),
      ).toHaveClass(/is-revealed/);
  };
  await checkTop();
  for (let iteration = 0; iteration < 3; iteration++) {
    await navigateLibrary(page, "series");
    await expect(
      page
        .getByRole("button", { name: "Open Night Shift" })
        .locator(".artwork-reveal"),
    ).toHaveClass(/is-revealed/);
    await navigateLibrary(page, "movie");
    await checkTop();
  }
  const fallback = page.getByRole("button", { name: "Open Missing poster" });
  await fallback.scrollIntoViewIfNeeded();
  await expect(fallback.locator("img")).toHaveAttribute(
    "src",
    "/artwork-title.svg",
  );
  await expect(fallback.locator(".artwork-reveal")).toHaveClass(/is-revealed/);
});

test("channel details contain the full guide with a static cinema background", async ({
  page,
}) => {
  await mockApi(page, {
    refreshing: true,
    guidePrograms: [
      ...programs,
      {
        channelId: live.id,
        title: "Tomorrow Briefing",
        description: "Stories from across the city.",
        start: new Date(now + 10 * 3600000).toISOString(),
        end: new Date(now + 11 * 3600000).toISOString(),
      },
    ],
  });
  await page.goto("/?section=live");
  await expect(page.locator(".card-live-icon")).toHaveCount(1);
  await expect(page.locator(".header-status")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Programme guide", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(12, 13, 16)",
  );
  await page.getByRole("button", { name: "Open North News" }).click();
  const guide = page.getByRole("region", { name: "On this channel" });
  await expect(guide).toContainText("Tomorrow Briefing");
  await expect(guide).toContainText("Stories from across the city.");
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "/tmp/restream-guide-desktop.png",
      fullPage: false,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guide).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "/tmp/restream-guide-mobile.png",
      fullPage: false,
    });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(page.getByRole("region", { name: "Player" })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("visual review screenshots", async ({ page }) => {
  test.skip(
    !process.env.CAPTURE_SCREENSHOTS,
    "Set CAPTURE_SCREENSHOTS=1 for visual review",
  );
  const channelNames = [
    "North News",
    "World Report",
    "Metro Sports",
    "Cinema One",
    "The Documentary Channel",
    "Public Television",
    "Kids & Family",
    "International News Network",
    "Classic Film",
    "Nature Live",
    "Music Now",
    "Travel and Culture",
    "City Sports 2",
    "Late Night TV",
  ];
  const catalogItems = [
    ...channelNames.map((name, index) => ({
      id: index === 0 ? live.id : `live-${index + 1}`,
      kind: "live",
      name,
      category: ["News", "Sports", "Entertainment", "Documentary"][index % 4],
      number: String(index + 7),
    })),
    ...[
      "The Quiet Coast",
      "A Long Weekend in October",
      "Northern Lights",
      "The Last Station",
      "Open Water",
      "Before Sunrise",
      "Echoes of Tomorrow",
      "A Place to Return",
    ].map((name, index) => ({
      id: index === 0 ? movie.id : `movie-${index + 1}`,
      kind: "movie",
      name,
      category: ["Drama", "Adventure", "Mystery"][index % 3],
      description:
        index === 0 ? movie.description : "A story worth staying in for.",
    })),
    ...[
      "Night Shift",
      "The Long Road Home",
      "City Stories",
      "Northern Passage",
      "The Archive",
      "After the Storm",
    ].map((name, index) => ({
      id: index === 0 ? series.id : `series-${index + 1}`,
      kind: "series",
      name,
      category: ["Drama", "Crime", "Documentary"][index % 3],
    })),
  ];
  const guidePrograms = channelNames.flatMap((_name, index) => [
    {
      channelId: index === 0 ? live.id : `live-${index + 1}`,
      title: [
        "Morning Report",
        "The Daily Briefing",
        "A Closer Look at the World",
      ][index % 3],
      start: new Date(now - 60000).toISOString(),
      end: new Date(now + 3600000).toISOString(),
    },
    {
      channelId: index === 0 ? live.id : `live-${index + 1}`,
      title: ["City Desk", "Coming Up Next", "Evening Edition"][index % 3],
      start: new Date(now + 3600000).toISOString(),
      end: new Date(now + 7200000).toISOString(),
    },
  ]);
  await mockApi(page, {
    starting: true,
    refreshing: true,
    catalogItems,
    guidePrograms,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?section=live");
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/restream-desktop.png", fullPage: false });
  await navigateLibrary(page, "movie");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/restream-movies.png", fullPage: false });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "/tmp/restream-categories.png",
    fullPage: false,
  });
  await navigateLibrary(page, "live");
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(
    page.getByRole("heading", { name: "North News", level: 1 }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/restream-detail.png", fullPage: false });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await page.screenshot({ path: "/tmp/restream-player.png", fullPage: false });
  await collapseTitle(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/restream-mobile.png", fullPage: false });
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(
    page.getByRole("region", { name: "On this channel" }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "/tmp/restream-mobile-detail.png",
    fullPage: false,
  });
  await collapseTitle(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await chooseCategory(page, "Documentary");
  await expect(
    page.getByRole("button", { name: "Open Cinema One" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: "/tmp/restream-mobile-320.png",
    fullPage: false,
  });
});

test("channel schedule scrolls without a scrollbar and is restored after watching in the workspace", async ({
  page,
}) => {
  await mockApi(page, {
    guidePrograms: [
      ...programs,
      ...Array.from({ length: 12 }, (_, index) => ({
        channelId: live.id,
        title: `Later show ${index + 1}`,
        description: "The full schedule stays available on this channel.",
        start: new Date(now + (index + 2) * 3600000).toISOString(),
        end: new Date(now + (index + 3) * 3600000).toISOString(),
      })),
    ],
  });
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  const guide = page.getByRole("region", { name: "On this channel" });
  const schedule = guide.locator(".channel-schedule");
  await expect(guide).toBeVisible();
  await expect(
    guide.getByText("Morning Report", { exact: true }),
  ).toBeVisible();
  await expect(guide.locator("li")).toHaveCount(14);
  expect(
    await schedule.evaluate((element) => ({
      scrollable: element.scrollHeight > element.clientHeight,
      overflow: getComputedStyle(element).overflowY,
      scrollbar: getComputedStyle(element).scrollbarWidth,
    })),
  ).toEqual({ scrollable: true, overflow: "auto", scrollbar: "none" });
  await schedule.hover();
  await page.mouse.wheel(0, 1600);
  await expect
    .poll(() => schedule.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    guide.getByText("Later show 12", { exact: true }),
  ).toBeInViewport();
  await schedule.focus();
  await schedule.press("Home");
  await expect
    .poll(() => schedule.evaluate((element) => element.scrollTop))
    .toBe(0);
  await schedule.press("End");
  await expect(
    guide.getByText("Later show 12", { exact: true }),
  ).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guide).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Watch workspace", exact: true })
      .getByRole("region", { name: "On this channel", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Live TV library", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".controls-title, .player-meta")).toHaveCount(0);
  await expect(page.locator(".site-header")).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(guide).toBeVisible();
  await expect(guide.locator("li")).toHaveCount(14);
  await collapseTitle(page);
});

for (const item of [live, movie, series]) {
  test(`${item.kind} Search tiles keep descriptions in details and clear stale selection after playback`, async ({
    page,
  }) => {
    const selectedItem = { ...item, description: `Details for ${item.name}` };
    const otherItem = {
      ...item,
      id: `${item.kind}-search-result`,
      name: "Search result",
      description: "Other details",
    };
    const api = await mockApi(page, {
      catalogItems: [selectedItem, otherItem],
    });
    await page.goto(
      `/?view=search&section=${item.kind}&search=${encodeURIComponent(item.name)}`,
    );
    const tile = page.getByRole("button", { name: `Open ${item.name}` });
    await expect(tile.locator("h3")).toHaveText(item.name);
    await expect(tile.locator(".card-description")).toHaveCount(0);
    if (item.kind === "live")
      await expect(tile.locator(".card-programme")).toHaveText(
        "Morning Report",
      );
    else {
      await expect(tile.locator(".card-content h3")).toHaveText(item.name);
      await expect(tile.locator(".card-content")).toContainText(item.category);
    }
    await tile.click();
    await expect(page.locator(".title-description")).toHaveText(
      selectedItem.description,
    );
    await page
      .getByRole("button", {
        name: "Play",
        exact: true,
      })
      .click();
    await expect.poll(() => api.sessionItemIds).toHaveLength(1);
    const originalVideo = await page.locator("video").elementHandle();
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(1);
    const search = page.getByRole("searchbox", {
      name: "Search library",
      exact: true,
    });
    await search.fill("nothing here");
    await expect(tile).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Expanded title", exact: true }),
    ).toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.has("item"));
    await search.fill("Search result");
    await expect(
      page.getByRole("button", { name: "Open Search result", exact: true }),
    ).toBeVisible();
    await expect(tile).toHaveCount(0);
    expect(
      await originalVideo!.evaluate((element) => element.isConnected),
    ).toBe(false);
    expect(api.sessionItemIds).toHaveLength(1);
    expect(api.events.filter((event) => event === "DELETE")).toHaveLength(1);
    await expect(search).toBeFocused();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get("search") === "Search result" &&
        !url.searchParams.has("item"),
    );
  });
}

test("live tiles show only the current programme when the provider supplies one", async ({
  page,
}) => {
  const other = { ...live, id: "live-2", name: "World Report" };
  const unnamed = { ...live, id: "live-3", name: "Quiet Channel" };
  await mockApi(page, {
    catalogItems: [live, other, unnamed],
    guidePrograms: [
      ...programs,
      {
        channelId: other.id,
        title: "Earlier report",
        start: new Date(now - 7200000).toISOString(),
        end: new Date(now - 3600000).toISOString(),
      },
      {
        channelId: other.id,
        title: "Upcoming report",
        start: new Date(now + 3600000).toISOString(),
        end: new Date(now + 7200000).toISOString(),
      },
      {
        channelId: unnamed.id,
        title: "",
        start: new Date(now - 60000).toISOString(),
        end: new Date(now + 3600000).toISOString(),
      },
    ],
  });
  await page.goto("/?section=live");
  const current = page.getByRole("button", { name: "Open North News" });
  await expect(current.locator(".card-programme")).toHaveText("Morning Report");
  await expect(current).not.toContainText("City Desk");
  await expect(
    page
      .getByRole("button", { name: "Open World Report" })
      .locator(".card-programme"),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("button", { name: "Open Quiet Channel" })
      .locator(".card-programme"),
  ).toHaveCount(0);
});

test("channel details require Play again after leaving the watch workspace, including search", async ({
  page,
}) => {
  const other = { ...live, id: "live-2", name: "World Report" };
  const api = await mockApi(page, {
    catalogItems: [live, other],
    releaseDelayMs: 200,
  });
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Open World Report" }).click();
  await expect(
    page.getByRole("heading", { name: other.name, level: 1 }),
  ).toBeVisible();
  expect(api.sessionItemIds).toEqual([]);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([other.id]);
  await navigateLibrary(page, "live");
  await expect(page.locator("video")).toHaveCount(0);
  const search = await openSearch(page);
  await search.fill("North");
  await page.getByRole("button", { name: "Open North News" }).click();
  expect(api.sessionItemIds).toEqual([other.id]);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([other.id, live.id]);
  await expect(
    page.getByLabel(`${live.name} video`, { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/view=player/);
  expect(
    api.events
      .filter((event) => event === "POST" || event === "DELETE")
      .slice(0, 3),
  ).toEqual(["POST", "DELETE", "POST"]);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "All streaming slots are in use." }),
  ).toHaveCount(0);
  await collapseTitle(page);
  await search.fill("World");
  await page.getByRole("button", { name: "Open World Report" }).click();
  await expect(
    page.getByRole("heading", { name: other.name, level: 1 }),
  ).toBeVisible();
  expect(api.sessionItemIds).toHaveLength(2);
});

test("rapid channel changes skip an intermediate tune and wait for a late stream to release", async ({
  page,
}) => {
  const middle = { ...live, id: "live-2", name: "World Report" };
  const last = { ...live, id: "live-3", name: "Metro Sports" };
  let releaseInitial!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const api = await mockApi(page, {
    catalogItems: [live, middle, last],
    createGate,
    releaseDelayMs: 150,
  });
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([live.id]);
  await navigatePlayer(page, middle);
  await expect(
    page.getByLabel(`${middle.name} video`, { exact: true }),
  ).toBeVisible();
  const tuned = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/sessions") &&
      response.request().postDataJSON().itemId === last.id,
  );
  await navigatePlayer(page, last);
  releaseInitial();
  expect((await tuned).status()).toBe(201);
  expect(api.sessionItemIds).toEqual([live.id, last.id]);
  await expect(
    page.getByLabel(`${last.name} video`, { exact: true }),
  ).toBeVisible();
  expect(
    api.events
      .filter((event) => event === "POST" || event === "DELETE")
      .slice(0, 3),
  ).toEqual(["POST", "DELETE", "POST"]);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "All streaming slots are in use." }),
  ).toHaveCount(0);
});

test("library refresh discovers new series and episodes after leaving playback for Settings", async ({
  page,
}) => {
  let published = false;
  const newSeries = { ...series, id: "series-2", name: "Northern Lights" };
  const newEpisode = {
    ...episodes[2],
    id: "episode-4",
    episode: 2,
    name: "New Arrival",
  };
  const api = await mockApi(page, {
    refreshDelayMs: 200,
    browseResponse: async () => ({
      items: published ? [series, newSeries] : [series],
      page: 1,
      hasMore: false,
    }),
    episodeItems: () => (published ? [...episodes, newEpisode] : episodes),
  });
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await page.getByRole("combobox", { name: "Season" }).click();
  await page.getByRole("option", { name: "Season 2" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".primary-control")).toBeEnabled();
  await playableVideo(page);
  published = true;
  await openSettings(page);
  await expect(page.locator("video")).toHaveCount(0);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refreshed", exact: true }),
  ).toBeDisabled({ timeout: 8000 });
  expect(api.events).toContain("REFRESH:all");
  await navigateLibrary(page, "series");
  await expect(
    page.getByRole("button", { name: "Open Northern Lights" }),
  ).toBeVisible();
  const expanded = page.getByRole("region", {
    name: "Expanded title",
    exact: true,
  });
  if (!(await expanded.isVisible()))
    await page.getByRole("button", { name: "Open Night Shift" }).click();
  const season = page.getByRole("combobox", { name: "Season", exact: true });
  if ((await season.innerText()) !== "Season 2") {
    await season.click();
    await page.getByRole("option", { name: "Season 2", exact: true }).click();
  }
  await expect(
    page.locator(".episode-row").filter({ hasText: "New Arrival" }),
  ).toBeVisible();
  expect(api.sessionItemIds).toEqual([episodes[2].id]);
  await expect(page.locator("video")).toHaveCount(0);
});

test("Settings accordions support keyboard controls and retain independent drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1487, height: 1058 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const api = await mockApi(page, {
    providerEnvironment: ["portalUrl", "mac", "timezone", "deviceId"],
  });
  await page.goto("/?view=settings");
  const device = page.getByRole("button", {
    name: "Device identity",
    exact: true,
  });
  const playback = page.getByRole("button", {
    name: "Advanced playback",
    exact: true,
  });
  await expect(device).toHaveAttribute("aria-expanded", "false");
  await expect(playback).toHaveAttribute("aria-expanded", "false");
  await expect(
    device.getByText("Serial number and device IDs", { exact: true }),
  ).toBeVisible();
  await expect(
    playback.getByText("Video conversion settings", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/settings-design/settings-inputs-accordion-desktop-closed.png",
    });
  const restingDeviceBackground = await device.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await page.keyboard.press("Tab");
  await device.focus();
  await expect(device).not.toHaveCSS(
    "background-color",
    restingDeviceBackground,
  );
  await expect(device.locator('[data-slot="accordion-title"]')).toHaveCSS(
    "text-decoration-line",
    "underline",
  );
  await expect(device).toHaveCSS("outline-style", "none");
  await expect(device).toHaveCSS("box-shadow", "none");
  await page.keyboard.press("Enter");
  await expect(device).toBeFocused();
  await expect(device).toHaveAttribute("aria-expanded", "true");
  const panelId = await device.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  const devicePanel = page.locator(`[id="${panelId}"]`);
  await expect(devicePanel).toBeVisible();
  await expect
    .poll(() =>
      devicePanel.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    )
    .not.toBe("none");
  const serial = page.getByLabel("Serial number", { exact: true });
  const restingSerialShadow = await serial.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  await serial.click();
  await expect(serial).toHaveCSS("outline-style", "none");
  await expect(serial).toHaveCSS("box-shadow", restingSerialShadow);
  await serial.fill("accordion-draft-serial");
  await expect(page.getByLabel("Device ID", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Device ID", { exact: true })).toHaveValue("");
  await device.focus();
  await page.keyboard.press("Space");
  await expect(device).toHaveAttribute("aria-expanded", "false");
  await expect(serial).not.toBeVisible();
  await expect(device).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      devicePanel.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    )
    .toBe("none");
  await expect(serial).toHaveValue("accordion-draft-serial");
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/settings-design/settings-inputs-accordion-desktop-open.png",
    });
  await playback.focus();
  await page.keyboard.press("Space");
  await expect(playback).toHaveAttribute("aria-expanded", "true");
  await expect(playback).toBeFocused();
  const processing = page.getByRole("combobox", {
    name: "Playback processing",
    exact: true,
  });
  const restingProcessingShadow = await processing.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  await processing.click();
  await page.getByRole("option", { name: "Copy", exact: true }).click();
  await expect(processing).toBeFocused();
  await expect(processing).toHaveCSS("outline-style", "none");
  await expect(processing).toHaveCSS("box-shadow", restingProcessingShadow);
  await page.keyboard.press("Tab");
  await playback.focus();
  await page.keyboard.press("Enter");
  await expect(playback).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(processing).toContainText("Copy");
  expect(api.mutations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await device.click();
  await device.evaluate((element) =>
    window.scrollTo({
      top: window.scrollY + element.getBoundingClientRect().top - 110,
      behavior: "instant",
    }),
  );
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/settings-design/settings-inputs-accordion-390-closed.png",
    });
  await device.click();
  await expect(serial).toHaveValue("accordion-draft-serial");
  await expect(page.getByLabel("Device ID", { exact: true })).toBeDisabled();
  await device.evaluate((element) =>
    window.scrollTo({
      top: window.scrollY + element.getBoundingClientRect().top - 110,
      behavior: "instant",
    }),
  );
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/settings-design/settings-inputs-accordion-390-open.png",
    });
  for (const width of [1487, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await playback.click();
    await expectPointerFocus(page, playback);
    await expect(playback.locator('[data-slot="accordion-title"]')).toHaveCSS(
      "text-decoration-line",
      "none",
    );
    await expect(playback).toHaveAttribute("aria-expanded", "false");
    await expect(
      playback.getByText("Video conversion settings", { exact: true }),
    ).toBeVisible();
    await expect(processing).not.toBeVisible();
    if (process.env.CAPTURE_SCREENSHOTS) {
      await playback.evaluate((element) =>
        window.scrollTo({
          top: window.scrollY + element.getBoundingClientRect().top - 110,
          behavior: "instant",
        }),
      );
      await page.screenshot({
        path: `../output/settings-design/settings-advanced-playback-${width}-closed.png`,
      });
    }
    await playback.click();
    await expect(processing).toContainText("Copy");
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/settings-design/settings-advanced-playback-${width}-open.png`,
      });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  expect(api.mutations).toEqual([]);
});

test("Settings scroll navigation preserves drafts across sections and responsive layouts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1487, height: 1058 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const api = await mockApi(page, {
    providerEnvironment: ["portalUrl", "mac", "timezone"],
    guideHours: 6,
    preferences: {
      refreshIntervalSeconds: 86400,
      categories: [],
      configuration: { dashboardCategories: [], blockedCategories: [] },
    },
  });
  await page.goto("/?view=settings");
  await expect(
    page.getByLabel("Guide coverage in hours", { exact: true }),
  ).toHaveValue("6");
  await page.evaluate(() => document.fonts.ready);
  const navigation = page.getByRole("navigation", {
    name: "Settings sections",
    exact: true,
  });
  const active = (name: string) =>
    navigation.getByRole("link", { name, exact: true });
  await expect(active("Provider")).toHaveAttribute("aria-current", "location");
  const sectionChanges = await navigation.evaluateHandle((element) => {
    const visited: string[] = [];
    const observer = new MutationObserver(() => {
      const current = element
        .querySelector('[aria-current="location"]')
        ?.textContent?.trim();
      if (current && current !== visited.at(-1)) visited.push(current);
    });
    observer.observe(element, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current"],
    });
    return { visited, disconnect: () => observer.disconnect() };
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await active("About").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Math.ceil(window.scrollY + window.innerHeight) >=
          document.documentElement.scrollHeight - 2,
      ),
    )
    .toBe(true);
  await expect(active("About")).toHaveAttribute("aria-current", "location");
  expect(
    await sectionChanges.evaluate((trace) => {
      trace.disconnect();
      return trace.visited;
    }),
  ).toEqual(["About"]);
  await sectionChanges.dispose();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.mouse.wheel(0, -1);
  await expect(active("Provider")).toHaveAttribute("aria-current", "location");
  const settingsURL = page.url();
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/settings-design/settings-scroll-implemented-desktop.png",
    });
  await page.getByText("Device identity", { exact: true }).click();
  const serial = page.getByLabel("Serial number", { exact: true });
  await serial.fill("unsaved-provider-draft");
  const originalInput = await serial.elementHandle();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await active("Playback").click();
  await expectPointerFocus(page, active("Playback"));
  await page.keyboard.press("Tab");
  await active("Playback").focus();
  await expect(active("Playback")).toHaveCSS(
    "text-decoration-line",
    "underline",
  );
  await expect(active("Playback")).toHaveAttribute("aria-current", "location");
  await expect(page.locator("#settings-playback")).toBeInViewport();
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .click();
  await expect(active("Playback")).toHaveAttribute("aria-current", "location");
  await page.keyboard.press("ArrowUp");
  await expect(active("Playback")).toHaveAttribute("aria-current", "location");
  await active("Status").click();
  await expect(active("Status")).toHaveAttribute("aria-current", "location");
  await expect(page.locator("#settings-status")).toBeInViewport();
  await page.mouse.wheel(0, 10000);
  await expect(active("About")).toHaveAttribute("aria-current", "location");
  await page
    .locator("#settings-library")
    .evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await expect(active("Library & guide")).toHaveAttribute(
    "aria-current",
    "location",
  );
  await page.mouse.wheel(0, -10000);
  await expect(active("Provider")).toHaveAttribute("aria-current", "location");
  await expect(serial).toHaveValue("unsaved-provider-draft");
  expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  for (const section of [
    "provider",
    "library",
    "discovery",
    "playback",
    "subtitles",
    "status",
    "about",
  ])
    await expect(page.locator(`#settings-${section}`)).toBeAttached();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const jump = page.getByRole("combobox", {
    name: "Jump to section",
    exact: true,
  });
  await expect(jump).toBeVisible();
  await jump.click();
  await page.getByRole("option", { name: "Status", exact: true }).click();
  await expect(jump).toContainText("Status");
  await expect(page.locator("#settings-status")).toBeInViewport();
  await jump.click();
  await page.getByRole("option", { name: "About", exact: true }).click();
  await expect(jump).toContainText("About");
  await expect(page.locator("#settings-about")).toBeInViewport();
  await jump.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("option", { name: "Library & guide", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(jump).toContainText("Library & guide");
  await expect(page.locator("#settings-library")).toBeInViewport();
  await page.mouse.wheel(0, 10000);
  await expect(jump).toContainText("About");
  await page.mouse.wheel(0, -10000);
  await expect(jump).toContainText("Provider");
  await expect(serial).toHaveValue("unsaved-provider-draft");
  expect(page.url()).toBe(settingsURL);
  expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await page.getByText("Device identity", { exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect(jump).toContainText("Provider");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/settings-design/settings-scroll-implemented-${width}.png`,
      });
  }
  const tokenLink = page.locator(".settings-inline-link");
  await page.keyboard.press("Tab");
  await tokenLink.focus();
  await expect(tokenLink).toHaveCSS("text-decoration-line", "underline");
  await expect(tokenLink).toHaveCSS("outline-style", "none");
  expect(api.mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test("Settings actions support keyboard submission and prevent duplicate pending requests", async ({
  page,
}) => {
  let releaseSave!: () => void;
  const settingsSaveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const api = await mockApi(page, { settingsSaveGate, refreshDelayMs: 1000 });
  await page.goto("/?view=settings");
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .fill("2");
  await save.focus();
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  try {
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(save).toContainText("Saving");
    await expect(
      page.getByRole("button", { name: "Discard changes", exact: true }),
    ).toBeDisabled();
    for (const label of [
      "Portal URL",
      "Guide coverage in hours",
      "Maximum simultaneous streams",
      "TMDB read access token",
    ]) {
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    }
    await expect(page.locator("#settings-form > fieldset")).toHaveAttribute(
      "inert",
      "",
    );
    await page.keyboard.press("Enter");
    await expect
      .poll(
        () =>
          api.mutations.filter((request) => request.path === "/api/settings")
            .length,
      )
      .toBe(1);
  } finally {
    releaseSave();
  }
  await expect(page.locator(".settings-save-bar")).toHaveCount(0);
  await expect(save).toHaveCount(0);
  expect(api.effectiveSettings().playback.maxStreams).toBe(2);
  const refresh = page.getByRole("button", {
    name: /^(Refresh now|Refreshing…|Refreshed)$/,
  });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(refresh).toHaveAccessibleName("Refreshing…");
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toHaveAccessibleName("Refreshed", { timeout: 8000 });
  expect(api.events.filter((event) => event === "REFRESH:all")).toHaveLength(1);
});

test("Settings saves modified sections together and restores saved values", async ({
  page,
}) => {
  const api = await mockApi(page, { guideHours: 6 });
  await page.goto("/?view=settings");
  await expect(
    page.getByLabel("Guide coverage in hours", { exact: true }),
  ).toHaveValue("6");
  await expect(
    page.getByText(/The guide normally updates every 4 hours/),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  const discard = page.getByRole("button", {
    name: "Discard changes",
    exact: true,
  });
  await expect(
    page.getByLabel("Maximum simultaneous streams", { exact: true }),
  ).toHaveValue("1");
  await expect(save).toHaveCount(0);
  await expect(discard).toHaveCount(0);
  await expect(page.locator(".settings-save-bar")).toHaveCount(0);
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .fill("2");
  await expect(save).toBeEnabled();
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .fill("1");
  await expect(save).toHaveCount(0);
  await expect(discard).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Refresh every", exact: true })
    .click();
  await page.getByRole("option", { name: "1 day", exact: true }).click();
  await page.getByLabel("Guide coverage in hours", { exact: true }).fill("24");
  await page
    .locator('[data-slot="label"]')
    .filter({ hasText: /^Home categories$/ })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Home categories", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("option", { name: "Drama", exact: true })
    .first()
    .click();
  await page.keyboard.press("Escape");
  await page
    .getByRole("combobox", { name: "Blocked categories", exact: true })
    .click();
  await page.getByRole("option", { name: "Documentary", exact: true }).click();
  await page.keyboard.press("Escape");
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .fill("3");
  await page.getByText("Advanced playback", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Playback processing", exact: true })
    .click();
  await page.getByRole("option", { name: "Copy", exact: true }).click();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await save.click();
  await expect(page.locator(".settings-save-bar")).toHaveCount(0);
  expect(api.settingsPatches).toEqual([
    {
      library: {
        refreshIntervalSeconds: 86400,
        guideHours: 24,
        dashboardCategories: ["movie:drama-movie"],
        blockedCategories: ["live:documentary"],
      },
      playback: { maxStreams: 3, transcodeMode: "copy" },
    },
  ]);
  expect(api.providerPatches).toEqual([]);
  await expect(save).toHaveCount(0);
  await expect(discard).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByLabel("Maximum simultaneous streams", { exact: true }),
  ).toHaveValue("3");
  await expect(
    page.getByLabel("Guide coverage in hours", { exact: true }),
  ).toHaveValue("24");
  await page.getByText("Advanced playback", { exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Playback processing", exact: true }),
  ).toContainText("Copy");
  await expect(
    page.getByRole("button", {
      name: "Remove Drama from Home categories",
      exact: true,
    }),
  ).toBeVisible();
  expect(api.mutations).toEqual([{ method: "PATCH", path: "/api/settings" }]);
});

test("Settings discards all drafts without saving and preserves drafts during refresh at 390px", async ({
  page,
}) => {
  const width = 390;
  await page.setViewportSize({ width, height: 900 });
  const api = await mockApi(page, { refreshDelayMs: 500 });
  await page.goto("/?view=settings");
  await expect(
    page.getByText(/The guide normally updates every 4 hours/),
  ).toBeVisible();
  await page.getByLabel("Timezone", { exact: true }).fill("Europe/London");
  await page.getByLabel("Guide coverage in hours", { exact: true }).fill("24");
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .fill("3");
  await page
    .getByLabel("TMDB read access token", { exact: true })
    .fill("discarded-token");
  const refresh = page
    .locator("#settings-status")
    .getByRole("button", { name: /^(Refresh now|Refreshing…|Refreshed)$/ });
  await refresh.click();
  await expect(refresh).toHaveAccessibleName("Refreshed", { timeout: 8000 });
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue(
    "Europe/London",
  );
  await expect(
    page.getByLabel("Guide coverage in hours", { exact: true }),
  ).toHaveValue("24");
  await expect(
    page.getByLabel("Maximum simultaneous streams", { exact: true }),
  ).toHaveValue("3");
  await expect(
    page.getByLabel("TMDB read access token", { exact: true }),
  ).toHaveValue("discarded-token");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue(
    "America/Toronto",
  );
  await expect(
    page.getByLabel("Guide coverage in hours", { exact: true }),
  ).toHaveValue("48");
  await expect(
    page.getByLabel("Maximum simultaneous streams", { exact: true }),
  ).toHaveValue("1");
  await expect(
    page.getByLabel("TMDB read access token", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
  expect(api.settingsPatches).toEqual([]);
  expect(api.mutations).toEqual([{ method: "POST", path: "/api/refresh" }]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
});

test("Settings preserves and removes unavailable category rules on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await mockApi(page, {
    preferences: {
      refreshIntervalSeconds: 86400,
      categories: [],
      configuration: {
        dashboardCategories: ["movie:Archived category with a long name"],
        blockedCategories: [],
      },
    },
  });
  await page.goto("/?view=settings");
  await page
    .getByRole("button", {
      name: "Remove movie:Archived category with a long name from Home categories",
      exact: true,
    })
    .click();
  await page
    .getByRole("combobox", { name: "Blocked categories", exact: true })
    .fill("Documentary");
  await expect(
    page.getByRole("option", { name: "Documentary", exact: true }),
  ).toBeVisible();
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "/tmp/restream-settings-categories-390.png",
      fullPage: true,
    });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => api.effectiveSettings().library.dashboardCategories)
    .toEqual([]);
  expect(api.effectiveSettings().library.blockedCategories).toEqual([
    "live:documentary",
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("Settings edits remaining provider fields with environment overrides at 390px", async ({
  page,
}) => {
  const width = 390;
  await page.setViewportSize({ width, height: 900 });
  const managed = ["portalUrl", "mac", "timezone"] as const;
  const api = await mockApi(page, { providerEnvironment: [...managed] });
  await page.goto("/?view=settings");
  for (const label of ["Portal URL", "MAC address", "Timezone"]) {
    const input = page.getByLabel(label, { exact: true });
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute(
      "placeholder",
      "Managed by environment",
    );
    await expect(input).toHaveAccessibleDescription("Managed by environment");
  }
  await page.getByText("Device identity", { exact: true }).click();
  await page
    .getByLabel("Serial number", { exact: true })
    .fill("app-managed-serial");
  await page
    .getByLabel("Device ID", { exact: true })
    .fill("app-managed-device");
  await page
    .getByLabel("Secondary device ID", { exact: true })
    .fill("app-managed-device-two");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => api.providerPatches.length).toBe(1);
  expect(api.providerPatches[0]).toEqual({
    serialNumber: "app-managed-serial",
    deviceId: "app-managed-device",
    deviceId2: "app-managed-device-two",
  });
  await expect(page.locator(".settings-save-bar")).toHaveCount(0);
  await page.reload();
  await page.getByText("Device identity", { exact: true }).click();
  await expect(page.getByLabel("Serial number", { exact: true })).toHaveValue(
    "app-managed-serial",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: `/tmp/restream-settings-env-mixed-${width}.png`,
      fullPage: true,
    });
});

test("Settings locks a fully environment-managed provider and still saves playback at 390px", async ({
  page,
}) => {
  const width = 390;
  await page.setViewportSize({ width, height: 900 });
  const api = await mockApi(page, {
    providerEnvironment: [
      "portalUrl",
      "mac",
      "timezone",
      "serialNumber",
      "deviceId",
      "deviceId2",
    ],
  });
  await page.goto("/?view=settings");
  await page.getByText("Device identity", { exact: true }).click();
  for (const label of [
    "Portal URL",
    "MAC address",
    "Timezone",
    "Serial number",
    "Device ID",
    "Secondary device ID",
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute(
      "placeholder",
      "Managed by environment",
    );
  }
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .fill("2");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => api.effectiveSettings().playback.maxStreams).toBe(2);
  expect(api.providerPatches).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: `/tmp/restream-settings-env-full-${width}.png`,
      fullPage: true,
    });
});

test("Settings completes provider setup when only the portal URL is managed by environment", async ({
  page,
}) => {
  const api = await mockApi(page, {
    unconfigured: true,
    providerEnvironment: ["portalUrl"],
  });
  await page.goto("/?view=settings");
  await expect(page.getByLabel("Portal URL", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("MAC address", { exact: true })
    .fill("00:11:22:33:44:55");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => api.providerPatches.length).toBe(1);
  expect(api.providerPatches[0]).not.toHaveProperty("portalUrl");
  expect(api.providerPatches[0]).toHaveProperty("mac", "00:11:22:33:44:55");
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeEnabled();
});

for (const width of [1440, 390, 320]) {
  test(`Settings shows managed fields and a saved token inside inputs at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await mockApi(page, {
      providerEnvironment: [
        "portalUrl",
        "mac",
        "timezone",
        "serialNumber",
        "deviceId",
        "deviceId2",
      ],
      tmdbTokenConfigured: true,
    });
    await page.goto("/?view=settings");
    for (const label of ["Portal URL", "MAC address", "Timezone"]) {
      const input = page.getByLabel(label, { exact: true });
      await expect(input).toHaveAttribute(
        "placeholder",
        "Managed by environment",
      );
      await expect(input).toHaveCSS("opacity", "1");
      await expect(input).toBeDisabled();
      await expect(input).toHaveValue("");
      await expect(input).toHaveAccessibleDescription("Managed by environment");
    }
    if (process.env.CAPTURE_SCREENSHOTS) {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `/tmp/restream-managed-inputs-${width}.png`,
      });
    }
    await page.getByText("Device identity", { exact: true }).click();
    for (const label of ["Serial number", "Device ID", "Secondary device ID"]) {
      await expect(page.getByLabel(label, { exact: true })).toHaveAttribute(
        "placeholder",
        "Managed by environment",
      );
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    }

    const token = page.getByLabel("TMDB read access token", { exact: true });
    await expect(token).toHaveValue("");
    await expect(token).toHaveAttribute(
      "placeholder",
      "•••••••• — Token saved",
    );
    await expect(token).toHaveAccessibleDescription(
      "Enter a new token to replace the saved one.",
    );
    await expect(page.locator(".settings-save-bar")).toHaveCount(0);
    await page.locator("#settings-discovery").scrollIntoViewIfNeeded();
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({ path: `/tmp/restream-saved-token-${width}.png` });

    // The visible mask is never a draft value or part of an unrelated save.
    await page
      .getByLabel("Maximum simultaneous streams", { exact: true })
      .fill("2");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.locator(".settings-save-bar")).toHaveCount(0);
    expect(api.settingsPatches).toEqual([
      { playback: { maxStreams: 2, transcodeMode: "auto" } },
    ]);
    await expect(token).toHaveAttribute(
      "placeholder",
      "•••••••• — Token saved",
    );

    await page
      .getByRole("button", { name: "Remove token", exact: true })
      .click();
    await expect(token).toHaveAttribute("placeholder", "Token will be removed");
    await page.getByRole("button", { name: "Keep token", exact: true }).click();
    await expect(token).toHaveAttribute(
      "placeholder",
      "•••••••• — Token saved",
    );
    await expect(page.locator(".settings-save-bar")).toHaveCount(0);

    await token.fill("replacement-test-token");
    await token.fill("");
    await expect(page.locator(".settings-save-bar")).toHaveCount(0);
    await token.fill("replacement-test-token");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(token).toHaveValue("");
    await expect(token).toHaveAttribute(
      "placeholder",
      "•••••••• — Token saved",
    );
    expect(api.settingsPatches.at(-1)).toEqual({
      discovery: { tmdbReadAccessToken: "replacement-test-token" },
    });
    await page.reload();
    await expect(token).toHaveValue("");
    await expect(token).toHaveAttribute(
      "placeholder",
      "•••••••• — Token saved",
    );
    expect(await page.locator("body").innerText()).not.toContain(
      "replacement-test-token",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

test("Settings keeps failed drafts and masks, retains and clears the TMDB token", async ({
  page,
}) => {
  let fail = true;
  const api = await mockApi(page, { settingsSaveFailure: () => fail });
  await page.goto("/?view=settings");
  const token = page.getByLabel("TMDB read access token", { exact: true });
  await expect(token).toHaveAttribute("type", "password");
  await expect(token).toHaveAttribute(
    "placeholder",
    "Enter a TMDB read access token",
  );
  await token.fill("example-browser-test-token");
  await page.getByLabel("Timezone", { exact: true }).fill("Europe/London");
  await page.getByLabel("Guide coverage in hours", { exact: true }).fill("24");
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .fill("3");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Settings could not be saved" }),
  ).toBeVisible();
  await expect(token).toHaveValue("example-browser-test-token");
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue(
    "Europe/London",
  );
  await expect(
    page.getByLabel("Guide coverage in hours", { exact: true }),
  ).toHaveValue("24");
  await expect(
    page.getByLabel("Maximum simultaneous streams", { exact: true }),
  ).toHaveValue("3");
  expect(api.effectiveSettings().playback.maxStreams).toBe(1);
  expect(api.effectiveSettings().discovery.tmdbTokenConfigured).toBe(false);
  fail = false;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => api.effectiveSettings().discovery.tmdbTokenConfigured)
    .toBe(true);
  await expect(token).toHaveValue("");
  await expect(token).toHaveAttribute("placeholder", "•••••••• — Token saved");
  expect(Object.keys(api.settingsPatches[1]).sort()).toEqual([
    "discovery",
    "library",
    "playback",
    "provider",
  ]);
  expect(api.settingsPatches[1]).toEqual(api.settingsPatches[0]);
  await page.reload();
  await expect(token).toHaveValue("");
  expect(await page.locator("body").innerText()).not.toContain(
    "example-browser-test-token",
  );
  await page.getByRole("button", { name: "Remove token", exact: true }).click();
  await expect(
    page.getByText("Token will be removed when you save.", { exact: true }),
  ).toBeVisible();
  await expect(token).toHaveAttribute("placeholder", "Token will be removed");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  expect(api.effectiveSettings().discovery.tmdbTokenConfigured).toBe(true);
  await expect(token).toHaveAttribute("placeholder", "•••••••• — Token saved");
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Maximum simultaneous streams", { exact: true })
    .fill("2");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".settings-save-bar")).toHaveCount(0);
  expect(api.settingsPatches.at(-1)).toEqual({
    playback: { maxStreams: 2, transcodeMode: "auto" },
  });
  expect(api.effectiveSettings().discovery.tmdbTokenConfigured).toBe(true);
  await page.getByRole("button", { name: "Remove token", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => api.effectiveSettings().discovery.tmdbTokenConfigured)
    .toBe(false);
  await expect(token).toHaveAttribute(
    "placeholder",
    "Enter a TMDB read access token",
  );
});

test("Settings releases playback and refreshes metadata without changing saved configuration", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  const api = await mockApi(page, { refreshDelayMs: 1500 });
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".primary-control")).toBeEnabled();
  await playableVideo(page);
  const originalVideo = await page.locator("video").elementHandle();
  await openSettings(page);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  expect(await originalVideo!.evaluate((element) => element.isConnected)).toBe(
    false,
  );
  await expect(page.locator(".site-header").getByRole("searchbox")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("combobox", { name: "Refresh every", exact: true }),
  ).toContainText("6 hours");
  const configuration = api.effectivePreferences();
  const refresh = page.getByRole("button", {
    name: /^(Refresh now|Refreshing…|Refreshed)$/,
  });
  await refresh.click();
  await expect
    .poll(() => api.events.filter((event) => event.startsWith("REFRESH:")))
    .toEqual(["REFRESH:all"]);
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAccessibleName("Refreshing…");
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toHaveAccessibleName("Refreshed", { timeout: 8000 });
  await expect(refresh).toBeEnabled({ timeout: 8000 });
  expect(api.effectivePreferences()).toEqual(configuration);
  expect(
    api.mutations.filter((request) => request.path === "/api/preferences"),
  ).toEqual([]);
  await expect(page.locator("video")).toHaveCount(0);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/environment-review/settings-desktop.png",
      fullPage: false,
    });
  await page.goBack();
  await expect(page).toHaveURL(/view=player/);
  await expect(page.locator("video")).toBeVisible();
  await expect.poll(() => api.sessionItemIds).toEqual([live.id, live.id]);
});

test("Settings reports configuration and refresh failures and respects provider cooldowns", async ({
  page,
}) => {
  let configurationUnavailable = true;
  const api = await mockApi(page, {
    refreshFailure: true,
    preferencesFailure: () => configurationUnavailable,
  });
  await page.goto("/?view=settings");
  await expect(
    page.getByRole("alert").filter({ hasText: "Settings unavailable." }),
  ).toBeVisible();
  configurationUnavailable = false;
  await page
    .getByRole("button", { name: "Retry settings", exact: true })
    .click();
  await expect(page.getByLabel("Portal URL", { exact: true })).toHaveValue(
    "http://provider.example",
  );
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Refresh is temporarily unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeEnabled();
  expect(api.mutations).toEqual([{ method: "POST", path: "/api/refresh" }]);
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 503, json: { error: "Server unavailable" } }),
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Server unavailable." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeDisabled();
  await page.unrouteAll({ behavior: "wait" });
  await mockApi(page, { cooldown: true });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeDisabled();
});

test("Settings first-run setup protects every route and fits responsive layouts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await mockApi(page, { unconfigured: true });
  const notice = page.getByRole("status", {
    name: "Provider setup",
    exact: true,
  });
  async function expectSetupNotice(width: number) {
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(
      "Connect your provider to start watching.",
    );
    await expect(
      page.getByText("Provider not configured", { exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  // Route guards share one notice; exercise each route once, then resize the
  // mounted notice to cover both mobile widths without repeating registration.
  for (const [name, url] of [
    ["home", "/"],
    ["live", "/?section=live"],
    ["movies", "/?section=movie"],
    ["shows", "/?section=series"],
    ["search", "/?view=search&search=North"],
    ["player", "/?view=player&section=movie&item=movie-1"],
  ]) {
    await page.goto(url);
    await expectSetupNotice(1440);
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/provider-setup/${name}-1440.png`,
      });
    if (name === "player") {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expectSetupNotice(width);
        if (process.env.CAPTURE_SCREENSHOTS)
          await page.screenshot({
            path: `../output/provider-setup/${name}-${width}.png`,
          });
      }
    }
    await notice
      .getByRole("button", { name: "Open settings", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(notice).toHaveCount(0);
  }
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Portal URL", { exact: true })
    .fill("http://new-provider.example");
  await page
    .getByLabel("MAC address", { exact: true })
    .fill("00:11:22:33:44:55");
  await page.getByLabel("Timezone", { exact: true }).fill("UTC");
  await page.getByText("Device identity", { exact: true }).click();
  await page
    .getByLabel("Serial number", { exact: true })
    .fill("registered-serial");
  await page.getByLabel("Device ID", { exact: true }).fill("registered-device");
  await page
    .getByLabel("Secondary device ID", { exact: true })
    .fill("registered-device-two");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => api.effectiveSettings().provider.portalUrl)
    .toBe("http://new-provider.example");
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await page.getByText("Device identity", { exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, value] of [
      ["Portal URL", "http://new-provider.example"],
      ["Serial number", "registered-serial"],
      ["Device ID", "registered-device"],
      ["Secondary device ID", "registered-device-two"],
    ])
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `/tmp/restream-settings-editable-${width}.png`,
        fullPage: true,
      });
  }
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const navigation = page.getByRole("navigation", {
      name: width <= 820 ? "Primary navigation" : "Library",
      exact: true,
    });
    await navigation.getByRole("button", { name: "Home", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Home", exact: true }),
    ).toBeVisible();
    await expect(notice).toHaveCount(0);
  }
});

test("native HLS plays and seeks locally without loading the decoder or worker", async ({
  page,
}) => {
  await mockApi(page);
  const decoderRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/hls(?:[.-])/.test(new URL(request.url()).pathname))
      decoderRequests.push(request.url());
  });
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  expect(decoderRequests).toEqual([]);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    /\/api\/streams\/session-1\/0\/index\.m3u8$/,
  );
  await playableVideo(page);
  const video = page.locator("video");
  const source = await video.getAttribute("src");
  let serverSeeks = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/seek")) serverSeeks++;
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const slider = page.getByRole("slider", { name: "Seek position" });
  await slider.press("ArrowRight");
  await expect(video).toHaveJSProperty("currentTime", 31);
  // Some native decoders expose buffered media before a seekable range.
  await video.evaluate((element) => {
    Object.defineProperties(element, {
      seekable: {
        configurable: true,
        get: () => ({ length: 0 }),
      },
      buffered: {
        configurable: true,
        get: () => ({ length: 1, start: () => 0, end: () => 100 }),
      },
    });
  });
  await slider.press("ArrowRight");
  await expect(video).toHaveJSProperty("currentTime", 32);
  await expect(video).toHaveJSProperty("paused", true);
  await expect(video).toHaveAttribute("src", source!);
  expect(serverSeeks).toBe(0);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(page.locator("video")).toHaveCount(0);
  expect(decoderRequests).toEqual([]);
});

test("server seek polls readiness immediately and preserves an explicit pause", async ({
  page,
}) => {
  await mockApi(page);
  let seekFinished = 0;
  let readinessDelay: number | undefined;
  const url = "/api/streams/session-1/1/index.m3u8";
  await page.route("**/api/sessions/session-1/seek", async (route) => {
    seekFinished = Date.now();
    await route.fulfill({
      json: {
        id: "session-1",
        url,
        state: "starting",
        duration: 1800,
        offset: 100,
      },
    });
  });
  await page.route("**/api/sessions/session-1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (seekFinished) readinessDelay = Date.now() - seekFinished;
    await route.fulfill({
      json: {
        id: "session-1",
        url: seekFinished ? url : "/api/streams/session-1/0/index.m3u8",
        state: "ready",
        duration: 1800,
        offset: seekFinished ? 100 : 0,
      },
    });
  });
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  const firstPoll = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sessions/session-1") &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await firstPoll;
  await playableVideo(page);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const timeline = page.locator(".timeline");
  const bounds = await timeline.boundingBox();
  expect(bounds).not.toBeNull();
  await timeline.click({
    position: { x: bounds!.width * 0.9, y: bounds!.height / 2 },
  });
  await expect(page.locator("video")).toHaveAttribute("src", url);
  expect(readinessDelay).toBeDefined();
  expect(readinessDelay!).toBeLessThan(1000);
  await page
    .locator("video")
    .evaluate((video) => video.dispatchEvent(new Event("canplay")));
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).paused),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).paused),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Stop playback" }).click();
});

test("HLS.js is preferred even when the browser advertises native HLS", async ({
  page,
}) => {
  const api = await mockApi(page, { mediaSource: true });
  await page.route("**/api/streams/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body: "invalid manifest",
    }),
  );
  const decoderRequests: string[] = [];
  const manifestRequests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/hls-[^/]+\.js$/.test(new URL(request.url()).pathname))
      decoderRequests.push(request.url());
    if (request.url().endsWith("/index.m3u8"))
      manifestRequests.push(request.resourceType());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  // The invalid fixture reaches HLS.js without a failed native media request.
  await expect(page.getByRole("alert")).toContainText("Playback stopped");
  expect(decoderRequests).toHaveLength(1);
  expect(manifestRequests).toEqual(["xhr"]);
  expect(api.events.filter((event) => event === "POST")).toHaveLength(1);
  await expect
    .poll(() =>
      page.locator("video").evaluate((video) => ({
        paused: (video as HTMLVideoElement).paused,
        source: video.getAttribute("src"),
      })),
    )
    .toEqual({ paused: true, source: null });
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(page.locator("video")).toHaveCount(0);
  expect(api.events.filter((event) => event === "DELETE")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("closing while the HLS decoder downloads prevents a late media attachment", async ({
  page,
}) => {
  const api = await mockApi(page, { nativeHls: false });
  let finishDownload!: () => void;
  const downloadHeld = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });
  let decoderRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    decoderRequested = resolve;
  });
  let manifests = 0;
  const workers: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".m3u8")) manifests++;
  });
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.route(/\/assets\/hls-[^/]+\.js$/, async (route) => {
    decoderRequested();
    await downloadHeld;
    await route.continue();
  });
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await requested;
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(page.locator("video")).toHaveCount(0);
  const downloadFinished = page.waitForResponse(/\/assets\/hls-[^/]+\.js$/);
  finishDownload();
  await downloadFinished;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(manifests).toBe(0);
  expect(workers).toEqual([]);
  expect(api.events.filter((event) => event === "DELETE")).toHaveLength(1);
});

test("season episodes load on demand and returning shows cached results while checking the backend", async ({
  page,
}) => {
  const api = await mockApi(page);
  const requested: string[] = [];
  await page.route("**/api/series/series-1/episodes?*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("season")!;
    requested.push(query);
    const season = query === "first" ? 1 : Number(query);
    if (season === 2) await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: episodes.filter((episode) => (episode.season ?? 1) === season),
        season,
        seasons: [1, 2],
      }),
    });
  });
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await expect(page.getByRole("button", { name: /First Light/ })).toBeVisible();
  expect(requested).toEqual(["first"]);
  const selector = page.getByRole("combobox", { name: "Season" });
  await selector.click();
  await page.getByRole("option", { name: "Season 2" }).click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: /Fresh Start/ })).toBeVisible();
  expect(requested).toEqual(["first", "2"]);
  await selector.click();
  await page.getByRole("option", { name: "Season 1" }).click();
  await expect(page.getByRole("button", { name: /First Light/ })).toBeVisible();
  await expect.poll(() => requested).toEqual(["first", "2", "1"]);
  expect(api.events).not.toContain("POST");
});

test("open episode details respect freshness and paused retries at 1280px", async ({
  page,
}) => {
  const viewport = { width: 1280, height: 900 };
  await page.setViewportSize(viewport);
  await page.clock.install();
  const api = await mockApi(page);
  let calls = 0;
  await page.route("**/api/series/series-1/episodes?*", async (route) => {
    calls++;
    await route.fulfill({
      json: {
        items: calls === 1 ? [episodes[0]] : episodes.slice(0, 2),
        season: 1,
        seasons: [1],
        refreshing: false,
        stale: calls === 2,
        refreshAfterSeconds: calls === 1 ? 1 : calls === 2 ? 0 : 86400,
      },
    });
  });
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await expect(page.getByRole("button", { name: /First Light/ })).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(page.getByRole("button", { name: /After Hours/ })).toBeVisible();
  expect(calls).toBe(2);
  await page.clock.fastForward(60_000);
  expect(calls).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => calls).toBe(3);
  expect(api.events).not.toContain("POST");
  // Reload to discard Motion's real animation timeline after virtual time jumps.
  await page.goto("/?section=series");
  await expect(
    page.getByRole("button", { name: "Open Night Shift" }),
  ).toBeVisible();
});

test("an empty Home offers a VOD entry point and responsive navigation", async ({
  page,
}) => {
  const api = await mockApi(page, {
    discoveryResponse: {
      configured: false,
      refreshing: false,
      trendingMovies: [],
      trendingSeries: [],
      exploreMovies: [],
      exploreSeries: [],
    },
  });
  await page.goto("/");
  await expectHome(page);
  await expect(page.locator(".discovery-eyebrow, .eyebrow")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Browse Movies", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", { name: "VOD", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clear history" })).toHaveCount(
    0,
  );
  expect(api.events).not.toContain("POST");
  for (const width of [900, 821, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  const mobile = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(mobile.getByRole("button")).toHaveCount(5);
  await navigateLibrary(page, "movie");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await mobile.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
});

test("dashboard history records playing media, survives reloads, reopens a season and clears", async ({
  page,
}) => {
  test.setTimeout(60000);
  const api = await mockApi(page);
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
  expect(api.events).not.toContain("POST");

  for (const [label, title] of [
    ["Live TV", live],
    ["Movies", movie],
  ] as const) {
    await navigateLibrary(page, label === "Live TV" ? "live" : "movie");
    await page.getByRole("button", { name: `Open ${title.name}` }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    // A ready session alone does not count as watched.
    expect(api.history.read().length).toBe(title.kind === "live" ? 0 : 1);
    await playableVideo(page);
    await playableVideo(page); // Buffer recovery must not duplicate history.
    await page.getByRole("button", { name: "Stop playback" }).click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(
      page
        .getByRole("region", { name: "Recently played" })
        .getByRole("button", { name: `Open ${title.name}` }),
    ).toBeVisible();
  }

  await navigateLibrary(page, "series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await page.getByRole("combobox", { name: "Season" }).click();
  await page.getByRole("option", { name: "Season 2" }).click();
  await page.getByRole("button", { name: /Fresh Start/ }).click();
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Recently played" })
      .locator(".discovery-recent-card"),
  ).toHaveCount(3);
  const combinedHistory = page.getByRole("region", {
    name: "Recently played",
    exact: true,
  });
  await expect(
    combinedHistory.getByRole("group", { name: "History type", exact: true }),
  ).toHaveCount(0);
  expect(
    await combinedHistory
      .getByRole("button", { name: /^Open / })
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
  ).toEqual(["Open Night Shift", "Open The Quiet Coast", "Open North News"]);
  if (process.env.CAPTURE_SCREENSHOTS) {
    const viewport = page.viewportSize()!;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await combinedHistory.screenshot({
        path: `../output/cinema-review/${width}-recently-played-combined.png`,
        animations: "disabled",
      });
    }
    await page.setViewportSize(viewport);
  }
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toContainText("S2 · E1");
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toContainText("Fresh Start");
  const sessions = api.sessionItemIds.length;
  await page
    .getByRole("region", { name: "Recently played" })
    .getByRole("button", { name: "Open Night Shift" })
    .click();
  await expect(page.getByRole("combobox", { name: "Season" })).toHaveText(
    "Season 2",
  );
  await expect(page.locator(".episode-row.selected")).toContainText(
    "Fresh Start",
  );
  expect(api.sessionItemIds).toHaveLength(sessions);
  await page.goBack();
  await expectHome(page);
  await page
    .getByRole("button", { name: "Remove North News from history" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Recently played" })
      .getByRole("button", { name: "Open North News", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear history" }).click();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
  expect(api.history.read()).toEqual([]);
});

test("series history updates to the latest episode without duplicating the show", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/?section=series");
  for (const name of ["First Light", "After Hours"]) {
    const expanded = page.getByRole("region", { name: "Expanded title" });
    if (!(await expanded.isVisible()))
      await page.getByRole("button", { name: "Open Night Shift" }).click();
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await playableVideo(page);
    await page.getByRole("button", { name: "Stop playback" }).click();
  }
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Recently played" })
      .locator(".discovery-recent-card"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toContainText("S1 · E2");
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toContainText("After Hours");
});

test("failed playback is not recorded in dashboard history", async ({
  page,
}) => {
  const api = await mockApi(page, { capacity: true });
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "All streaming slots are in use.",
  );
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(
    page.getByRole("button", { name: "Open North News", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
});

test("playback queued after an initial history failure recovers its server lease and progress", async ({
  page,
}) => {
  const api = await mockApi(page);
  let reads = 0;
  let releaseSnapshot!: () => void;
  let snapshotRequested!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    snapshotRequested = resolve;
  });
  await page.route("**/api/watch-history", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    if (reads === 1)
      return route.fulfill({
        status: 503,
        json: { error: "History temporarily unavailable" },
      });
    if (reads === 2) {
      // Capture the empty server snapshot before playback queues its record.
      const snapshot = {
        entries: api.history.read(),
        scope: "provider:shared",
        userId: "",
      };
      snapshotRequested();
      await snapshotGate;
      return route.fulfill({ json: snapshot });
    }
    return route.fallback();
  });
  try {
    const failedRead = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/watch-history") &&
        response.status() === 503,
    );
    await page.goto("/?section=movie");
    await failedRead;
    await page
      .getByRole("button", { name: "Open The Quiet Coast", exact: true })
      .click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await playableVideo(page, 33);
    await requested;
    expect(api.history.read()).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    releaseSnapshot();
    await expect
      .poll(() => api.history.read()[0])
      .toMatchObject({
        position: 33,
        playbackId: expect.stringMatching(/^playback-/),
      });
    await playableVideo(page, 90);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => api.history.read()[0]?.position).toBe(90);
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    api.history.seed([
      { ...api.history.read()[0], position: 120, playbackId: "other-device" },
    ]);
    const refreshed = page.waitForResponse("**/api/watch-history");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    const remaining = Math.ceil((api.history.read()[0].duration - 120) / 60);
    await expect(
      page.getByRole("region", { name: "Continue watching" }),
    ).toContainText(`${remaining} min left`);
    await page
      .getByRole("region", { name: "Continue watching" })
      .getByRole("button", { name: /Resume The Quiet Coast/ })
      .click();
    await expect.poll(() => api.sessionStarts).toEqual([0, 120]);
  } finally {
    releaseSnapshot();
  }
});

test("history sync failures retain saved entries and recover on focus", async ({
  page,
}) => {
  const api = await mockApi(page);
  api.history.seed([
    {
      title: movie,
      item: movie,
      watchedAt: now,
      position: 300,
      duration: 3600,
      completed: false,
    },
  ]);
  let failed = false;
  await page.route("**/api/watch-history", async (route) => {
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: "History temporarily unavailable" },
      });
    return route.fallback();
  });
  await page.goto("/?view=dashboard");
  const continuing = page.getByRole("region", { name: "Continue watching" });
  await expect(continuing).toBeVisible();
  failed = true;
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/watch-history") &&
      response.status() === 503,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await rejected;
  const warning = page.getByText(
    "Watch history couldn’t sync. Changes may not be saved.",
    { exact: true },
  );
  await expect(warning).toBeVisible();
  await expect(continuing).toBeVisible();
  // Failed removal is optimistic locally, but cannot erase durable history.
  const failedRemoval = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/watch-history") &&
      response.request().method() === "DELETE" &&
      response.status() === 503,
  );
  await page
    .getByRole("button", {
      name: `Remove ${movie.name} from history`,
      exact: true,
    })
    .click();
  await failedRemoval;
  await expect(continuing).toHaveCount(0);
  expect(api.history.read()).toHaveLength(1);
  failed = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(continuing).toBeVisible();
  await expect(warning).toHaveCount(0);
});

test("dashboard safely handles unavailable titles in server history", async ({
  page,
}) => {
  const api = await mockApi(page);
  const gone = { ...movie, id: "gone-movie" };
  api.history.seed([
    {
      title: gone,
      item: gone,
      watchedAt: now,
      position: 0,
      duration: 0,
      completed: false,
    },
  ]);
  await page.goto("/?view=dashboard");
  await expect(
    page
      .getByRole("region", { name: "Recently played" })
      .locator(".discovery-recent-card"),
  ).toHaveCount(1);
  await page
    .getByRole("region", { name: "Recently played" })
    .getByRole("button", { name: "Open The Quiet Coast" })
    .click();
  await expect(page.getByRole("alert")).toContainText("is no longer available");
  expect(api.events).not.toContain("POST");
  await page
    .getByRole("button", { name: "Remove The Quiet Coast from history" })
    .click();
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
});

test("dashboard remains usable when browser storage is blocked", async ({
  page,
}) => {
  await mockApi(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Recently played", exact: true })
      .getByRole("button", { name: "Open North News", exact: true }),
  ).toBeVisible();
});

test("Play animates on hover and keyboard focus, respects reduced motion and stays static while opening", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const api = await mockApi(page);
  let releaseVerify!: () => void;
  const verification = new Promise<void>((resolve) => {
    releaseVerify = resolve;
  });
  await page.route(`**/api/items/${movie.id}`, async (route) => {
    await verification;
    await route.fallback();
  });
  await page.goto("/?view=dashboard");
  const play = page.getByRole("button", {
    name: `Play ${movie.name}`,
    exact: true,
  });
  const glyph = play.locator(".play-action-glyph");
  // Capture the event before interacting so a busy runner cannot miss the
  // short animation between polling samples.
  await glyph.evaluate((element) => {
    element.setAttribute("data-animation-starts", "0");
    element.addEventListener("animationstart", (event) => {
      if ((event as AnimationEvent).animationName === "play-action-forward")
        element.setAttribute(
          "data-animation-starts",
          String(Number(element.getAttribute("data-animation-starts")) + 1),
        );
    });
  });
  const starts = async () =>
    Number(await glyph.getAttribute("data-animation-starts"));
  await play.hover();
  await expect.poll(starts).toBeGreaterThan(0);
  const hoverStarts = await starts();
  if (process.env.CAPTURE_SCREENSHOTS) {
    await glyph.evaluate((element) =>
      element.getAnimations().forEach((animation) => {
        animation.pause();
        animation.currentTime = 90;
      }),
    );
    await page.screenshot({
      path: "../output/settings-design/play-hover-desktop.png",
    });
  }
  await glyph.evaluate((element) =>
    element.getAnimations().forEach((animation) => animation.finish()),
  );
  await page.mouse.move(0, 0);
  await page.keyboard.press("Tab");
  await play.focus();
  await expect(play).toBeFocused();
  await expect.poll(starts).toBeGreaterThan(hoverStarts);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() => glyph.evaluate((element) => element.getAnimations().length))
    .toBe(0);
  await play.hover();
  await expect
    .poll(() => glyph.evaluate((element) => element.getAnimations().length))
    .toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  try {
    await play.click();
    await expect(play).toBeDisabled();
    await expect(play).toHaveAttribute("aria-busy", "true");
    await expect(play.locator(".play-action-glyph")).toHaveCount(0);
  } finally {
    releaseVerify();
  }
  await expect.poll(() => api.sessionItemIds).toEqual([movie.id]);
  await expect(
    page.getByRole("region", { name: "Player", exact: true }),
  ).toBeVisible();
});

test("dashboard resumes the full source position and Play again starts at zero", async ({
  page,
}) => {
  const api = await mockApi(page);
  api.history.seed([
    {
      title: movie,
      item: movie,
      watchedAt: now,
      position: 300,
      duration: 1800,
      completed: false,
    },
  ]);
  await page.goto("/?view=dashboard");
  const continuing = page.getByRole("region", { name: "Continue watching" });
  await expect(continuing).toBeVisible();
  await continuing
    .getByRole("button", { name: /Resume The Quiet Coast/ })
    .click();
  await expect(page).toHaveURL(/view=player/);
  await expect(page.getByRole("button", { name: /^Back to / })).toHaveCount(0);
  await expect(continuing).not.toBeVisible();
  await expect.poll(() => api.sessionStarts).toEqual([300]);
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page, 30);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => api.history.read()[0]?.position).toBe(330);
  await page.locator("video").evaluate((video) => {
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 1500,
    });
    video.dispatchEvent(new Event("timeupdate"));
    video.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();
  await expect.poll(() => api.history.read()[0]?.completed).toBe(true);
  await page.getByRole("button", { name: "Play again" }).click();
  await expect.poll(() => api.sessionStarts).toEqual([300, 0]);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(page).toHaveURL(/view=dashboard/);
  await expectHome(page);
});

test("Up next includes shows outside Home categories and plays the next season at 390px", async ({
  page,
}) => {
  const width = 390;
  await page.setViewportSize({ width, height: 900 });
  const api = await mockApi(page, {
    preferences: {
      refreshIntervalSeconds: 21600,
      configuration: {
        dashboardCategories: ["movie:drama-movie"],
        blockedCategories: [],
      },
      categories: [],
    },
  });
  const requested: string[] = [];
  await page.route("**/api/series/series-1/episodes?*", async (route) => {
    const season = new URL(route.request().url()).searchParams.get("season")!;
    requested.push(season);
    const selected = season === "first" ? 1 : Number(season);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: episodes.filter((episode) => (episode.season ?? 1) === selected),
        season: selected,
        seasons: [1, 2],
      }),
    });
  });
  api.history.seed([
    {
      title: series,
      item: { ...episodes[1], season: 1 },
      watchedAt: now,
      position: 1800,
      duration: 1800,
      completed: true,
    },
  ]);
  await page.goto("/?view=dashboard");
  const next = page.getByRole("region", { name: "Up next" });
  await expect(next).toContainText("Fresh Start");
  await expect(
    page.getByRole("region", { name: "Continue watching" }),
  ).toHaveCount(0);
  expect(requested).toEqual(["1", "2"]);
  expect(api.events).not.toContain("POST");
  await next.getByRole("button", { name: /Play/ }).click();
  await expect.poll(() => api.sessionItemIds).toEqual(["episode-3"]);
  await expect.poll(() => api.sessionStarts).toEqual([0]);
  await page.getByRole("button", { name: "Stop playback" }).click();
});

test("server history syncs progress, removals and clear across devices and isolates accounts", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const history = createHistoryFixture();
  const desktop = await mockApi(page, { history, user: "alice" });
  await page.goto("/?section=movie");
  const origin = new URL(page.url()).origin;
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const otherContext = await browser.newContext();
  try {
    const phone = await phoneContext.newPage();
    const mobile = await mockApi(phone, { history, user: "alice" });
    const other = await otherContext.newPage();
    await mockApi(other, { history, user: "bob" });
    await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await playableVideo(page, 100);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => history.read("alice")[0]?.position).toBe(100);
    await phone.goto(`${origin}/?view=dashboard`);
    const phoneContinue = phone.getByRole("region", {
      name: "Continue watching",
    });
    await expect(phoneContinue).toBeVisible();
    if (process.env.CAPTURE_SCREENSHOTS)
      await phone.screenshot({
        path: "../output/history-server/phone-390.png",
        fullPage: true,
        animations: "disabled",
      });
    await phoneContinue
      .getByRole("button", { name: /Resume The Quiet Coast/ })
      .click();
    await expect.poll(() => mobile.sessionStarts).toEqual([100]);
    await expect(phone.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await playableVideo(phone, 25);
    await phone.getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => history.read("alice")[0]?.position).toBe(125);
    await phone.getByRole("button", { name: "Stop playback" }).click();
    // Refreshing the older desktop while it is still playing must not adopt
    // the phone's writer lease, even though the episode/title is the same.
    const phonePlayback = history.read("alice")[0].playbackId;
    const refreshed = page.waitForResponse("**/api/watch-history");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    await playableVideo(page, 400);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect
      .poll(() => history.read("alice")[0])
      .toMatchObject({ position: 125, playbackId: phonePlayback });
    await page.getByRole("button", { name: "Stop playback" }).click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const desktopContinue = page.getByRole("region", {
      name: "Continue watching",
    });
    await expect(desktopContinue).toBeVisible();
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: "../output/history-server/desktop-1440.png",
        fullPage: true,
        animations: "disabled",
      });
    await other.goto(`${origin}/?view=dashboard`);
    await expect(
      other.getByRole("region", { name: "Recently played" }),
    ).toHaveCount(0);
    await phone
      .getByRole("button", {
        name: "Remove The Quiet Coast from history",
        exact: true,
      })
      .click();
    await expect.poll(() => history.read("alice")).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(desktopContinue).toHaveCount(0);
    await phone.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => history.read("alice")[0]?.position).toBe(125);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await desktopContinue
      .getByRole("button", { name: /Resume The Quiet Coast/ })
      .click();
    await expect.poll(() => desktop.sessionStarts).toEqual([0, 125]);
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await playableVideo(page, 10);
    await phone
      .getByRole("button", { name: "Clear history", exact: true })
      .click();
    await expect.poll(() => history.read("alice")).toEqual([]);
    await playableVideo(page, 200);
    await page.getByRole("button", { name: "Stop playback" }).click();
    await expect.poll(() => history.read("alice")).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(desktopContinue).toHaveCount(0);
    expect(history.read("bob")).toEqual([]);
  } finally {
    await phoneContext.close();
    await otherContext.close();
  }
});

async function accelerateHeroRotation(page: Page) {
  // Motion uses the native animation timeline: keep it real and shorten only
  // the 8s rotation wait, leaving enough time for the full 650ms crossfade.
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler, delay, ...args) =>
      schedule(
        handler,
        delay === 8000 ? 1500 : delay,
        ...args,
      )) as typeof window.setTimeout;
  });
}

test("hero rotates Trending and saved titles and resumes the right source", async ({
  page,
}) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  await accelerateHeroRotation(page);
  const savedMovie = {
    ...movie,
    id: "saved-movie",
    name: "An Earlier Film",
    image: "/artwork-title.svg",
  };
  const history = createHistoryFixture();
  history.seed([
    {
      title: series,
      item: { ...episodes[1], season: 1 },
      watchedAt: now,
      position: 240,
      duration: 1800,
      completed: false,
    },
    {
      title: savedMovie,
      item: savedMovie,
      watchedAt: now - 1000,
      position: 300,
      duration: 3600,
      completed: false,
    },
  ]);
  const api = await mockApi(page, {
    history,
    catalogItems: [live, movie, series, savedMovie],
    discoveryResponse: {
      configured: true,
      refreshing: false,
      trendingMovies: [
        { item: movie, name: movie.name, backdrop: "/artwork-title.svg" },
      ],
      trendingSeries: [
        { item: series, name: series.name, backdrop: "/artwork-title.svg" },
      ],
      exploreMovies: [],
      exploreSeries: [],
    },
  });
  await page.goto("/?view=dashboard");
  const hero = page.getByRole("region", {
    name: "Featured titles",
    exact: true,
  });
  const heading = hero.getByRole("heading");
  const advance = async () => {
    const before = await heading.textContent();
    await page.getByRole("button", { name: "Home", exact: true }).focus();
    await page.mouse.move(0, 0);
    await expect(heading).not.toHaveText(before!);
  };
  const select = async (name: string) => {
    for (let index = 0; index < 3; index++) {
      if ((await heading.textContent()) === name) {
        await hero.hover();
        return;
      }
      await advance();
    }
    await expect(heading).toHaveText(name);
  };
  await expect(hero).toBeVisible();
  await expect(hero.getByRole("button")).toHaveCount(1);
  const initial = await heading.textContent();
  const seen = new Set<string | null>();
  for (let index = 0; index < 3; index++) {
    seen.add(await heading.textContent());
    await advance();
  }
  expect([...seen].sort()).toEqual(
    [movie.name, series.name, savedMovie.name].sort(),
  );
  await expect(heading).toHaveText(initial!);
  for (const entry of [
    { title: series, item: episodes[1], position: 240, percent: 13 },
    { title: savedMovie, item: savedMovie, position: 300, percent: 8 },
  ]) {
    await select(entry.title.name);
    await expect(
      hero.getByRole("progressbar", { name: "Watch progress" }),
    ).toHaveAttribute("aria-valuenow", String(entry.percent));
    const resume = hero.getByRole("button", {
      name: `Continue watching ${entry.title.name}`,
      exact: true,
    });
    await expect(resume).toHaveText("Continue watching");
    if (entry.title.kind === "series")
      await expect(hero).toContainText("S1 · E2");
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `/tmp/restream-hero-resume-${entry.title.kind}-${width}.png`,
      });
    await resume.click();
    await expect.poll(() => api.sessionStarts.at(-1)).toBe(entry.position);
    expect(api.sessionItemIds.at(-1)).toBe(entry.item.id);
    await expect(
      page.getByRole("region", { name: "Player", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(hero).toBeVisible();
  }
  await select(movie.name);
  await expect(hero.getByRole("progressbar")).toHaveCount(0);
  await hero
    .getByRole("button", { name: `Play ${movie.name}`, exact: true })
    .click();
  await expect.poll(() => api.sessionItemIds.at(-1)).toBe(movie.id);
  expect(api.sessionStarts.at(-1)).toBe(0);
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
});

test("hero crossfades without repeating or jumping on refresh and pauses during interaction", async ({
  page,
}) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  await accelerateHeroRotation(page);
  const other = {
    ...movie,
    id: "another-trend",
    name: "Another Trending Film",
  };
  const discovery = {
    configured: true,
    refreshing: false,
    trendingMovies: [movie, other].map((item) => ({
      item,
      name: item.name,
      backdrop: `/artwork-title.svg?hero=${item.id}`,
    })),
    trendingSeries: [
      {
        item: series,
        name: series.name,
        backdrop: `/artwork-title.svg?hero=${series.id}`,
      },
    ],
    exploreMovies: [],
    exploreSeries: [],
  };
  await mockApi(page, { discoveryResponse: discovery });
  await page.goto("/?view=dashboard");
  const hero = page.getByRole("region", {
    name: "Featured titles",
    exact: true,
  });
  const heading = hero.getByRole("heading");
  await expect(heading).toHaveText(movie.name);
  const initialHeight = (await hero.boundingBox())!.height;
  const tick = async (rotates = false) => {
    const before = await heading.textContent();
    if (rotates) await expect(heading).not.toHaveText(before!);
    else await page.waitForTimeout(1700);
  };
  const seen = new Set([await heading.textContent()]);
  await tick(true);
  await expect(hero.locator(".discovery-lead-art")).toHaveCount(2);
  await expect(heading).not.toHaveText(movie.name);
  seen.add(await heading.textContent());
  await tick(true);
  seen.add(await heading.textContent());
  expect(seen.size).toBe(3);
  expect((await hero.boundingBox())!.height).toBe(initialHeight);
  let current = (await heading.textContent())!;
  await hero.hover();
  await tick();
  await expect(heading).toHaveText(current);
  await page.mouse.move(0, 0);
  await hero.getByRole("button", { name: /^Play / }).focus();
  await tick();
  await expect(heading).toHaveText(current);
  await page.getByRole("button", { name: "Home", exact: true }).focus();
  await page.mouse.move(0, 0);
  await tick(true);
  await expect(heading).not.toHaveText(current);
  current = (await heading.textContent())!;
  await hero.hover();
  const response = page.waitForResponse("**/api/discovery");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await response;
  await expect(hero.locator(".discovery-lead-art")).toHaveCount(1);
  await expect(heading).toHaveText(current);
  const remainingMovies = discovery.trendingMovies.filter(
    (title) => title.name !== current,
  );
  const remainingSeries = discovery.trendingSeries.filter(
    (title) => title.name !== current,
  );
  discovery.trendingMovies.splice(
    0,
    discovery.trendingMovies.length,
    ...remainingMovies,
  );
  discovery.trendingSeries.splice(
    0,
    discovery.trendingSeries.length,
    ...remainingSeries,
  );
  const updated = page.waitForResponse("**/api/discovery");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await updated;
  await expect(hero.locator(".discovery-feature")).not.toHaveAttribute(
    "aria-label",
    `Featured ${current}`,
  );
  await expect(hero.locator(".discovery-lead-art")).toHaveCount(1);
  await expect(heading).not.toHaveText(current);
  current = (await heading.textContent())!;
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await tick();
  await expect(heading).toHaveText(current);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await tick(true);
  await expect(heading).not.toHaveText(current);
  current = (await heading.textContent())!;
  await page.setViewportSize({ width, height: 350 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(hero).not.toBeInViewport();
  await tick();
  await expect(heading).toHaveText(current);
  await page.setViewportSize({ width, height: 900 });
  await hero.scrollIntoViewIfNeeded();
  await tick(true);
  await expect(heading).not.toHaveText(current);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
});

test("hero keeps automatic rotation off for reduced motion without extra controls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await mockApi(page);
  await page.goto("/?view=dashboard");
  const hero = page.getByRole("region", {
    name: "Featured titles",
    exact: true,
  });
  const heading = hero.getByRole("heading");
  await expect(heading).toHaveText(movie.name);
  await page.clock.fastForward(20000);
  await expect(heading).toHaveText(movie.name);
  await expect(hero.getByRole("button")).toHaveCount(1);
  await expect(
    hero.getByRole("button", { name: `Play ${movie.name}`, exact: true }),
  ).toBeVisible();
});

for (const title of [movie, series]) {
  for (const width of [1440, 390]) {
    test(`dashboard ${title.kind} hero has one Play action at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const feature = {
        tmdbId: 17,
        item: title,
        name: title.name,
        overview: "A title from your library.",
        poster: "/artwork-title.svg",
        backdrop: "/artwork-title.svg",
        year: 2026,
        rating: 7.8,
      };
      const api = await mockApi(page, {
        discoveryResponse: {
          configured: true,
          refreshing: false,
          trendingMovies: title.kind === "movie" ? [feature] : [],
          trendingSeries: title.kind === "series" ? [feature] : [],
          exploreMovies: [],
          exploreSeries: [],
        },
      });
      await page.goto("/?view=dashboard");
      await expectHome(page);
      await expect(
        page.getByRole("region", { name: "Continue watching" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Recently played" }),
      ).toHaveCount(0);
      const hero = page.getByRole("region", {
        name: `Featured ${title.name}`,
        exact: true,
      });
      await expect(
        hero.getByRole("heading", { name: title.name, exact: true }),
      ).toBeVisible();
      const play = hero.getByRole("button", {
        name: `Play ${title.name}`,
        exact: true,
      });
      await expect(hero.getByRole("button")).toHaveCount(1);
      await expect(play).toHaveText("Play");
      expect(api.events).not.toContain("POST");
      if (process.env.CAPTURE_SCREENSHOTS)
        await page.screenshot({
          path: `/tmp/restream-play-${title.kind}-${width}.png`,
        });
      await play.click();
      await expect
        .poll(() => api.sessionItemIds)
        .toEqual([title.kind === "series" ? "episode-1" : title.id]);
      await expect(
        page.getByRole("region", { name: "Player", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Stop playback" }).click();
    });
  }
}

test("a direct series player route resolves its episode and reload resumes progress without duplicate sessions", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto(
    "/?view=player&section=series&item=series-1&season=2&episode=episode-3",
  );
  await expect(
    page.getByRole("region", { name: "Player", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".dock-title")).toHaveText(series.name);
  await expect(
    page
      .getByRole("complementary", { name: "Watch context", exact: true })
      .getByRole("button", { name: "Play Fresh Start", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect.poll(() => api.sessionItemIds).toEqual(["episode-3"]);
  await expect(
    page.getByRole("region", { name: "Shows library", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Back to / })).toHaveCount(0);
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page, 42);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // Settle pagehide while this document's mocked keepalive route is still alive.
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide")),
  );
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await page.reload();
  await expect(page).toHaveURL(/view=player/);
  await expect(page.locator(".dock-title")).toHaveText(series.name);
  await expect(
    page
      .getByRole("complementary", { name: "Watch context", exact: true })
      .getByRole("button", { name: "Play Fresh Start", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect
    .poll(() => api.sessionItemIds)
    .toEqual(["episode-3", "episode-3"]);
  await expect.poll(() => api.sessionStarts).toEqual([0, 42]);
  await expect(page.locator("video")).toHaveAttribute("src", /session-2/);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(page.locator("video")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("view")).not.toBe("player");
  await expect(
    page.getByRole("combobox", { name: "Season", exact: true }),
  ).toHaveText("Season 2");
  await expect(page.locator(".episode-row.selected")).toContainText(
    "Fresh Start",
  );
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(2);
});

test("closing the workspace saves the latest movie position and Forward resumes it once", async ({
  page,
}) => {
  const api = await mockApi(page, { releaseDelayMs: 100 });
  await page.goto("/?view=search&section=movie&search=Quiet");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  const origin = page.url();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Back to / })).toHaveCount(0);
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page, 30);
  await page.locator("video").evaluate((video) => {
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 120,
    });
  });
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(page).toHaveURL(origin);
  await expect(page.locator("video")).toHaveCount(0);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await expect.poll(() => api.history.read()[0]?.position).toBe(120);
  await page.goForward();
  await expect(page).toHaveURL(/view=player/);
  await expect.poll(() => api.sessionItemIds).toEqual([movie.id, movie.id]);
  await expect.poll(() => api.sessionStarts).toEqual([0, 120]);
  await expect(page.locator("video")).toHaveCount(1);
  expect(
    api.events.filter((event) => event === "POST" || event === "DELETE"),
  ).toEqual(["POST", "DELETE", "POST"]);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectHome(page);
  await expect(page.locator("video")).toHaveCount(0);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(2);
});

test("a pending Dashboard Play request cannot reopen the player after leaving", async ({
  page,
}) => {
  const api = await mockApi(page);
  let releaseMetadata!: () => void;
  let metadataRequested!: () => void;
  const metadataGate = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    metadataRequested = resolve;
  });
  await page.route("**/api/items/movie-1", async (route) => {
    metadataRequested();
    await metadataGate;
    await route
      .fulfill({
        contentType: "application/json",
        body: JSON.stringify({ item: movie }),
      })
      .catch(() => {});
  });
  try {
    await page.goto("/?view=dashboard");
    await page
      .getByRole("button", { name: `Play ${movie.name}`, exact: true })
      .click();
    await requested;
    await openSettings(page);
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    releaseMetadata();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/view=settings/);
    await expect(page.locator("video")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Player", exact: true }),
    ).toHaveCount(0);
    expect(api.sessionItemIds).toEqual([]);
  } finally {
    releaseMetadata();
  }
});

test("hidden playback batches frequent history updates within the progress interval", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const api = await mockApi(page);
  let progressWrites = 0;
  await page.route("**/api/watch-history/progress", async (route) => {
    progressWrites++;
    return route.fallback();
  });
  await page.clock.install();
  await page.goto("/?section=movie");
  await page
    .getByRole("button", { name: "Open The Quiet Coast", exact: true })
    .click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page, 30);
  await expect.poll(() => api.history.read()[0]?.position).toBe(30);
  await page.clock.fastForward(5000);
  const beforeHidden = progressWrites;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const video = document.querySelector("video")!;
    for (let position = 31; position <= 80; position++)
      video.currentTime = position;
  });
  // The first background update is sent immediately; the remaining burst is
  // coalesced until the next five-second interval rather than one write/event.
  await expect.poll(() => api.history.read()[0]?.position).toBe(31);
  expect(progressWrites - beforeHidden).toBe(1);
  await page.clock.fastForward(5000);
  await expect.poll(() => api.history.read()[0]?.position).toBe(80);
  expect(progressWrites - beforeHidden).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectHome(page);
});

test("persisted pageshow restores a pagehidden player at its saved source offset", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page, 42);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await expect.poll(() => api.history.read()[0]?.position).toBe(42);
  await expect(page.locator("video")).not.toHaveAttribute("src", /index\.m3u8/);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: false }),
    ),
  );
  expect(api.sessionItemIds).toEqual([movie.id]);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect.poll(() => api.sessionItemIds).toEqual([movie.id, movie.id]);
  await expect.poll(() => api.sessionStarts).toEqual([0, 42]);
  await expect(page.locator("video")).toHaveAttribute("src", /session-2/);
  await playableVideo(page, 10);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => api.history.read()[0]?.position).toBe(52);
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(2);
  expect(
    api.events.filter((event) => event === "POST" || event === "DELETE"),
  ).toEqual(["POST", "DELETE", "POST", "DELETE"]);
});

test("workspace side episodes keep the current stream while browsing seasons and release it before switching", async ({
  page,
}) => {
  const api = await mockApi(page, { releaseDelayMs: 150 });
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await page.getByRole("button", { name: /First Light/ }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([episodes[0].id]);
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page);
  const sidebar = page.getByRole("complementary", {
    name: "Watch context",
    exact: true,
  });
  await expect(
    sidebar.getByRole("heading", { name: series.name, exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "Play First Light", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await sidebar.getByRole("combobox", { name: "Season", exact: true }).click();
  await page.getByRole("option", { name: "Season 2", exact: true }).click();
  await expect(
    sidebar.getByRole("button", { name: "Play Fresh Start", exact: true }),
  ).toBeVisible();
  expect(api.sessionItemIds).toEqual([episodes[0].id]);
  expect(api.events).not.toContain("DELETE");
  await sidebar
    .getByRole("button", { name: "Play Fresh Start", exact: true })
    .click();
  await expect
    .poll(() => api.sessionItemIds)
    .toEqual([episodes[0].id, episodes[2].id]);
  await expect(page).toHaveURL(/season=2/);
  await expect(page).toHaveURL(/episode=episode-3/);
  await expect(
    sidebar.getByRole("button", { name: "Play Fresh Start", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.locator("video")).toHaveCount(1);
  expect(
    api.events.filter((event) => event === "POST" || event === "DELETE"),
  ).toEqual(["POST", "DELETE", "POST"]);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "All streaming slots are in use." }),
  ).toHaveCount(0);
});

test("workspace channel suggestions retain the active channel and release before tuning another", async ({
  page,
}) => {
  const other = { ...live, id: "live-2", name: "World Report" };
  const api = await mockApi(page, {
    catalogItems: [live, other],
    releaseDelayMs: 150,
  });
  await page.goto("/?section=live");
  await page
    .getByRole("button", { name: "Open North News", exact: true })
    .click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([live.id]);
  const channels = page
    .getByRole("complementary", { name: "Watch context", exact: true })
    .getByRole("region", { name: "Channels", exact: true });
  const active = channels.getByRole("button", {
    name: "Watch North News",
    exact: true,
  });
  await expect(active).toHaveAttribute("aria-current", "true");
  await active.click();
  expect(api.sessionItemIds).toEqual([live.id]);
  expect(api.events).not.toContain("DELETE");
  await channels
    .getByRole("button", { name: "Watch World Report", exact: true })
    .click();
  await expect.poll(() => api.sessionItemIds).toEqual([live.id, other.id]);
  await expect(page).toHaveURL(/item=live-2/);
  await expect(page.locator("video")).toHaveCount(1);
  await expect(
    channels.getByRole("button", { name: "Watch World Report", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    api.events.filter((event) => event === "POST" || event === "DELETE"),
  ).toEqual(["POST", "DELETE", "POST"]);
});

test("dashboard discovery preserves playback metadata and sidebar movies switch safely", async ({
  page,
}) => {
  const other = { ...movie, id: "movie-2", name: "Quiet Harbor" };
  const matchingShows = [
    series,
    ...Array.from({ length: 11 }, (_, index) => ({
      ...series,
      id: `series-${index + 2}`,
      name: `Night Shift ${index + 2}`,
    })),
  ];
  let probeReady = false;
  const api = await mockApi(page, {
    catalogItems: [movie, other, ...matchingShows],
    releaseDelayMs: 150,
    starting: () => !probeReady,
    initialSessionDuration: 130,
    discoveryResponse: {
      configured: false,
      refreshing: false,
      trendingMovies: [],
      trendingSeries: [],
      exploreMovies: [
        { item: movie, name: movie.name },
        { item: other, name: other.name },
      ],
      exploreSeries: [{ item: series, name: series.name }],
    },
  });
  await page.goto("/?view=dashboard");
  await page
    .getByRole("button", { name: `Play ${movie.name}`, exact: true })
    .click();
  const metadata = page
    .getByRole("complementary", { name: "Watch context", exact: true })
    .locator(".watch-media-meta");
  await expect(metadata).toBeVisible();
  await expect(metadata).toHaveText(/^Movie\s*Title details\s*$/);
  probeReady = true;
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page);
  const original = await page.locator("video").elementHandle();
  const workspace = page.getByRole("region", {
    name: "Watch workspace",
    exact: true,
  });
  // The provider's 3600-second item value must not override the session's
  // probed 1800-second duration, which is also used by the decoder timeline.
  await expect(workspace.locator(".watch-media-meta")).toContainText(
    "Movie · 30m",
  );
  const explore = page.getByRole("region", { name: "Explore", exact: true });
  await expect(
    explore.getByRole("heading", { name: "Explore", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  expect(
    await original!.evaluate(
      (element) => element === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(api.sessionItemIds).toEqual([movie.id]);
  expect(api.events).not.toContain("DELETE");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await original!.evaluate(
        (element) => element === document.querySelector("video"),
      ),
    ).toBe(true);
    expect(api.sessionItemIds).toEqual([movie.id]);
    expect(api.events).not.toContain("DELETE");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const sidebar = page.getByRole("complementary", {
    name: "Watch context",
    exact: true,
  });
  await expect(
    sidebar.getByRole("button", { name: `Play ${movie.name}`, exact: true }),
  ).toHaveCount(0);
  await sidebar
    .getByRole("button", { name: `Play ${other.name}`, exact: true })
    .click();
  await expect.poll(() => api.sessionItemIds).toEqual([movie.id, other.id]);
  await expect(
    sidebar.getByRole("heading", { name: other.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator("video")).toHaveCount(1);
  expect(
    api.events.filter((event) => event === "POST" || event === "DELETE"),
  ).toEqual(["POST", "DELETE", "POST"]);
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(page.locator("video")).toHaveCount(0);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(2);
});

test("Home categories filter discovery while personal history respects blocked categories", async ({
  page,
}) => {
  const allowed = { ...movie, categoryId: "drama-movie" };
  const personal = {
    ...movie,
    id: "movie-personal",
    name: "Private Memory",
    categoryId: "personal",
    category: "Personal",
  };
  const hidden = {
    ...movie,
    id: "movie-hidden",
    name: "Hidden Reel",
    categoryId: "hidden",
    category: "Hidden",
  };
  const blocked = {
    ...movie,
    id: "movie-blocked",
    name: "Blocked Reel",
    categoryId: "blocked",
    category: "Restricted",
  };
  const entries = [allowed, personal, hidden, blocked].map((title, index) => ({
    title,
    item: title,
    watchedAt: Date.now() - index * 1000,
    position: 300,
    duration: 1800,
    completed: false,
  }));
  const history = createHistoryFixture();
  history.seed(entries);
  let releasePreferences!: () => void;
  const preferencesGate = new Promise<void>((resolve) => {
    releasePreferences = resolve;
  });
  const api = await mockApi(page, {
    history,
    preferencesGate,
    catalogItems: [allowed, personal, hidden, blocked],
    categories: [
      { id: "drama-movie", name: "Drama", kind: "movie" },
      { id: "personal", name: "Personal", kind: "movie" },
      { id: "hidden", name: "Hidden", kind: "movie" },
      { id: "blocked", name: "Restricted", kind: "movie" },
    ],
    preferences: {
      refreshIntervalSeconds: 21600,
      configuration: {
        dashboardCategories: ["movie:drama-movie"],
        blockedCategories: ["movie:hidden", "movie:blocked"],
      },
      categories: [
        { kind: "movie", id: "personal", visibility: "show", dashboard: false },
        { kind: "movie", id: "hidden", visibility: "block", dashboard: false },
        { kind: "movie", id: "blocked", visibility: "block", dashboard: false },
      ],
    },
    discoveryResponse: {
      configured: false,
      refreshing: false,
      trendingMovies: [],
      trendingSeries: [],
      exploreMovies: [allowed, personal, hidden, blocked].map((item) => ({
        item,
        name: item.name,
      })),
      exploreSeries: [],
    },
  });
  const discoveryReady = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/discovery",
  );
  await page.goto("/?view=dashboard");
  const recent = page.getByRole("region", {
    name: "Recently played",
    exact: true,
  });
  const continuing = page.getByRole("region", {
    name: "Continue watching",
    exact: true,
  });
  try {
    await discoveryReady;
    await page.waitForTimeout(100);
    await expect(recent).toHaveCount(0);
    await expect(continuing).toHaveCount(0);
    await expect(page.locator(".discovery-poster-card")).toHaveCount(0);
  } finally {
    releasePreferences();
  }
  for (const title of [allowed, personal]) {
    await expect(recent).toContainText(title.name);
    await expect(
      continuing.getByRole("button", {
        name: `Resume ${title.name}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  for (const title of [hidden, blocked]) {
    await expect(recent).not.toContainText(title.name);
    await expect(
      continuing.getByRole("button", {
        name: `Resume ${title.name}`,
        exact: true,
      }),
    ).toHaveCount(0);
  }
  const explore = page.getByRole("region", { name: "Explore", exact: true });
  for (const title of [personal, hidden, blocked])
    await expect(
      explore.getByRole("button", { name: `Open ${title.name}`, exact: true }),
    ).toHaveCount(0);
  const navigation = page.getByRole("navigation", {
    name: "Library",
    exact: true,
  });
  await navigateLibrary(page, "movie");
  const listing = page.getByRole("region", {
    name: "Movies library",
    exact: true,
  });
  await expect(
    listing.getByRole("button", { name: `Open ${personal.name}`, exact: true }),
  ).toBeVisible();
  for (const title of [hidden, blocked])
    await expect(
      listing.getByRole("button", { name: `Open ${title.name}`, exact: true }),
    ).toHaveCount(0);
  const search = await openSearch(page);
  await search.fill(personal.name);
  const searchListing = page.getByRole("region", {
    name: "Movies results",
    exact: true,
  });
  await expect(
    searchListing.getByRole("button", {
      name: `Open ${personal.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await searchListing
    .getByRole("button", { name: `Open ${personal.name}`, exact: true })
    .click();
  await page
    .getByRole("region", { name: "Expanded title", exact: true })
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect.poll(() => api.sessionItemIds).toEqual([personal.id]);
  await expect(page.locator("video")).toHaveCount(1);
  await playableVideo(page);
  const changed = api.effectivePreferences();
  changed.categories = changed.categories.map((rule) =>
    rule.id === "personal" ? { ...rule, visibility: "block" } : rule,
  );
  changed.configuration.blockedCategories.push("movie:personal");
  api.deployConfiguration(changed);
  await expect(page.locator("video")).toHaveCount(0, { timeout: 15000 });
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await expect(
    searchListing.getByRole("button", {
      name: `Open ${personal.name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("view") === "search" &&
      url.searchParams.get("search") === personal.name,
  );
  await expect(search).toBeVisible();
  await expect(search).toHaveValue(personal.name);
  await navigation.getByRole("button", { name: "Home", exact: true }).click();
  await expect(recent).not.toContainText(personal.name);
  for (const title of [hidden, blocked]) {
    await page.goto(`/?view=player&section=movie&item=${title.id}`);
    await expect(
      page
        .getByRole("region", { name: "Watch workspace", exact: true })
        .getByRole("alert"),
    ).toContainText(/blocked|unavailable|available/i);
    await expect(page.locator("video")).toHaveCount(0);
  }
  expect(api.sessionItemIds).toEqual([personal.id]);
  expect(
    api.mutations.filter((request) => request.path === "/api/preferences"),
  ).toEqual([]);
  expect(api.history.read().length).toBe(4);
});

test("Dashboard applies saved category rules to stale and mixed-case history without deleting records", async ({
  page,
}) => {
  const allowed = {
    ...movie,
    id: "movie-allowed",
    name: "Allowed Current",
    categoryId: "allowed",
  };
  const legacy = {
    ...movie,
    id: "movie-legacy",
    name: "Allowed Legacy",
    category: "DRAMA",
  };
  const unlisted = {
    ...movie,
    id: "movie-unknown",
    name: "Unknown Resume",
    categoryId: "removed",
    category: "Unlisted archive",
  };
  const excluded = [
    {
      ...movie,
      id: "movie-hidden-archive",
      name: "Hidden Archive Title",
      categoryId: "missing-hidden",
      category: "HIDDEN ARCHIVE",
    },
    {
      ...movie,
      id: "movie-blocked-archive",
      name: "Blocked Archive Title",
      categoryId: "missing-blocked",
      category: "BLOCKED ARCHIVE",
    },
    {
      ...movie,
      id: "movie-known-hidden",
      name: "Known Mixed Case",
      categoryId: "MiXeD",
      category: "Known hidden",
    },
  ];
  const entries = [
    { ...allowed, categoryId: "AlLoWeD" },
    legacy,
    unlisted,
    ...excluded,
  ].map((title, index) => ({
    title,
    item: title,
    watchedAt: Date.now() - index * 1000,
    position: 300,
    duration: 1800,
    completed: false,
  }));
  const history = createHistoryFixture();
  history.seed(entries);
  const api = await mockApi(page, {
    history,
    catalogItems: [allowed],
    categories: [
      { id: "allowed", name: "Drama", kind: "movie" },
      { id: "mixed", name: "Known hidden", kind: "movie" },
    ],
    preferences: {
      refreshIntervalSeconds: 21600,
      configuration: {
        dashboardCategories: [
          "MOVIE:AlLoWeD",
          "movie:Hidden archive",
          "movie:Blocked archive",
          "movie:MiXeD",
        ],
        blockedCategories: [
          "MOVIE:Hidden archive",
          "movie:MIXED",
          "movie:Blocked archive",
        ],
      },
      categories: [
        { kind: "movie", id: "mixed", visibility: "block", dashboard: true },
      ],
    },
    discoveryResponse: {
      configured: false,
      refreshing: false,
      trendingMovies: [],
      trendingSeries: [],
      exploreMovies: [{ item: allowed, name: allowed.name }],
      exploreSeries: [],
    },
  });
  await page.goto("/?view=dashboard");
  const recent = page.getByRole("region", {
    name: "Recently played",
    exact: true,
  });
  const continuing = page.getByRole("region", {
    name: "Continue watching",
    exact: true,
  });
  await expect(recent.locator(".discovery-recent-card")).toHaveCount(3);
  await expect(continuing.locator(".discovery-continue-card")).toHaveCount(3);
  for (const title of [allowed, legacy, unlisted]) {
    await expect(
      recent.getByRole("button", { name: `Open ${title.name}`, exact: true }),
    ).toBeVisible();
    await expect(
      continuing.getByRole("button", {
        name: `Resume ${title.name}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  for (const title of excluded) {
    await expect(recent).not.toContainText(title.name);
    await expect(continuing).not.toContainText(title.name);
  }
  expect(api.history.read().length).toBe(6);
  expect(api.mutations).toEqual([]);
});

for (const base of [movie, series, live]) {
  test(`library-origin ${base.kind} categories and title details preserve the active decoder`, async ({
    page,
  }) => {
    const categoryId = base.kind === "live" ? "news" : `drama-${base.kind}`;
    const label =
      base.kind === "live"
        ? "Live TV"
        : base.kind === "movie"
          ? "Movies"
          : "Shows";
    const current = { ...base, categoryId };
    const outside = {
      ...current,
      id: `${base.kind}-outside`,
      name: "Different Horizon",
      categoryId: "other",
      category: "Other",
    };
    const api = await mockApi(page, {
      catalogItems: [current, outside],
      categories: [
        { id: categoryId, name: base.category, kind: base.kind },
        { id: "other", name: "Other", kind: base.kind },
      ],
      releaseDelayMs: 100,
    });
    await page.goto(`/?section=${base.kind}&category=${categoryId}`);
    await page
      .getByRole("button", { name: `Open ${current.name}`, exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Play",
        exact: true,
      })
      .click();
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await playableVideo(page);
    const video = await page.locator("video").elementHandle();
    const listing = page.getByRole("region", {
      name: `${label} library`,
      exact: true,
    });
    await expect(listing).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await chooseCategory(page, "Other");
    await expect(
      listing.getByRole("button", {
        name: `Open ${outside.name}`,
        exact: true,
      }),
    ).toBeVisible();
    await listing
      .getByRole("button", { name: `Open ${outside.name}`, exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Expanded title", exact: true })
        .getByRole("heading", { name: outside.name, exact: true }),
    ).toBeVisible();
    expect(
      await video!.evaluate(
        (element) => element === document.querySelector("video"),
      ),
    ).toBe(true);
    expect(api.sessionItemIds).toEqual([
      base.kind === "series" ? episodes[0].id : current.id,
    ]);
    expect(api.events).not.toContain("DELETE");
    const sidebar = page.getByRole("complementary", {
      name: "Watch context",
      exact: true,
    });
    if (base.kind === "movie") {
      await sidebar
        .getByRole("region", { name: "In this listing", exact: true })
        .getByRole("button", { name: `Play ${outside.name}`, exact: true })
        .click();
      await expect
        .poll(() => api.sessionItemIds)
        .toEqual([current.id, outside.id]);
      expect(
        api.events.filter((event) => event === "POST" || event === "DELETE"),
      ).toEqual(["POST", "DELETE", "POST"]);
      await expect(page.locator("video")).toHaveCount(1);
    }
    await sidebar
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(page.locator("video")).toHaveCount(0);
    await expect(listing).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get("category") === "other" &&
        !url.searchParams.has("search") &&
        url.searchParams.get("view") !== "player",
    );
  });

  test(`Search ${base.kind} hides its controls during playback and restores its exact query`, async ({
    page,
  }) => {
    const query =
      base.kind === "live"
        ? "North"
        : base.kind === "movie"
          ? "Quiet"
          : "Night";
    const api = await mockApi(page);
    await page.goto(`/?view=search&section=${base.kind}&search=${query}`);
    const results = page.getByRole("region", {
      name: `${base.kind === "movie" ? "Movies" : base.kind === "series" ? "Shows" : "Live TV"} results`,
      exact: true,
    });
    await results
      .getByRole("button", { name: `Open ${base.name}`, exact: true })
      .click();
    await expect(
      results.getByRole("region", { name: "Expanded title", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("section") === base.kind,
    );
    const origin = new URL(page.url());
    if (base.kind === "series") {
      origin.searchParams.set("season", "1");
      origin.searchParams.set("episode", episodes[0].id);
    }
    await page
      .getByRole("button", {
        name: "Play",
        exact: true,
      })
      .click();
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await expect(
      page.getByRole("searchbox", { name: "Search library", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("tablist", { name: "Search type", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Category", exact: true }),
    ).toBeHidden();
    expect(api.events).not.toContain("DELETE");
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(page).toHaveURL(origin.href);
    await expect(
      page.getByRole("searchbox", { name: "Search library", exact: true }),
    ).toHaveValue(query);
    await expect(
      page.getByRole("combobox", { name: "Category", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Open ${base.name}`, exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(1);
  });
}

test("category dropdown supports keyboard selection and retains scoped VOD controls", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/?section=movie");
  const vod = page
    .getByRole("navigation", { name: "Library", exact: true })
    .getByRole("button", { name: "VOD", exact: true });
  await expect(vod.locator("svg")).toHaveCount(1);
  await expect(vod).toHaveAttribute("aria-current", "page");
  const movies = page
    .getByRole("tablist", { name: "VOD type", exact: true })
    .getByRole("tab", { name: "Movies", exact: true });
  await expect(movies).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  const category = page.getByRole("combobox", {
    name: "Category",
    exact: true,
  });
  await expect(category).toHaveAttribute("aria-haspopup", "dialog");
  await page.keyboard.press("Tab");
  await category.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "All categories", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { name: "News", exact: true }),
  ).toHaveCount(0);
  const findCategory = page.getByRole("combobox", {
    name: "Find category",
    exact: true,
  });
  await expect(findCategory).toBeFocused();
  await findCategory.fill("No such category");
  await expect(
    page.getByText("No categories found.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  await findCategory.fill("Drama");
  await expect(
    page.getByRole("option", { name: "Drama", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/category=drama-movie/);
  await expect(category).toContainText("Drama");
  await expect(category).toBeFocused();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await category.click();
  await expect(
    page.getByRole("option", { name: "Drama", exact: true }),
  ).toHaveAttribute("data-current", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("searchbox")).toHaveCount(0);
});

for (const width of [1440, 821, 390, 320]) {
  test(`icon navigation reaches Home, Search, VOD, Live TV and Account settings at ${width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const navigation = page.getByRole("navigation", {
      name: width <= 820 ? "Primary navigation" : "Library",
      exact: true,
    });
    await expectHome(page);
    await expect(navigation.getByRole("button")).toHaveCount(5);
    for (const name of ["Home", "Search", "VOD", "Live TV", "Account"]) {
      const button = navigation.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      await expect(button.locator("svg")).toHaveCount(1);
      await expect(button.locator(".navigation-label")).toHaveCount(0);
      await expect(button).toHaveText("");
      await expect(button).toHaveAttribute("aria-label", name);
    }
    await expect(
      navigation.getByRole("button", { name: "Home", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    if (width > 820) {
      const searchDestination = navigation.getByRole("button", {
        name: "Search",
        exact: true,
      });
      await searchDestination.hover();
      await expect(
        page.getByRole("tooltip", { name: "Search", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await page.mouse.move(width - 4, 4);
      await searchDestination.focus();
      await expect(
        page.getByRole("tooltip", { name: "Search", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
    }
    await navigateLibrary(page, "series");
    await expect(
      page.getByRole("button", { name: "Open Night Shift", exact: true }),
    ).toBeVisible();
    await navigation
      .getByRole("button", { name: "Live TV", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Open North News", exact: true }),
    ).toBeVisible();
    await navigation.getByRole("button", { name: "VOD", exact: true }).click();
    await expect(
      page
        .getByRole("tablist", { name: "VOD type", exact: true })
        .getByRole("tab", { name: "Shows", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await openSettings(page);
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await navigation.getByRole("button", { name: "Home", exact: true }).click();
    await expectHome(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(api.events).not.toContain("POST");
  });
}

for (const width of [1440, 390, 320]) {
  test(`long category dropdown scrolls and filters titles without page overflow at ${width}px`, async ({
    page,
  }) => {
    const longCategory =
      "Genre 23 — International independent cinema and award-winning documentaries";
    const categories = Array.from({ length: 60 }, (_, index) => ({
      id: `genre-${index}`,
      name:
        index === 23 ? longCategory : `Genre ${String(index).padStart(2, "0")}`,
      kind: "movie",
    }));
    const titles = categories.map((category, index) => ({
      ...movie,
      id: `film-${index}`,
      categoryId: category.id,
      category: category.name,
      name: `Film ${index}`,
    }));
    await mockApi(page, { categories, catalogItems: titles });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?section=movie");
    const category = page.getByRole("combobox", {
      name: "Category",
      exact: true,
    });
    await category.click();
    const popup = page.getByRole("listbox");
    await expect(popup).toBeVisible();
    const bounds = await popup.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
    await expect
      .poll(() =>
        popup.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await page.keyboard.press("End");
    const last = page.getByRole("option", { name: "Genre 59", exact: true });
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(last).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/category=genre-59/);
    await expect(category).toContainText("Genre 59");
    await expect(
      page.getByRole("button", { name: "Open Film 59", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Film 0", exact: true }),
    ).toHaveCount(0);
    await category.click();
    await page
      .getByRole("combobox", { name: "Find category", exact: true })
      .fill("Genre 23");
    await expect(
      page.getByRole("option", { name: longCategory, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Open Film 23", exact: true }),
    ).toBeVisible();
    await expect(category).toContainText(longCategory);
    const selectedBounds = await category.boundingBox();
    const tabsBounds = await page
      .getByRole("tablist", { name: "VOD type", exact: true })
      .boundingBox();
    expect(selectedBounds).not.toBeNull();
    expect(tabsBounds).not.toBeNull();
    expect(selectedBounds!.x).toBeGreaterThanOrEqual(
      tabsBounds!.x + tabsBounds!.width,
    );
    expect(
      selectedBounds!.x - (tabsBounds!.x + tabsBounds!.width),
    ).toBeLessThanOrEqual(32);
    expect(
      Math.abs(
        selectedBounds!.y +
          selectedBounds!.height / 2 -
          (tabsBounds!.y + tabsBounds!.height / 2),
      ),
    ).toBeLessThanOrEqual(2);
    expect(selectedBounds!.x + selectedBounds!.width).toBeLessThanOrEqual(
      width,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

for (const title of [movie, series, live]) {
  test(`Clear filters resets the ${title.kind} listing while keeping playback active`, async ({
    page,
  }) => {
    const category = title.kind === "live" ? "news" : `drama-${title.kind}`;
    const api = await mockApi(page, {
      catalogItems: [{ ...title, categoryId: category }],
      categories: [
        { id: category, name: title.category, kind: title.kind },
        { id: "empty", name: "Empty category", kind: title.kind },
      ],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      title.kind === "live"
        ? `/?section=live&category=empty&item=${title.id}`
        : `/?section=${title.kind}&category=${category}`,
    );
    if (title.kind !== "live") {
      await page
        .getByRole("button", { name: `Open ${title.name}`, exact: true })
        .click();
    }
    await page
      .getByRole("button", {
        name: "Play",
        exact: true,
      })
      .click();
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await playableVideo(page);
    const originalVideo = await page.locator("video").elementHandle();
    if (title.kind !== "live") await chooseCategory(page, "Empty category");
    await expect(page.locator(".empty-state")).toBeVisible();
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Category", exact: true }),
    ).toContainText("All categories");
    await expect(page).toHaveURL(/view=player/);
    expect(
      await originalVideo!.evaluate(
        (element) => element === document.querySelector("video"),
      ),
    ).toBe(true);
    expect(api.sessionItemIds).toEqual([
      title.kind === "series" ? episodes[0].id : title.id,
    ]);
    expect(api.events).not.toContain("DELETE");
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    expect(new URL(page.url()).searchParams.get("search")).toBeNull();
    expect(new URL(page.url()).searchParams.get("category")).toBeNull();
  });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`dispersed play logo stays fragmented and respects ${reducedMotion} motion`, async ({
    page,
  }) => {
    await mockApi(page);
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
    const brand = page
      .getByRole("button", { name: "Restream home", exact: true })
      .locator(".brand-mark");
    await expect(brand).toBeVisible();
    const fragments = brand.locator(".brand-fragment");
    await expect(fragments).toHaveCount(4);
    await expect(fragments.first()).toHaveCSS(
      "animation-name",
      reducedMotion === "reduce" ? "none" : "brand-assemble",
    );
    await expect(brand.locator(".brand-resolved")).toHaveCount(0);
    await expect(brand.locator(".brand-fragment-top")).toHaveCSS(
      "fill",
      "rgb(245, 245, 247)",
    );
    for (const fragment of ["center", "tip"])
      await expect(brand.locator(`.brand-fragment-${fragment}`)).toHaveCSS(
        "fill",
        "rgb(240, 138, 131)",
      );
    for (const fragment of await fragments.all())
      await expect(fragment).toHaveCSS("opacity", "1");
    const before = await fragments
      .first()
      .evaluate((element) => element.getAnimations()[0]?.currentTime ?? null);
    await navigateLibrary(page, "movie");
    await page.getByRole("button", { name: "Home", exact: true }).click();
    const after = await fragments
      .first()
      .evaluate((element) => element.getAnimations()[0]?.currentTime ?? null);
    if (reducedMotion === "no-preference") expect(after).toBe(before);
    else expect(after).toBeNull();
  });
}

for (const width of [390, 320]) {
  test(`Search reveals its first expanded title above mobile navigation with reduced motion at ${width}px`, async ({
    page,
  }) => {
    await mockApi(page);
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/?view=search&search=Quiet");
    const results = page.getByRole("region", {
      name: "Movies results",
      exact: true,
    });
    await results
      .getByRole("button", { name: "Open The Quiet Coast", exact: true })
      .click();
    const details = results.getByRole("region", {
      name: "Expanded title",
      exact: true,
    });
    await expect(details).toBeVisible();
    const play = details.getByRole("button", { name: "Play", exact: true });
    const close = details.getByRole("button", {
      name: "Close title details",
      exact: true,
    });
    const navigation = page.getByRole("navigation", {
      name: "Primary navigation",
      exact: true,
    });
    await expect
      .poll(
        async () => {
          const [playBounds, closeBounds, navBounds] = await Promise.all([
            play.boundingBox(),
            close.boundingBox(),
            navigation.boundingBox(),
          ]);
          return Boolean(
            playBounds &&
            closeBounds &&
            navBounds &&
            playBounds.y >= 0 &&
            closeBounds.y >= 0 &&
            playBounds.y + playBounds.height <= navBounds.y + 1 &&
            closeBounds.y + closeBounds.height <= navBounds.y + 1,
          );
        },
        {
          message:
            "First Search expansion reveals Play and close above the fixed navigation",
        },
      )
      .toBe(true);
    await expect(
      details.getByRole("heading", { name: movie.name, exact: true, level: 1 }),
    ).toBeFocused();
    await play.click();
    await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
    await expect(
      page.getByRole("searchbox", { name: "Search library", exact: true }),
    ).toBeHidden();
  });
}

for (const width of [1440, 390, 320]) {
  test(`global Search groups, query and player origin survive navigation at ${width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".site-header")).toHaveCount(0);
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    const search = await openSearch(page);
    await expect(search).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Search", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("tablist", { name: "Search type", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Category", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
    await search.fill("North");
    await expect(
      page.getByRole("button", { name: "Open North News", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get("view") === "search" &&
        url.searchParams.get("search") === "North",
    );
    await page.reload();
    await expect(search).toHaveValue("North");
    await page
      .getByRole("button", { name: "Open North News", exact: true })
      .click();
    const origin = page.url();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page).toHaveURL(/view=player/);
    await expect(search).toBeHidden();
    const navigation = page.getByRole("navigation", {
      name: width <= 820 ? "Primary navigation" : "Library",
      exact: true,
    });
    await expect(
      navigation.getByRole("button", { name: "Search", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect.poll(() => api.sessionItemIds).toEqual([live.id]);
    await page.goBack();
    await expect(page).toHaveURL(origin);
    await expect(page.locator("video")).toHaveCount(0);
    await expect(search).toHaveValue("North");
    await page.goForward();
    await expect(page).toHaveURL(/view=player/);
    await expect.poll(() => api.sessionItemIds).toEqual([live.id, live.id]);
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(page).toHaveURL(origin);
    await expect(search).toHaveValue("North");
    await openSettings(page);
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await navigation.getByRole("button", { name: "VOD", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Open The Quiet Coast", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("search")).toBeNull();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

for (const width of [1440, 390, 320]) {
  test(`VOD tabs keep header identity and focus while only the catalog loads at ${width}px`, async ({
    page,
  }) => {
    let releaseShows!: () => void;
    const showsGate = new Promise<void>((resolve) => {
      releaseShows = resolve;
    });
    await mockApi(page, {
      browseResponse: async (params) => {
        if (params.get("kind") === "series") await showsGate;
        return {
          items: [params.get("kind") === "series" ? series : movie],
          page: 1,
          total: 1,
          hasMore: false,
        };
      },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?section=movie");
    await expect(
      page.getByRole("button", { name: "Open The Quiet Coast", exact: true }),
    ).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "VOD type", exact: true });
    const category = page.getByRole("combobox", {
      name: "Category",
      exact: true,
    });
    const tabsBounds = await tabs.boundingBox();
    const categoryBounds = await category.boundingBox();
    expect(tabsBounds).not.toBeNull();
    expect(categoryBounds).not.toBeNull();
    const gap = categoryBounds!.x - (tabsBounds!.x + tabsBounds!.width);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(32);
    expect(
      Math.abs(
        categoryBounds!.y +
          categoryBounds!.height / 2 -
          (tabsBounds!.y + tabsBounds!.height / 2),
      ),
    ).toBeLessThanOrEqual(2);
    expect(categoryBounds!.x + categoryBounds!.width).toBeLessThanOrEqual(
      width,
    );
    const originalTabs = await tabs.elementHandle();
    const originalCategory = await category.elementHandle();
    const movies = tabs.getByRole("tab", { name: "Movies", exact: true });
    const shows = tabs.getByRole("tab", { name: "Shows", exact: true });
    const documentRequests: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) documentRequests.push(request.url());
    });
    await page.evaluate(() => {
      (window as unknown as { vodIdentityToken: string }).vodIdentityToken =
        "same-vod-document";
    });
    try {
      await shows.click();
      await expect(shows).toHaveAttribute("aria-selected", "true");
      await expect(shows).toBeFocused();
      await expect(shows).toHaveCSS("outline-style", "none");
      const panel = page.getByRole("tabpanel", {
        name: "Shows",
        exact: true,
      });
      await expect(
        panel.getByRole("status", { name: "Loading titles", exact: true }),
      ).toBeVisible();
      await expect(tabs).toBeVisible();
      await expect(category).toBeVisible();
      if (process.env.CAPTURE_SCREENSHOTS)
        await page.screenshot({
          path: `../output/cinema-review/${width}-vod-loading.png`,
          fullPage: false,
          animations: "disabled",
        });
      expect(
        await originalTabs!.evaluate(
          (element) =>
            element.isConnected &&
            element ===
              document.querySelector('[role="tablist"][aria-label="VOD type"]'),
        ),
      ).toBe(true);
      expect(
        await originalCategory!.evaluate(
          (element) =>
            element.isConnected &&
            element ===
              document.querySelector(
                '[role="combobox"][aria-label="Category"]',
              ),
        ),
      ).toBe(true);
      releaseShows();
      await expect(
        panel.getByRole("button", { name: "Open Night Shift", exact: true }),
      ).toBeVisible();
      await expect(shows).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(movies).toBeFocused();
      await expect(movies).toHaveCSS("outline-style", "none");
      await expect(shows).toHaveAttribute("aria-selected", "true");
      if (process.env.CAPTURE_SCREENSHOTS)
        await page.screenshot({
          path: `../output/cinema-review/${width}-vod-keyboard-focus.png`,
          animations: "disabled",
        });
      await page.keyboard.press("Enter");
      await expect(movies).toHaveAttribute("aria-selected", "true");
      await expect(movies).toBeFocused();
      await expect(
        page
          .getByRole("tabpanel", { name: "Movies", exact: true })
          .getByRole("button", { name: "Open The Quiet Coast", exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(shows).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("tabpanel", { name: "Shows", exact: true }),
      ).toBeVisible();
      await page.goForward();
      await expect(movies).toHaveAttribute("aria-selected", "true");
      expect(
        await originalTabs!.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(
        await originalCategory!.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { vodIdentityToken: string })
              .vodIdentityToken,
        ),
      ).toBe("same-vod-document");
      expect(documentRequests).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    } finally {
      releaseShows();
    }
  });
}

test("cached browse results update in place and stop polling at 1440px", async ({
  page,
}) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  let ready = false;
  let calls = 0;
  await mockApi(page, {
    browseResponse: async () => {
      calls++;
      return {
        items: ready ? [{ ...movie, name: "New Coast" }] : [movie],
        page: 1,
        total: 1,
        hasMore: false,
        revision: ready ? 2 : 1,
        stale: !ready,
        refreshing: !ready,
      };
    },
  });
  await page.clock.install();
  await page.goto("/?section=movie");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  const category = page.getByRole("combobox", {
    name: "Category",
    exact: true,
  });
  await category.focus();
  ready = true;
  await expect(
    page.getByRole("button", { name: "Open New Coast" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toHaveCount(0);
  await expect(category).toBeFocused();
  const completed = calls;
  await page.clock.fastForward(1200);
  expect(calls).toBe(completed);
});

test("search replaces shifted cached pages together at 1440px", async ({
  page,
}) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  let ready = false;
  let releaseThird!: () => void;
  const thirdPage = new Promise<void>((resolve) => {
    releaseThird = resolve;
  });
  const requests: string[] = [];
  const a = { ...movie, id: "a", name: "Coast A" };
  const b = { ...movie, id: "b", name: "Coast B" };
  const x = { ...movie, id: "x", name: "Coast X" };
  await mockApi(page, {
    browseResponse: async (params) => {
      if (params.get("kind") !== "movie")
        return { items: [], page: 1, total: 0, hasMore: false };
      requests.push(params.toString());
      if (params.has("through"))
        return {
          items: ready ? [x, a, a] : [a, b],
          page: 2,
          total: 3,
          hasMore: true,
          revision: 2,
          stale: !ready,
          refreshing: !ready,
        };
      if (params.get("page") === "1")
        return { items: [a], page: 1, total: 2, hasMore: true, revision: 1 };
      if (params.get("page") === "2")
        return {
          items: [b],
          page: 2,
          total: 3,
          hasMore: true,
          revision: 2,
          stale: true,
          refreshing: true,
        };
      await thirdPage;
      return { items: [b], page: 3, total: 3, hasMore: false, revision: 2 };
    },
  });
  await page.goto("/?section=live");
  const search = await openSearch(page);
  await search.fill("Coast");
  await expect(
    page.getByRole("button", { name: "Open Coast A" }),
  ).toBeVisible();
  expect(new URLSearchParams(requests[0]).get("page")).toBe("1");
  await expect
    .poll(() => requests.some((query) => query.includes("through=2")))
    .toBe(true);
  await expect(page.getByRole("button", { name: "Open Coast B" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Open Coast A" }),
  ).toBeVisible();
  ready = true;
  await expect(
    page.getByRole("button", { name: "Open Coast X" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Coast A" })).toHaveCount(
    1,
  );
  await expect(page.getByRole("button", { name: "Open Coast B" })).toHaveCount(
    0,
  );
  await expect(search).toHaveValue("Coast");
  await expect
    .poll(() =>
      requests.some((query) => new URLSearchParams(query).get("page") === "3"),
    )
    .toBe(true);
  releaseThird();
  await expect(
    page.getByRole("button", { name: "Open Coast B" }),
  ).toBeVisible();
  expect(new URLSearchParams(requests.at(-1)).get("page")).toBe("3");
  expect(new URLSearchParams(requests.at(-1)).has("through")).toBe(false);
});

test("episode revalidation adds seasons while preserving selection at 1440px", async ({
  page,
}) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  let ready = false;
  let calls = 0;
  const extra = {
    ...episodes[2],
    id: "episode-4",
    episode: 2,
    name: "New Arrival",
  };
  await mockApi(page, {
    episodesResponse: (params) => {
      calls++;
      expect(params.get("season")).toBe("2");
      return {
        items: ready ? [episodes[2], extra] : [episodes[2]],
        season: 2,
        seasons: ready ? [1, 2, 3] : [1, 2],
        refreshing: !ready,
      };
    },
  });
  await page.clock.install();
  await page.goto("/?section=series&item=series-1&season=2&episode=episode-3");
  await expect(
    page.getByRole("button", { name: "Play Fresh Start", exact: true }),
  ).toBeVisible();
  const season = page.getByRole("combobox", { name: "Season", exact: true });
  await season.focus();
  ready = true;
  await expect(
    page.getByRole("button", { name: "Play New Arrival", exact: true }),
  ).toBeVisible();
  await expect(season).toContainText("Season 2");
  await expect(season).toBeFocused();
  await expect(page.locator(".selected-episode")).toContainText("Fresh Start");
  await season.click();
  await expect(
    page.getByRole("option", { name: "Season 3", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const completed = calls;
  await page.clock.fastForward(1200);
  expect(calls).toBe(completed);
});

test("leaving a cached listing cancels its background revalidation", async ({
  page,
}) => {
  let calls = 0;
  await mockApi(page, {
    browseResponse: async () => {
      calls++;
      return {
        items: [movie],
        page: 1,
        total: 1,
        hasMore: false,
        revision: 1,
        stale: true,
        refreshing: true,
      };
    },
  });
  await page.clock.install();
  await page.goto("/?section=movie");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await navigateLibrary(page, "live");
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible();
  const cancelled = calls;
  await page.clock.fastForward(1200);
  expect(calls).toBe(cancelled);
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toHaveCount(0);
});

test("invalidated later pages stay hidden during provider backoff", async ({
  page,
}) => {
  let ready = false;
  let calls = 0;
  const second = { ...movie, id: "second", name: "Second Coast" };
  await mockApi(page, {
    browseResponse: async (params) => {
      if (params.get("kind") !== "movie")
        return { items: [], page: 1, hasMore: false };
      calls++;
      if (params.has("through"))
        return {
          items: [movie, second],
          page: 2,
          total: 2,
          hasMore: false,
          revision: 2,
          stale: true,
          refreshing: false,
        };
      if (params.get("page") === "1")
        return {
          items: [movie],
          page: 1,
          total: 2,
          hasMore: true,
          revision: 2,
        };
      return {
        items: [second],
        page: 2,
        total: 2,
        hasMore: false,
        revision: 2,
        stale: !ready,
        refreshing: false,
      };
    },
  });
  await page.clock.install();
  await page.goto("/?section=live");
  await (await openSearch(page)).fill("Coast");
  await expect(page.getByRole("alert")).toContainText(
    "This listing could not be refreshed",
  );
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Second Coast" }),
  ).toHaveCount(0);
  const backedOff = calls;
  await page.clock.fastForward(1200);
  expect(calls).toBe(backedOff);
  ready = true;
  await page.getByRole("button", { name: "Retry movies", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open Second Coast" }),
  ).toBeVisible();
});

test("scheduled library updates retain the loaded search range until revalidation settles", async ({
  page,
}) => {
  let settled = false;
  const requests: string[] = [];
  const second = { ...movie, id: "second", name: "Second Coast" };
  const added = { ...movie, id: "added", name: "Added Coast" };
  const api = await mockApi(page, {
    browseResponse: async (params) => {
      if (params.get("kind") !== "movie")
        return { items: [], page: 1, hasMore: false };
      requests.push(params.toString());
      if (params.has("through"))
        return {
          items: settled ? [added, movie] : [movie, second],
          page: 2,
          total: 2,
          hasMore: false,
          revision: settled ? 2 : 1,
          stale: !settled,
          refreshing: !settled,
        };
      const pageNumber = Number(params.get("page"));
      return {
        items: pageNumber === 1 ? [movie] : [second],
        page: pageNumber,
        total: 2,
        hasMore: pageNumber === 1,
        revision: 1,
      };
    },
  });
  await page.goto("/?section=live");
  const search = await openSearch(page);
  await search.fill("Coast");
  await expect(
    page.getByRole("button", { name: "Open Second Coast" }),
  ).toBeVisible();
  await search.focus();
  api.publishSnapshot();
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect
    .poll(() => requests.some((query) => query.includes("through=2")))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Open Second Coast" }),
  ).toBeVisible();
  await expect(search).toHaveValue("Coast");
  await expect(search).toBeFocused();
  settled = true;
  await expect(
    page.getByRole("button", { name: "Open Added Coast" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Second Coast" }),
  ).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("search waits for category policy then loads results without duplicate requests", async ({
  page,
}) => {
  let release!: () => void;
  const preferencesGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = await mockApi(page, { preferencesGate });
  try {
    await page.goto("/?view=search&search=Coast");
    const requests = () =>
      api.events.filter((event) => event.startsWith("BROWSE:"));
    await expect(
      page.getByRole("searchbox", { name: "Search library" }),
    ).toBeVisible();
    await page.waitForTimeout(450);
    expect(requests()).toHaveLength(0);
    release();
    await expect.poll(() => requests().length).toBe(2);
    await expect(
      page.getByRole("button", { name: "Open The Quiet Coast" }),
    ).toBeVisible();
    expect(requests()).toHaveLength(2);
  } finally {
    release();
  }
});

test("server history undo restores progress and preserves newer playback at 390px", async ({
  page,
}) => {
  const width = 390;
  await page.setViewportSize({ width, height: 900 });
  const api = await mockApi(page);
  api.history.seed([
    {
      title: movie,
      item: movie,
      watchedAt: now,
      position: 300,
      duration: 3600,
      completed: false,
    },
    {
      title: live,
      item: live,
      watchedAt: now - 1000,
      position: 0,
      duration: 0,
      completed: false,
    },
  ]);
  const saved = api.history.read();
  await page.goto("/?view=dashboard");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await page
    .getByRole("button", {
      name: `Remove ${movie.name} from history`,
      exact: true,
    })
    .click();
  await expect(undo).toBeVisible();
  await expect
    .poll(() => api.history.read().map((entry) => entry.title.id))
    .toEqual([live.id]);
  const pill = await undo.locator("..").boundingBox();
  const nav = await page
    .getByRole("navigation", { name: "Primary navigation" })
    .boundingBox();
  expect(pill!.y + pill!.height).toBeLessThan(nav!.y);
  await undo.click();
  await expect.poll(() => api.history.read()).toEqual(saved);
  await expect(undo).toHaveCount(0);
  await page
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  await expect.poll(() => api.history.read()).toEqual([]);
  await undo.click();
  await expect.poll(() => api.history.read()).toEqual(saved);
  await page
    .getByRole("button", {
      name: `Remove ${movie.name} from history`,
      exact: true,
    })
    .click();
  await expect(undo).toBeVisible();
  // Simulate a new playback record received from a second device while the
  // removal's undo token is still offered. Undo must preserve that progress.
  api.history.seed([
    { ...saved[0], position: 900, playbackId: "new-device" },
    saved[1],
  ]);
  await undo.click();
  await expect.poll(() => api.history.read()[0]?.position).toBe(900);
  await expect(
    page.getByRole("region", { name: "Continue watching" }),
  ).toBeVisible();
});

test("direct player retries retain errors while resolving titles and episodes at 390px", async ({
  page,
}) => {
  const width = 390;
  await page.setViewportSize({ width, height: 900 });
  const api = await mockApi(page, { episodesFailureOnce: true });
  let itemAttempts = 0;
  let releaseItem!: () => void;
  const itemGate = new Promise<void>((resolve) => {
    releaseItem = resolve;
  });
  await page.route("**/api/items/series-1", async (route) => {
    if (++itemAttempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Title temporarily unavailable" },
      });
    await itemGate;
    return route.fallback();
  });
  await page.goto(
    "/?view=player&section=series&item=series-1&season=1&episode=episode-1",
  );
  const alert = page.getByRole("alert");
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(alert).toContainText("Title temporarily unavailable");
  try {
    await retry.click();
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toBeFocused();
    await expect(alert).toContainText("Title temporarily unavailable");
  } finally {
    releaseItem();
  }
  await expect(alert).toContainText("Episodes are temporarily unavailable");
  await expect(retry).not.toHaveAttribute("aria-busy", "true");
  let releaseEpisodes!: () => void;
  const episodesGate = new Promise<void>((resolve) => {
    releaseEpisodes = resolve;
  });
  await page.route("**/api/series/series-1/episodes?*", async (route) => {
    await episodesGate;
    return route.fallback();
  });
  try {
    await retry.click();
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toHaveText("Retrying…");
    await expect(retry).toBeFocused();
    await expect(alert).toContainText("Episodes are temporarily unavailable");
  } finally {
    releaseEpisodes();
  }
  await expect(
    page.getByRole("region", { name: "Player", exact: true }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(api.sessionItemIds).toEqual(["episode-1"]);
});

for (const width of [1440, 390]) {
  test(`Home shows distinct Trending and Explore rails at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const extraMovie = {
      ...movie,
      id: "explore-movie",
      name: "Another Coast",
      categoryId: "drama-movie",
    };
    const extraSeries = {
      ...series,
      id: "explore-series",
      name: "Morning Shift",
      categoryId: "drama-series",
    };
    const outside = {
      ...movie,
      id: "outside-home",
      name: "Outside Home",
      categoryId: "outside",
      category: "Other",
    };
    const blocked = {
      ...movie,
      id: "blocked-discovery",
      name: "Blocked Discovery",
      categoryId: "blocked",
      category: "Restricted",
    };
    const api = await mockApi(page, {
      catalogItems: [
        live,
        movie,
        series,
        extraMovie,
        extraSeries,
        outside,
        blocked,
      ],
      preferences: {
        refreshIntervalSeconds: 21600,
        configuration: {
          dashboardCategories: ["movie:drama-movie", "series:drama-series"],
          blockedCategories: ["movie:blocked"],
        },
        categories: [],
      },
    });
    const title = (item: Record<string, unknown>) => ({
      item,
      name: item.name,
      poster: "/artwork-title.svg",
      year: 2025,
    });
    let phase = 0;
    // Return overlapping, repeated and disallowed entries to exercise the UI's
    // current policy and deduplication even with a stale discovery response.
    await page.route("**/api/discovery", (route) =>
      route.fulfill({
        json: {
          configured: true,
          refreshing: false,
          trendingMovies: [
            movie,
            movie,
            outside,
            blocked,
            ...(phase === 1 || phase === 2 ? [extraMovie] : []),
          ].map(title),
          trendingSeries: [series, series].map(title),
          exploreMovies: (phase === 2
            ? [movie]
            : [movie, extraMovie, extraMovie, outside, blocked]
          ).map(title),
          exploreSeries: (phase === 2
            ? [series]
            : [series, extraSeries, extraSeries]
          ).map(title),
        },
      }),
    );
    await page.goto("/");
    const home = page.getByRole("region", { name: "Home", exact: true });
    const trending = home.getByRole("region", {
      name: "Trending now",
      exact: true,
    });
    const explore = home.getByRole("region", { name: "Explore", exact: true });
    const trendingCards = trending
      .getByRole("group", { name: "Titles", exact: true })
      .getByRole("button");
    const exploreCards = explore
      .getByRole("group", { name: "Titles", exact: true })
      .getByRole("button");
    await expect(trendingCards).toHaveCount(2);
    await expect(exploreCards).toHaveCount(2);
    await expect(trendingCards.nth(0)).toHaveAccessibleName(
      `Open ${movie.name}`,
    );
    await expect(trendingCards.nth(1)).toHaveAccessibleName(
      `Open ${series.name}`,
    );
    await expect(exploreCards.nth(0)).toHaveAccessibleName(
      `Open ${extraMovie.name}`,
    );
    await expect(exploreCards.nth(1)).toHaveAccessibleName(
      `Open ${extraSeries.name}`,
    );
    await expect(
      home.locator(".discovery-picks > .discovery-section-heading h2"),
    ).toHaveText(["Trending now", "Explore"]);
    for (const item of [outside, blocked])
      await expect(
        home.getByRole("button", { name: `Open ${item.name}`, exact: true }),
      ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/home-rails/home-${width}.png`,
        fullPage: true,
      });

    phase = 1;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(trendingCards).toHaveCount(3);
    await expect(exploreCards).toHaveCount(1);
    await expect(exploreCards.first()).toHaveAccessibleName(
      `Open ${extraSeries.name}`,
    );
    phase = 2;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(explore).toHaveCount(0);
    await expect(trendingCards).toHaveCount(3);
    phase = 3;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(exploreCards).toHaveCount(2);
    await explore
      .getByRole("button", { name: `Open ${extraMovie.name}`, exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Expanded title", exact: true })
        .getByRole("heading", { name: extraMovie.name, exact: true }),
    ).toBeVisible();
    expect(api.sessionItemIds).toEqual([]);
  });

  test(`Trending mixes movies and shows with edge overlays and release captions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const movies = Array.from({ length: 8 }, (_, index) => ({
      item: index
        ? { ...movie, id: `trending-movie-${index}`, name: `Film ${index}` }
        : movie,
      name: index ? `Film ${index}` : movie.name,
      poster: "/artwork-title.svg",
      releaseDate: index === 1 ? "2025" : "2026-10-01",
      year: index === 1 ? 2025 : 2026,
    }));
    const shows = Array.from({ length: 8 }, (_, index) => ({
      item: index
        ? { ...series, id: `trending-show-${index}`, name: `Show ${index}` }
        : series,
      name: index ? `Show ${index}` : series.name,
      poster: "/artwork-title.svg",
      releaseDate: index === 1 ? undefined : "2024-02-29",
      year: index === 1 ? undefined : 2024,
    }));
    const api = await mockApi(page, {
      discoveryResponse: {
        configured: true,
        refreshing: false,
        trendingMovies: movies,
        trendingSeries: shows,
        exploreMovies: [],
        exploreSeries: [],
      },
    });
    await page.goto("/?view=dashboard");
    const section = page.getByRole("region", {
      name: "Trending now",
      exact: true,
    });
    const rail = section.getByRole("group", { name: "Titles", exact: true });
    const cards = rail.locator(".discovery-poster-card");
    await expect(cards).toHaveCount(16);
    await expect(cards.nth(0)).toHaveAccessibleName(`Open ${movie.name}`);
    await expect(cards.nth(1)).toHaveAccessibleName(`Open ${series.name}`);
    await expect(cards.nth(0)).toHaveText("Oct 2026 · Movie");
    await expect(cards.nth(1)).toHaveText("Feb 2024 · Show");
    await expect(cards.nth(2)).toHaveText("2025 · Movie");
    await expect(cards.nth(3)).toHaveText("Show");
    await expect(
      section.locator(".discovery-rank, .discovery-type-tabs, h3"),
    ).toHaveCount(0);
    await expect(page.locator(".discovery-attribution")).toHaveCount(0);

    const left = section.getByRole("button", {
      name: "Scroll titles left",
      exact: true,
    });
    const right = section.getByRole("button", {
      name: "Scroll titles right",
      exact: true,
    });
    await expect(left).toHaveCount(0);
    await expect(right).toBeVisible();
    const poster = await cards
      .first()
      .locator(".discovery-poster-art")
      .boundingBox();
    const arrow = await right.boundingBox();
    const bounds = await rail.boundingBox();
    expect(arrow!.x + arrow!.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width,
    );
    expect(arrow!.y + arrow!.height / 2).toBeGreaterThan(poster!.y);
    expect(arrow!.y + arrow!.height / 2).toBeLessThan(
      poster!.y + poster!.height,
    );
    await right.click();
    await expectPointerFocus(page, right);
    await page.keyboard.press("Tab");
    await right.focus();
    await expectKeyboardIcon(page, right);
    await expect(left).toBeVisible();
    await expect
      .poll(() => rail.evaluate((node) => node.scrollLeft))
      .toBeGreaterThan(0);
    await rail.evaluate((node) =>
      node.scrollTo({ left: node.scrollWidth, behavior: "instant" }),
    );
    await expect(right).toHaveCount(0);
    await expect(left).toBeVisible();
    await left.click();
    await expect(right).toBeVisible();
    await rail.evaluate((node) =>
      node.scrollTo({ left: 0, behavior: "instant" }),
    );
    await expect(left).toHaveCount(0);
    await page.keyboard.press("Tab");
    await rail.focus();
    await page.keyboard.press("ArrowRight");
    await expect(left).toBeVisible();
    await rail.evaluate((node) =>
      node.scrollTo({ left: 0, behavior: "instant" }),
    );
    if (process.env.CAPTURE_SCREENSHOTS) {
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `/tmp/restream-trending-mixed-${width}.png`,
      });
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await cards.first().click();
    await expect(
      page.getByRole("region", { name: "Expanded title", exact: true }),
    ).toBeVisible();
    expect(api.events).not.toContain("POST");

    await openSettings(page);
    const about = page.getByRole("region", { name: "About", exact: true });
    await expect(
      about.getByRole("img", { name: "TMDB", exact: true }),
    ).toBeVisible();
    await expect(about).toContainText(
      "This product uses the TMDB API but is not endorsed or certified by TMDB.",
    );
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `/tmp/restream-settings-about-${width}.png`,
      });
  });
}

test("Trending retains its rail while refreshing and adds matches in place", async ({
  page,
}) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  const addedMovie = {
    ...movie,
    id: "movie-new-trend",
    name: "A New Discovery",
  };
  const api = await mockApi(page, {
    catalogItems: [live, movie, addedMovie, series],
  });
  let refreshing = false;
  let expanded = false;
  let requests = 0;
  let release!: () => void;
  let gate: Promise<void> | undefined;
  await page.route("**/api/discovery", async (route) => {
    requests++;
    const json = {
      configured: true,
      refreshing,
      trendingMovies: [movie, ...(expanded ? [addedMovie] : [])].map(
        (item, index) => ({ tmdbId: index + 1, item, name: item.name }),
      ),
      trendingSeries: [{ tmdbId: 3, item: series, name: series.name }],
      exploreMovies: [],
      exploreSeries: [],
    };
    if (gate) await gate;
    await route.fulfill({ json });
  });
  await page.goto("/?view=dashboard");
  const rail = page.getByRole("region", {
    name: "Trending now",
    exact: true,
  });
  const first = rail.getByRole("button", {
    name: `Open ${movie.name}`,
    exact: true,
  });
  await expect(first).toBeVisible();
  await rail.evaluate((node) => {
    (node as HTMLElement).dataset.retained = "yes";
  });
  const feature = page.locator(".discovery-feature");
  await feature.evaluate((node) => {
    (node as HTMLElement).dataset.retained = "yes";
  });
  const before = requests;
  refreshing = true;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refreshResponse = page.waitForResponse("**/api/discovery");
  api.publishSnapshot();
  try {
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect.poll(() => requests).toBeGreaterThan(before);
    await expect(first).toBeVisible();
    await expect(rail).toHaveAttribute("data-retained", "yes");
    await expect(feature).toHaveAttribute("data-retained", "yes");
    await expect(page.locator(".discovery-skeleton-grid")).toHaveCount(0);
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `/tmp/restream-trending-${width}-refreshing.png`,
      });
  } finally {
    release();
    gate = undefined;
  }
  const response = await refreshResponse;
  await response.finished();
  expect((await response.json()).refreshing).toBe(true);
  await expect(
    rail.getByRole("button", { name: `Open ${series.name}`, exact: true }),
  ).toBeVisible();
  expanded = true;
  refreshing = false;
  const refreshingRequests = requests;
  await page.clock.fastForward(5000);
  await expect.poll(() => requests).toBeGreaterThan(refreshingRequests);
  await expect(rail).toHaveAttribute("data-retained", "yes");
  await expect(
    rail.getByRole("button", { name: `Open ${series.name}`, exact: true }),
  ).toBeVisible();
  const added = rail.getByRole("button", {
    name: `Open ${addedMovie.name}`,
    exact: true,
  });
  await expect(added).toBeVisible();
  const settled = requests;
  await page.clock.fastForward(5200);
  expect(requests).toBe(settled);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: `/tmp/restream-trending-${width}-settled.png`,
    });
});

test("Trending fills an empty rail progressively", async ({ page }) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await mockApi(page);
  let requests = 0;
  let releaseProgress!: () => void;
  const progress = new Promise<void>((resolve) => {
    releaseProgress = resolve;
  });
  await page.route("**/api/discovery", async (route) => {
    const requestNumber = ++requests;
    const partial = requestNumber >= 2;
    if (partial) await progress;
    return route.fulfill({
      json: {
        configured: true,
        refreshing: requestNumber < 3,
        trendingMovies: partial
          ? [{ tmdbId: 1, item: movie, name: movie.name }]
          : [],
        trendingSeries:
          requestNumber >= 3
            ? [{ tmdbId: 2, item: series, name: series.name }]
            : [],
        exploreMovies: [],
        exploreSeries: [],
      },
    });
  });
  await page.goto("/?view=dashboard");
  try {
    await expect(page.locator(".discovery-skeleton-grid")).toBeVisible();
  } finally {
    releaseProgress();
  }
  await page.clock.fastForward(2000);
  const rail = page.getByRole("region", {
    name: "Trending now",
    exact: true,
  });
  await expect(
    rail.getByRole("button", { name: `Open ${movie.name}`, exact: true }),
  ).toBeVisible({ timeout: 4500 });
  await page.clock.fastForward(5000);
  await expect.poll(() => requests).toBe(3);
  await expect(
    rail.getByRole("button", { name: `Open ${series.name}`, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
});

test("history undo pauses for hover and focus and expires across navigation", async ({
  page,
}) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const api = await mockApi(page);
  api.history.seed([
    {
      title: movie,
      item: movie,
      watchedAt: now,
      position: 300,
      duration: 3600,
      completed: false,
    },
  ]);
  await page.clock.install();
  await page.goto("/?view=dashboard");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await page
    .getByRole("button", {
      name: `Remove ${movie.name} from history`,
      exact: true,
    })
    .click();
  await undo.hover();
  await page.clock.fastForward(9000);
  await expect(undo).toBeVisible();
  await undo.focus();
  await page.mouse.move(1, 1);
  await page.clock.fastForward(9000);
  await expect(undo).toBeVisible();
  await page.keyboard.press("Escape");
  await page.clock.fastForward(500);
  await expect(undo).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `Remove ${movie.name} from history`,
      exact: true,
    })
    .click();
  await openSettings(page);
  await expect(undo).toBeVisible();
  await page.mouse.move(1, 1);
  // Expiry counts animation frames and clamps long frame gaps; run those
  // frames normally rather than using a single jump as above while paused.
  await page.clock.runFor(8500);
  await expect(undo).toHaveCount(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(undo).toHaveCount(0);
  expect(api.history.read()).toEqual([]);
});
