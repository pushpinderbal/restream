import { expect, test, type Page } from "@playwright/test";

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
const historyKey = "restream.watch-history.v1";
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
    catalogItems?: Record<string, unknown>[];
    categories?: { id: string; name: string; kind: string }[];
    guidePrograms?: Array<(typeof programs)[number] & { description?: string }>;
    discoveryResponse?: Record<string, unknown>;
    preferences?: BrowserPreferences;
    preferencesGate?: Promise<void>;
    preferencesFailure?: boolean | (() => boolean);
    browseResponse?: (params: URLSearchParams) => Promise<{
      items?: Record<string, unknown>[];
      page?: number;
      total?: number;
      hasMore?: boolean;
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
        configured: !options.unconfigured,
        refreshing:
          options.refreshing || refreshRunning.catalog || refreshRunning.epg,
        catalogUpdatedAt: catalogReady ? refreshUpdated.catalog : undefined,
        libraryUpdatedAt: catalogReady ? refreshUpdated.catalog : undefined,
        epgUpdatedAt: refreshUpdated.epg,
        preferencesUpdatedAt,
        activeStreams: active ? 1 : 0,
        maxStreams: 1,
        timezone: "America/Toronto",
        guideHours: 48,
        playback: { transcodeMode: "auto", sessionTimeoutSeconds: 45 },
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
        | "all"
        | "catalog"
        | "epg";
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
      return json({ items: options.episodeItems?.() ?? episodes });
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
    events,
    sessionItemIds,
    sessionStarts,
    mutations,
    effectivePreferences: () => structuredClone(preferences),
    deployConfiguration: (next: BrowserPreferences) => {
      preferences = structuredClone(next);
      preferencesUpdatedAt = new Date().toISOString();
    },
    publishSnapshot: () => {
      catalogReady = true;
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
    await expect(page.locator(".video-controls :focus-visible")).toHaveCount(1);
  };
  await revealControls();
  await expect(page.locator("#inline-title-details")).toHaveCount(0);
  await expect(page.locator(".primary-control")).toBeFocused();
  await expect(page.locator(".video-controls :focus-visible")).toHaveCount(1);
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
    await page
      .getByRole("button", { name: "Play episode", exact: true })
      .click();
    await expect(page).toHaveURL(/view=player/);
    await expect(page).toHaveURL(/season=2/);
    await expect(page).toHaveURL(/episode=episode-3/);
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    await page
      .getByRole("complementary", { name: "Watch context", exact: true })
      .getByRole("button", { name: "Title details", exact: true })
      .click();
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
        name: item.kind === "series" ? "Play episode" : "Play",
        exact: true,
      })
      .click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    expect(new URL(page.url()).searchParams.get("category")).toBeNull();
    expect(new URL(page.url()).searchParams.get("search")).toBe(item.name);
    expect(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).entries[0].title,
        historyKey,
      ),
    ).toMatchObject({
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
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
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
      await page.locator(".playback-area").focus();
      await page.keyboard.press("k");
      await expect(
        page.locator('.playback-feedback[data-action="play"]'),
      ).toHaveCount(1);
      await page.evaluate(() => document.exitFullscreen());
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
  await page.goto("/?section=live");
  await expect(page.getByText("No channels yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh now" })).toHaveCount(
    0,
  );
  api.publishSnapshot();
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(
    page.getByRole("region", { name: "On this channel" }),
  ).toContainText("Morning Report");
  await collapseTitle(page);
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

test("capacity error is announced", async ({ page }) => {
  const api = await mockApi(page, { capacity: true });
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "All streaming slots are in use." }),
  ).toBeVisible();
  await collapseTitle(page);
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible();
});

test("category dropdown opens independently of VOD tabs and Escape restores focus", async ({
  page,
}) => {
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
  expect(await category.evaluate((element) => element.tagName)).toBe("BUTTON");
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
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(category).toHaveAttribute("aria-expanded", "false");
  await expect(category).toBeFocused();
  await expect(movies).toHaveAttribute("aria-selected", "true");
});

test("empty mixed-kind pages advance in bounded groups and preserve the cursor", async ({
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

test("episode rows start playback directly without a second play action", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await page.getByRole("button", { name: /After Hours/ }).click();
  await expect.poll(() => api.sessionItemIds).toEqual(["episode-2"]);
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
  await page.getByRole("button", { name: "Play episode", exact: true }).click();
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
  await page.waitForTimeout(4500);
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

for (const width of [1440, 390, 320]) {
  test(`global Search debounces every kind, streams groups and discards stale work at ${width}px`, async ({
    page,
  }) => {
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
          items: [
            { ...base, id: `${query}-${kind}`, name: `${query} ${kind}` },
          ],
          page: 1,
          total: 1,
          hasMore: false,
        };
      },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?section=live");
    const search = await openSearch(page);
    const requests = () =>
      api.events.filter((event) => event.startsWith("BROWSE:"));
    try {
      await expect(search).toHaveValue("");
      await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
      await search.fill(" N ");
      await page.waitForTimeout(450);
      expect(requests()).toEqual([]);
      await expect(
        page.getByRole("region", { name: "Movies results", exact: true }),
      ).toHaveCount(0);
      await search.fill("discarded");
      await page.waitForTimeout(100);
      await search.fill("  North  ");
      expect(requests()).toEqual([]);
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
      await expect(
        page.getByRole("button", { name: /^Open North/ }),
      ).toHaveCount(0);
      await expect.poll(() => requests().length).toBe(4);
      await expect
        .poll(() =>
          cancelled.some((value) => {
            const params = new URL(value).searchParams;
            return (
              params.get("search") === "North" &&
              params.get("kind") === "series"
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
}

test("global Search retries one failed group and loads another page independently", async ({
  page,
}) => {
  let movieAttempts = 0;
  const api = await mockApi(page, {
    browseResponse: async (params) => {
      const kind = params.get("kind");
      const pageNumber = Number(params.get("page"));
      if (kind === "movie" && ++movieAttempts === 1)
        return { error: "Movie provider is busy", status: 503 };
      if (kind === "movie" && pageNumber === 1)
        return { items: [], page: 1, total: 2, hasMore: true };
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
  await movies
    .getByRole("button", { name: "Retry movies", exact: true })
    .click();
  await expect(
    movies.getByText("No matches found.", { exact: true }),
  ).toBeVisible();
  await shows
    .getByRole("button", { name: "Load more shows", exact: true })
    .click();
  await expect(
    shows.getByRole("button", { name: "Open Night Shift 2", exact: true }),
  ).toBeVisible();
  await expect(
    shows.getByRole("button", { name: "Open Night Shift 1", exact: true }),
  ).toBeVisible();
  await expect(
    shows.getByRole("button", { name: "Load more shows", exact: true }),
  ).toHaveCount(0);
  await expect(
    movies.getByRole("button", { name: "Load more movies", exact: true }),
  ).toBeVisible();
  await movies
    .getByRole("button", { name: "Load more movies", exact: true })
    .click();
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
        name: item.kind === "series" ? "Play episode" : "Play",
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
  await page.getByRole("button", { name: "Play episode", exact: true }).click();
  await expect(page.locator(".primary-control")).toBeEnabled();
  await playableVideo(page);
  published = true;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await expect
    .poll(() => api.events.filter((event) => event === "DELETE").length)
    .toBe(1);
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeEnabled({ timeout: 8000 });
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

function settingValue(page: Page, label: string) {
  return page
    .getByRole("region", { name: "Settings", exact: true })
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd");
}

test("Settings displays effective environment configuration without editable controls or writes", async ({
  page,
}) => {
  const api = await mockApi(page, {
    preferences: {
      refreshIntervalSeconds: 43200,
      categories: [],
      configuration: {
        dashboardCategories: ["movie:71", "Drama, Classics"],
        blockedCategories: ["live:documentary", "series:drama-series"],
      },
    },
  });
  await page.goto("/?view=settings");
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await expect(settings.locator(".settings-category-rules dt")).toHaveText([
    "Dashboard",
    "Blocked",
  ]);
  await expect(settingValue(page, "Refresh interval")).toHaveText("12 hours");
  await expect(settingValue(page, "Dashboard")).toContainText("movie:71");
  await expect(settingValue(page, "Dashboard")).toContainText(
    "Drama, Classics",
  );
  await expect(settingValue(page, "Blocked")).toContainText("live:documentary");
  await expect(settingValue(page, "Blocked")).toContainText(
    "series:drama-series",
  );
  for (const role of ["combobox", "checkbox", "textbox", "searchbox"] as const)
    await expect(settings.getByRole(role)).toHaveCount(0);
  await expect(settings.getByRole("button")).toHaveCount(1);
  await expect(
    settings.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeEnabled();
  await expect(settings.getByRole("button", { name: /Save/ })).toHaveCount(0);
  await page.reload();
  await expect(settingValue(page, "Refresh interval")).toHaveText("12 hours");
  await expect(settingValue(page, "Dashboard")).toContainText(
    "Drama, Classics",
  );
  expect(api.mutations).toEqual([]);
});

test("Settings releases playback and refreshes metadata without changing environment configuration", async ({
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
  await expect(settingValue(page, "Refresh interval")).toHaveText("6 hours");
  await expect(settingValue(page, "Dashboard")).toHaveText("All");
  await expect(settingValue(page, "Blocked")).toHaveText("None");
  const configuration = api.effectivePreferences();
  const refresh = page.getByRole("button", {
    name: "Refresh now",
    exact: true,
  });
  await refresh.click();
  await expect
    .poll(() => api.events.filter((event) => event.startsWith("REFRESH:")))
    .toEqual(["REFRESH:all"]);
  await expect(refresh).toBeDisabled();
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

test("a configuration deployment updates read-only Settings without browser mutations", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/?view=settings");
  await expect(settingValue(page, "Refresh interval")).toHaveText("6 hours");
  const next = api.effectivePreferences();
  next.refreshIntervalSeconds = 86400;
  next.configuration = {
    dashboardCategories: ["movie:drama-movie"],
    blockedCategories: ["live:documentary", "series:drama-series"],
  };
  next.categories = [
    { kind: "live", id: "news", visibility: "show", dashboard: false },
    { kind: "live", id: "documentary", visibility: "block", dashboard: false },
    {
      kind: "series",
      id: "drama-series",
      visibility: "block",
      dashboard: false,
    },
  ];
  api.deployConfiguration(next);
  await expect(settingValue(page, "Refresh interval")).toHaveText("1 day", {
    timeout: 12000,
  });
  await expect(settingValue(page, "Dashboard")).toContainText(
    "movie:drama-movie",
  );
  await expect(settingValue(page, "Blocked")).toContainText("live:documentary");
  await expect(settingValue(page, "Blocked")).toContainText(
    "series:drama-series",
  );
  await page.reload();
  await expect(settingValue(page, "Refresh interval")).toHaveText("1 day");
  expect(api.mutations).toEqual([]);
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
    page.getByRole("alert").filter({ hasText: "Configuration unavailable." }),
  ).toBeVisible();
  configurationUnavailable = false;
  await page
    .getByRole("button", { name: "Retry configuration", exact: true })
    .click();
  await expect(settingValue(page, "Dashboard")).toHaveText("All");
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

test("read-only Settings remains usable on mobile and handles an unconfigured provider", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await mockApi(page);
  await page.goto("/?section=live");
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("view")).toBe("settings");
  await expect(settingValue(page, "Refresh interval")).toHaveText("6 hours");
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeEnabled({ timeout: 8000 });
  expect(api.mutations).toEqual([{ method: "POST", path: "/api/refresh" }]);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/environment-review/settings-mobile.png",
      fullPage: false,
    });
  await page.setViewportSize({ width: 320, height: 844 });
  const next = api.effectivePreferences();
  next.configuration.dashboardCategories = [
    "movie:Very long provider category name for classic movies with restored editions",
  ];
  api.deployConfiguration(next);
  await page.reload();
  await expect(settingValue(page, "Dashboard")).toContainText(
    "Very long provider category name",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  for (const role of ["combobox", "checkbox", "textbox", "searchbox"] as const)
    await expect(
      page
        .getByRole("region", { name: "Settings", exact: true })
        .getByRole(role),
    ).toHaveCount(0);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/environment-review/settings-mobile-320.png",
      fullPage: false,
    });
  await page.unrouteAll({ behavior: "wait" });
  await mockApi(page, { unconfigured: true });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Refresh now", exact: true }),
  ).toBeDisabled();
});

test("native HLS playback keeps the decoder and worker out of browser requests", async ({
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
  await expect.poll(() => page.locator("video").getAttribute("src")).toBeNull();
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

test("a fatal HLS manifest failure clears media and remains retryable", async ({
  page,
}) => {
  await mockApi(page, { nativeHls: false });
  await page.route("**/api/streams/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body: "invalid manifest",
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Playback stopped");
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
  expect(errors).toEqual([]);
});

test("season episodes load on demand and returning to a season uses the browser cache", async ({
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
    page.getByRole("button", { name: "Play episode", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: /Fresh Start/ })).toBeVisible();
  expect(requested).toEqual(["first", "2"]);
  await selector.click();
  await page.getByRole("option", { name: "Season 1" }).click();
  await expect(page.getByRole("button", { name: /First Light/ })).toBeVisible();
  expect(requested).toEqual(["first", "2"]);
  expect(api.events).not.toContain("POST");
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
    expect(
      await page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key) || '{"entries":[]}').entries
            .length,
        historyKey,
      ),
    ).toBe(title.kind === "live" ? 0 : 1);
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
  expect(
    await page.evaluate((key) => localStorage.getItem(key), historyKey),
  ).toBeNull();
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
  await mockApi(page, { capacity: true });
  await page.goto("/?section=live");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "All streaming slots are in use.",
  );
  await page.getByRole("button", { name: "Stop playback" }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
});

test("dashboard safely handles corrupt storage and unavailable titles", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.addInitScript(
    ({ key, movie, watchedAt }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          entries: [
            { title: movie, item: movie, watchedAt },
            { title: movie, item: movie, watchedAt: 1e20 },
            null,
            { title: { kind: "bad" }, item: movie, watchedAt },
          ],
        }),
      );
    },
    { key: historyKey, movie: { ...movie, id: "gone-movie" }, watchedAt: now },
  );
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
  await expect(
    page
      .getByRole("region", { name: "Recently played", exact: true })
      .getByRole("status")
      .filter({ hasText: "History isn’t saved." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(
    page.getByRole("region", { name: "Recently played" }),
  ).toHaveCount(0);
});

test("dashboard resumes the full source position and Play again starts at zero", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.addInitScript(
    ({ key, movie, watchedAt }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(
          key,
          JSON.stringify({
            version: 1,
            entries: [
              {
                title: movie,
                item: movie,
                watchedAt,
                position: 300,
                duration: 1800,
                completed: false,
              },
            ],
          }),
        );
    },
    { key: historyKey, movie, watchedAt: now },
  );
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
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).entries[0].position,
      historyKey,
    ),
  ).toBe(330);
  await page.locator("video").evaluate((video) => {
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 1500,
    });
    video.dispatchEvent(new Event("timeupdate"));
    video.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).entries[0].completed,
      historyKey,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Play again" }).click();
  await expect.poll(() => api.sessionStarts).toEqual([300, 0]);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(page).toHaveURL(/view=dashboard/);
  await expectHome(page);
});

test("dashboard Up next crosses a provider season boundary and plays the actual next episode", async ({
  page,
}) => {
  const api = await mockApi(page);
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
  await page.addInitScript(
    ({ key, series, episode, watchedAt }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          entries: [
            {
              title: series,
              item: episode,
              watchedAt,
              position: 1800,
              duration: 1800,
              completed: true,
            },
          ],
        }),
      );
    },
    { key: historyKey, series, episode: episodes[1], watchedAt: now },
  );
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

test("another tab can clear dashboard history without ongoing player progress restoring it", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toHaveAttribute("src", /index\.m3u8/);
  await playableVideo(page, 100);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Player", exact: true }),
  ).toBeVisible();
  const dashboardTab = await page.context().newPage();
  await mockApi(dashboardTab);
  await dashboardTab.goto("/?view=dashboard");
  await dashboardTab
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), historyKey))
    .toBeNull();
  await playableVideo(page, 200);
  await page.getByRole("button", { name: "Stop playback" }).click();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), historyKey),
  ).toBeNull();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Continue watching" }),
  ).toHaveCount(0);
  await dashboardTab.close();
});

test("dashboard discovery has real title actions and keeps personal sections absent without history", async ({
  page,
}) => {
  const api = await mockApi(page, {
    discoveryResponse: {
      configured: true,
      refreshing: false,
      trendingMovies: [
        {
          tmdbId: 17,
          item: movie,
          name: movie.name,
          overview: movie.description,
          poster: "/artwork-title.svg",
          backdrop: "/artwork-title.svg",
          year: 2026,
          rating: 7.8,
        },
      ],
      trendingSeries: [
        {
          tmdbId: 19,
          item: series,
          name: series.name,
          poster: "/artwork-title.svg",
          backdrop: "/artwork-title.svg",
        },
      ],
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
  await expect(
    page.getByText("The Quiet Coast", { exact: true }).first(),
  ).toBeVisible();
  expect(api.events).not.toContain("POST");
  await page
    .getByRole("button", { name: /Play The Quiet Coast/ })
    .first()
    .click();
  await expect.poll(() => api.sessionItemIds).toEqual(["movie-1"]);
  await expect(
    page.getByRole("region", { name: "Player", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop playback" }).click();
});

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
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).entries[0].position,
      historyKey,
    ),
  ).toBe(120);
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
    await page.getByRole("button", { name: "Settings", exact: true }).click();
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
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).entries[0].position,
      historyKey,
    ),
  ).toBe(42);
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
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).entries[0].position,
      historyKey,
    ),
  ).toBe(52);
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

test("environment category policy filters the whole Dashboard and blocks playback after deployment without deleting history", async ({
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
  await page.addInitScript(
    ({ key, entries }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ version: 1, entries }));
    },
    { key: historyKey, entries },
  );
  let releasePreferences!: () => void;
  const preferencesGate = new Promise<void>((resolve) => {
    releasePreferences = resolve;
  });
  const api = await mockApi(page, {
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
  await expect(recent).toContainText(allowed.name);
  await expect(
    continuing.getByRole("button", {
      name: `Resume ${allowed.name}`,
      exact: true,
    }),
  ).toBeVisible();
  for (const title of [personal, hidden, blocked]) {
    await expect(recent).not.toContainText(title.name);
    await expect(
      continuing.getByRole("button", {
        name: `Resume ${title.name}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.locator(".discovery-poster-card").filter({ hasText: title.name }),
    ).toHaveCount(0);
  }
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
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).entries.length,
      historyKey,
    ),
  ).toBe(4);
});

test("Dashboard applies raw environment rules to stale and mixed-case history without deleting records", async ({
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
  const excluded = [
    {
      ...movie,
      id: "movie-unknown",
      name: "Unknown Resume",
      categoryId: "removed",
      category: "Unlisted archive",
    },
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
    ...excluded,
  ].map((title, index) => ({
    title,
    item: title,
    watchedAt: Date.now() - index * 1000,
    position: 300,
    duration: 1800,
    completed: false,
  }));
  await page.addInitScript(
    ({ key, entries }) => {
      localStorage.setItem(key, JSON.stringify({ version: 1, entries }));
    },
    { key: historyKey, entries },
  );
  const api = await mockApi(page, {
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
  await expect(recent.locator(".discovery-recent-card")).toHaveCount(2);
  await expect(continuing.locator(".discovery-continue-card")).toHaveCount(2);
  for (const title of [allowed, legacy]) {
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
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).entries.length,
      historyKey,
    ),
  ).toBe(6);
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
        name: base.kind === "series" ? "Play episode" : "Play",
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
        name: base.kind === "series" ? "Play episode" : "Play",
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
  test(`icon navigation reaches Home, Search, VOD, Live TV and Settings at ${width}px`, async ({
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
    for (const name of ["Home", "Search", "VOD", "Live TV", "Settings"]) {
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
    await navigation
      .getByRole("button", { name: "Settings", exact: true })
      .click();
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
    const categories = Array.from({ length: 60 }, (_, index) => ({
      id: `genre-${index}`,
      name: `Genre ${String(index).padStart(2, "0")}`,
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
      page.getByRole("option", { name: "Genre 23", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Open Film 23", exact: true }),
    ).toBeVisible();
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
        name: title.kind === "series" ? "Play episode" : "Play",
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
  test(`play logo assembles once and respects ${reducedMotion} motion`, async ({
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
    await expect(brand.locator(".brand-resolved")).toHaveCSS("opacity", "1");
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
    await navigation
      .getByRole("button", { name: "Settings", exact: true })
      .click();
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
      const panel = page.getByRole("tabpanel", {
        name: "Shows",
        exact: true,
      });
      await expect(
        panel.getByRole("status", { name: "Loading titles", exact: true }),
      ).toBeVisible();
      await expect(tabs).toBeVisible();
      await expect(category).toBeVisible();
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
      await expect(shows).toHaveAttribute("aria-selected", "true");
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
