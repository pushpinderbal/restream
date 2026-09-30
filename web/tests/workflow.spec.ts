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

async function collapseTitle(page: Page) {
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  });
  const selectedTile = page
    .locator('.media-card[aria-expanded="true"]')
    .first();
  if (await selectedTile.count()) {
    if (!(await selectedTile.isVisible())) {
      const section = new URL(page.url()).searchParams.get("section");
      await page
        .getByRole("button", {
          name:
            section === "movie"
              ? "Movies"
              : section === "series"
                ? "Series"
                : "Live TV",
          exact: true,
        })
        .click();
    }
    await selectedTile.click();
    await expect(
      page.getByRole("region", { name: "Expanded title" }),
    ).toHaveCount(0);
  }
}

test.afterEach(async ({ page }) => {
  await collapseTitle(page);
});

async function mockApi(
  page: Page,
  options: {
    initialEmpty?: boolean;
    capacity?: boolean;
    producerEnded?: boolean;
    starting?: boolean;
    refreshing?: boolean;
    refreshDelayMs?: number;
    refreshFailure?: boolean;
    unconfigured?: boolean;
    cooldown?: boolean;
    createDelayMs?: number;
    releaseDelayMs?: number;
    episodesFailureOnce?: boolean;
    episodeItems?: () => Record<string, unknown>[];
    catalogItems?: Record<string, unknown>[];
    categories?: { id: string; name: string; kind: string }[];
    guidePrograms?: Array<(typeof programs)[number] & { description?: string }>;
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
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/status") {
      return json({
        configured: !options.unconfigured,
        refreshing:
          options.refreshing || refreshRunning.catalog || refreshRunning.epg,
        catalogUpdatedAt: catalogReady ? refreshUpdated.catalog : undefined,
        libraryUpdatedAt: catalogReady ? refreshUpdated.catalog : undefined,
        epgUpdatedAt: refreshUpdated.epg,
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
              intervalSeconds: target === "catalog" ? 86400 : 21600,
            },
          ]),
        ),
      });
    }
    if (path === "/api/catalog")
      return json({
        items: catalogReady
          ? (options.catalogItems ?? [live]).filter(
              (item) => item.kind === "live",
            )
          : [],
      });
    if (path === "/api/categories")
      return json({
        categories: options.categories ?? [
          { id: "news", name: "News", kind: "live" },
          { id: "drama-movie", name: "Drama", kind: "movie" },
          { id: "drama-series", name: "Drama", kind: "series" },
          { id: "documentary", name: "Documentary", kind: "live" },
        ],
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
      const items = (options.catalogItems ?? [movie, series]).filter(
        (item) =>
          item.kind === kind &&
          (category === "*" ||
            (options.categories && item.categoryId === category) ||
            (kind === "movie"
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
      return json({ programs: options.guidePrograms ?? programs });
    if (path.startsWith("/api/items/")) {
      const id = decodeURIComponent(path.slice("/api/items/".length));
      const item = (options.catalogItems ?? [live, movie, series]).find(
        (value) => value.id === id,
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
    if (path === "/api/series/series-1/episodes") {
      episodeAttempts++;
      events.push("EPISODES");
      if (options.episodesFailureOnce && episodeAttempts <= 2)
        return json({ error: "Episodes are temporarily unavailable" }, 503);
      return json({ items: options.episodeItems?.() ?? episodes });
    }
    if (path === "/api/sessions" && method === "POST") {
      events.push("POST");
      sessionItemIds.push(route.request().postDataJSON().itemId);
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
      polls = 0;
      if (options.createDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.createDelayMs),
        );
      return json(
        {
          id: `session-${nextId}`,
          url: `/api/streams/session-${nextId}/0/index.m3u8`,
          state: options.starting ? "starting" : "ready",
          duration: 1800,
          offset: 0,
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
        state: options.starting
          ? "starting"
          : options.producerEnded && polls > 1
            ? "ended"
            : "ready",
        duration: 1800,
        offset: 0,
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
  await page.goto("/");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page
      .getByRole("button", { name: "Pause", exact: true })
      .or(page.locator(".primary-control")),
  ).toBeEnabled();
  await playableVideo(page);
  const liveButton = page.getByRole("button", { name: "Go to live" });
  await expect(liveButton).toHaveAttribute("data-behind", "true");
  await expect(liveButton).toHaveCSS("color", "rgb(146, 152, 165)");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await liveButton.click();
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
  await liveButton.click();
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
  test(`playback survives library tabs and title browsing at ${viewport.width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: "Open North News" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    await page.locator("video").evaluate((video) => {
      (video as HTMLVideoElement).muted = true;
    });
    const originalVideo = await page.locator("video").elementHandle();
    const navigation = page.getByRole("navigation", {
      name: viewport.width <= 820 ? "Primary navigation" : "Library",
    });
    const checkPlayback = async () => {
      await expect(page.locator("video")).toHaveCount(1);
      expect(
        await originalVideo!.evaluate(
          (element) => element === document.querySelector("video"),
        ),
      ).toBe(true);
      expect(
        await originalVideo!.evaluate((element) => {
          const video = element as HTMLVideoElement;
          return {
            paused: video.paused,
            muted: video.muted,
            time: video.currentTime,
          };
        }),
      ).toEqual({ paused: false, muted: true, time: 30 });
      await expect(page.locator(".dock-title")).toHaveText(live.name);
      expect(api.sessionItemIds).toEqual([live.id]);
      expect(api.events).not.toContain("DELETE");
    };

    await navigation
      .getByRole("button", { name: "Series", exact: true })
      .click();
    await page.getByRole("button", { name: "Open Night Shift" }).click();
    await expect(
      page.getByRole("button", { name: /After Hours/ }),
    ).toBeVisible();
    await checkPlayback();
    await navigation
      .getByRole("button", { name: "Movies", exact: true })
      .click();
    await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
    await checkPlayback();
    await navigation
      .getByRole("button", { name: "Live TV", exact: true })
      .click();
    await checkPlayback();

    const search = page.locator(".header-search").getByRole("searchbox");
    await search.click();
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("outline-style", "none");
    await search.fill("North");
    await checkPlayback();
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.locator(".header-status")).toHaveCount(0);

    await navigation
      .getByRole("button", { name: "Movies", exact: true })
      .click();
    await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
    await page
      .getByRole("region", { name: "Expanded title" })
      .getByRole("button", { name: "Play", exact: true })
      .click();
    await expect.poll(() => api.sessionItemIds).toEqual([live.id, movie.id]);
    await expect
      .poll(() =>
        api.events.filter((event) => event === "POST" || event === "DELETE"),
      )
      .toEqual(["POST", "DELETE", "POST"]);
    expect(
      await originalVideo!.evaluate((element) => element.isConnected),
    ).toBe(false);
    await expect(page.locator(".dock-title")).toHaveText(movie.name);
    await page.getByRole("button", { name: "Stop playback" }).click();
    await expect(page.getByRole("region", { name: "Player" })).toHaveCount(0);
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(2);
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`searched channel breadcrumbs navigate its category without interrupting playback at ${viewport.width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize(viewport);
    await page.goto("/?search=North");
    await page.getByRole("button", { name: "Open North News" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    const original = await page.locator("video").elementHandle();
    const breadcrumbs = page.getByRole("navigation", {
      name: "Playback breadcrumbs",
    });
    await breadcrumbs.getByRole("link", { name: "News", exact: true }).click();
    await expect(page).toHaveURL(/category=news/);
    await expect(page.locator(".header-search input")).toHaveValue("");
    await expect(
      page.getByRole("region", { name: "Expanded title" }),
    ).toHaveCount(0);
    await page
      .locator(".dock-title")
      .getByRole("link", { name: live.name })
      .click();
    await expect(
      page.getByRole("region", { name: "Expanded title" }),
    ).toBeVisible();
    await breadcrumbs
      .getByRole("link", { name: "Live TV", exact: true })
      .click();
    expect(new URL(page.url()).searchParams.has("category")).toBe(false);
    expect(
      await original!.evaluate(
        (element) =>
          element === document.querySelector("video") &&
          !(element as HTMLVideoElement).paused,
      ),
    ).toBe(true);
    expect(api.sessionItemIds).toEqual([live.id]);
    expect(api.events).not.toContain("DELETE");
  });

  test(`series breadcrumbs restore the playing season across library tabs at ${viewport.width}px`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.setViewportSize(viewport);
    await page.goto("/?section=series&search=Night");
    await page.getByRole("button", { name: "Open Night Shift" }).click();
    await page.getByRole("combobox", { name: "Season" }).click();
    await page.getByRole("option", { name: "Season 2" }).click();
    await page
      .getByRole("button", { name: "Play episode", exact: true })
      .click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    const original = await page.locator("video").elementHandle();
    const navigation = page.getByRole("navigation", {
      name: viewport.width <= 820 ? "Primary navigation" : "Library",
    });
    await navigation
      .getByRole("button", { name: "Movies", exact: true })
      .click();
    const breadcrumbs = page.getByRole("navigation", {
      name: "Playback breadcrumbs",
    });
    await breadcrumbs
      .getByRole("link", { name: "Season 2", exact: true })
      .click();
    await expect(page).toHaveURL(/section=series/);
    await expect(page).toHaveURL(/category=drama-series/);
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
    await page.getByRole("combobox", { name: "Season" }).click();
    await page.getByRole("option", { name: "Season 1" }).click();
    await breadcrumbs
      .getByRole("link", { name: "Season 2", exact: true })
      .click();
    await expect(page.getByRole("combobox", { name: "Season" })).toHaveText(
      "Season 2",
    );
    await breadcrumbs.getByRole("link", { name: "Drama", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Expanded title" }),
    ).toHaveCount(0);
    await expect(page.locator(".header-search input")).toHaveValue("");
    await breadcrumbs
      .getByRole("link", { name: series.name, exact: true })
      .click();
    await expect(page.getByRole("combobox", { name: "Season" })).toHaveText(
      "Season 2",
    );
    expect(
      await original!.evaluate(
        (element) =>
          element === document.querySelector("video") &&
          !(element as HTMLVideoElement).paused,
      ),
    ).toBe(true);
    expect(api.sessionItemIds).toEqual(["episode-3"]);
    expect(api.events).not.toContain("DELETE");
    // The breadcrumb destination also opens correctly as a direct link.
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Season" })).toHaveText(
      "Season 2",
    );
    await expect(
      page.getByText("Selected · S2 E1 · Fresh Start"),
    ).toBeVisible();
  });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`closing the player stops playback promptly and respects ${reducedMotion} motion`, async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.emulateMedia({ reducedMotion });
    await page.goto("/?section=movie");
    await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator(".primary-control")).toBeEnabled();
    await playableVideo(page);
    await expect(page.locator(".watch-section")).toBeVisible();
    const framesPromise = page.evaluate(async () => {
      const player = document.querySelector<HTMLElement>(".watch-section")!;
      const video = player.querySelector("video")!;
      await new Promise<void>((resolve) => {
        player
          .querySelector<HTMLButtonElement>(".dock-stop")!
          .addEventListener("click", () => resolve(), { once: true });
      });
      const initialHeight = player.getBoundingClientRect().height;
      const frames: {
        height: number;
        opacity: number;
        paused: boolean;
        closing: boolean;
      }[] = [];
      const deadline = performance.now() + 2000;
      while (player.isConnected && performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        frames.push({
          height: player.getBoundingClientRect().height / initialHeight,
          opacity: Number(getComputedStyle(player).opacity),
          paused: video.paused,
          closing: player.dataset.closing === "true",
        });
      }
      return frames;
    });
    await page.getByRole("button", { name: "Stop playback" }).click();
    const frames = await framesPromise;
    const closing = frames.filter((frame) => frame.closing);
    expect(closing.every((frame) => frame.paused)).toBe(true);
    if (reducedMotion === "no-preference") {
      expect(
        closing.some(
          (frame) =>
            frame.height > 0 &&
            frame.height < 0.95 &&
            frame.opacity > 0 &&
            frame.opacity < 1,
        ),
        JSON.stringify(frames),
      ).toBe(true);
    }
    await expect(page.locator(".watch-section")).toHaveCount(0);
    await expect
      .poll(() => api.events.filter((event) => event === "DELETE").length)
      .toBe(1);
    await expect
      .poll(() =>
        page
          .locator(".player-dock")
          .evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBe(0);
  });
}

for (const item of [live, movie, series]) {
  test(`searched ${item.kind} uses the portal category ID in playback breadcrumbs`, async ({
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
      `/?section=${item.kind}&search=${encodeURIComponent(item.name)}`,
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
    const video = await page.locator("video").elementHandle();
    await page
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", {
        name: item.kind === "movie" ? "Series" : "Movies",
        exact: true,
      })
      .click();
    const categoryLink = page
      .getByRole("navigation", { name: "Playback breadcrumbs" })
      .getByRole("link", { name: categoryName, exact: true });
    await expect(categoryLink).toHaveAttribute(
      "href",
      new RegExp(`category=${categoryId}`),
    );
    await categoryLink.click();
    await expect(page).toHaveURL(new RegExp(`category=${categoryId}`));
    await expect(
      page.getByRole("button", { name: `Open ${item.name}` }),
    ).toBeVisible();
    expect(
      await video!.evaluate(
        (element) =>
          element === document.querySelector("video") &&
          !(element as HTMLVideoElement).paused,
      ),
    ).toBe(true);
    expect(api.sessionItemIds).toHaveLength(1);
    expect(api.events).not.toContain("DELETE");
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
      await page.screenshot({
        path: `/tmp/restream-episodes-${viewport.width}.png`,
        fullPage: true,
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
    await expect(page.locator(".dock-caption")).not.toContainText(
      /Now playing|Connecting|Paused|Finished/,
    );
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

test("player stays pinned while browsing and resizing without replacing its video", async ({
  page,
}) => {
  const api = await mockApi(page, {
    catalogItems: Array.from({ length: 60 }, (_, i) => ({
      ...movie,
      id: i ? `pinned-${i}` : movie.id,
      name: i ? `Pinned film ${i}` : movie.name,
    })),
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?section=movie");
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const video = await page.locator("video").elementHandle();
  const player = page.getByRole("region", { name: "Player" });
  await expect(player).toBeVisible();
  await expect(player.getByRole("heading", { name: movie.name })).toBeVisible();
  await expect(
    player.getByRole("button", { name: "Stop playback" }),
  ).toHaveText("");
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    const before = await player.boundingBox();
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
    );
    const after = await player.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.y).toBeGreaterThanOrEqual(72);
    expect(after!.y + after!.height).toBeLessThan(viewport.height - 66);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    expect(await video!.evaluate((element) => element.isConnected)).toBe(true);
    await page.screenshot({
      path: `/tmp/restream-player-${viewport.width}.png`,
    });
  }
  expect(api.sessionItemIds).toEqual([movie.id]);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect(player).toHaveCount(0);
  await expect.poll(() => api.events.includes("DELETE")).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--player-dock-height")
          .trim(),
      ),
    )
    .toBe("0px");
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
  await page.goto("/");
  await expect(page.getByText("No channels yet")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh library" }),
  ).toHaveCount(0);
  api.publishSnapshot();
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(
    page.getByRole("region", { name: "On this channel" }),
  ).toContainText("Morning Report");
  await collapseTitle(page);
  await page.getByRole("searchbox").fill("not here");
  await expect(page.getByText("No matches found")).toBeVisible();
  expect(api.events).not.toContain("REFRESH");
});

test("capacity error is announced", async ({ page }) => {
  const api = await mockApi(page, { capacity: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open North News" }).click();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "No room available" }),
  ).toBeVisible();
  await collapseTitle(page);
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible();
});

test("category filters open independently of section tabs", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  const movies = page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true });
  await movies.click();
  await expect(movies).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Open category filters" }).click();
  await expect(
    page.getByRole("button", { name: "Drama", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close category filters" }).click();
  await expect(
    page.getByRole("button", { name: "Drama", exact: true }),
  ).toHaveCount(0);
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
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
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
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop playback" })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", { name: "Forward 10 seconds" }),
  ).toBeVisible();
});

test("season selection chooses its episode before Play and does not switch an active stream", async ({
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

test("opening a title uses history and only Play allocates a stream", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(page).toHaveURL(/item=live-1/);
  await expect(
    page.getByRole("heading", { name: "North News", level: 1 }),
  ).toBeVisible();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.events.includes("POST")).toBe(true);
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  expect(api.events).not.toContain("DELETE");
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible();
  expect(api.events).not.toContain("DELETE");
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expect.poll(() => api.events.includes("DELETE")).toBe(true);
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
  await page.goto("/");
  await page.getByRole("searchbox").fill("colors 4k");
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
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Series", exact: true })
    .click();
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: /First Light/ }).click();
  await expect(
    page
      .getByRole("button", { name: "Pause", exact: true })
      .or(page.getByRole("button", { name: "Play", exact: true })),
  ).toBeVisible();
  await page.getByRole("button", { name: /After Hours/ }).click();
  await expect(page.getByText("After Hours").last()).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "No room available" }),
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
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Series", exact: true })
    .click();
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await page.getByRole("button", { name: /First Light/ }).click();
  await expect
    .poll(
      () =>
        api.events.filter((event) => ["POST", "DELETE"].includes(event)).length,
    )
    .toBe(1);
  await page.getByRole("button", { name: /After Hours/ }).click();
  await expect
    .poll(() =>
      api.events
        .filter((event) => ["POST", "DELETE"].includes(event))
        .slice(0, 3),
    )
    .toEqual(["POST", "DELETE", "POST"]);
  await expect(
    page.getByRole("alert").filter({ hasText: "No room available" }),
  ).toHaveCount(0);
});

test("producer ended state keeps player available", async ({ page }) => {
  await mockApi(page, { producerEnded: true });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
  await page.getByRole("button", { name: "Open The Quiet Coast" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Playback finished")).toHaveCount(0);
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
  await page.goto("/");
  expect(
    api.events.filter((event) => event.startsWith("BROWSE:")),
  ).toHaveLength(0);
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
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

test("search replaces a stale request, including type then clear", async ({
  page,
}) => {
  const api = await mockApi(page, {
    browseResponse: async (params) => {
      const query = params.get("search") || "";
      if (query === "slow")
        await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        items:
          query === "slow"
            ? [{ ...movie, id: "old", name: "Old Result" }]
            : [movie],
        page: 1,
        total: 1,
        hasMore: false,
      };
    },
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  const search = page.getByRole("searchbox");
  await search.fill("slow");
  await expect
    .poll(
      () => api.events.filter((event) => event.includes("search=slow")).length,
    )
    .toBe(1);
  await search.fill("");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(
    page.getByRole("button", { name: "Open Old Result" }),
  ).toHaveCount(0);
  await search.fill("quick");
  await search.fill("");
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/section=movie/);
});

test("section and category survive navigation and browser back", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/?section=series&category=drama-series&search=Night");
  await expect(
    page.getByRole("button", { name: "Open Night Shift" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Night Shift" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Open Night Shift" }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue("Night");
});

test("mobile navigation and category filters remain accessible", async ({
  page,
}) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const movies = page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: "Movies" });
  await movies.click();
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open category filters" }).click();
  await page.getByRole("button", { name: "Drama", exact: true }).click();
  await expect(page).toHaveURL(/category=drama/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("titles expand beneath their row and keep the library and session mounted on resize", async ({
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
  await expect(
    page
      .locator(".site-header")
      .getByRole("searchbox", { name: "Search titles" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Collapse details" }),
  ).toHaveCount(0);
  const panel = page.getByRole("region", { name: "Expanded title" });
  await expect(panel).toBeVisible();
  const tileBounds = await tile.boundingBox();
  const panelBounds = await panel.boundingBox();
  expect(panelBounds!.y).toBeGreaterThan(
    tileBounds!.y + tileBounds!.height - 1,
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([movie.id]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await page.waitForTimeout(400);
  expect(api.sessionItemIds).toEqual([movie.id]);
  expect(api.events).not.toContain("DELETE");
  await collapseTitle(page);
  await expect(panel).toHaveCount(0);
  await expect(tile).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => api.events.includes("DELETE")).toBe(true);
});

test("switching inline titles waits for a late stream session to be released", async ({
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
  await page.getByRole("button", { name: "Open Other Film" }).click();
  await page
    .getByRole("region", { name: "Expanded title" })
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect
    .poll(() => api.sessionItemIds)
    .toEqual([movie.id, "movie-other"]);
  expect(
    api.events
      .filter((event) => event === "POST" || event === "DELETE")
      .slice(0, 3),
  ).toEqual(["POST", "DELETE", "POST"]);
  await expect(
    page.getByRole("alert").filter({ hasText: "No room available" }),
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
    await page
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", { name: "Series", exact: true })
      .click();
    await expect(
      page
        .getByRole("button", { name: "Open Night Shift" })
        .locator(".artwork-reveal"),
    ).toHaveClass(/is-revealed/);
    await page
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", { name: "Movies", exact: true })
      .click();
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

test("channel details contain the full guide with one animated page background", async ({
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
  await page.goto("/");
  await expect(page.locator(".card-live-icon")).toHaveCount(1);
  await expect(page.locator(".header-status")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Programme guide", exact: true }),
  ).toHaveCount(0);
  const backdrop = page.locator(".page-backdrop");
  const field = backdrop.locator("canvas.galaxy-field");
  await expect(field).toBeVisible();
  const readMotion = () =>
    field.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let digest = 0;
      for (let i = 0; i < pixels.length; i += 8)
        digest = (digest * 31 + pixels[i]) | 0;
      return { width: canvas.width, height: canvas.height, digest };
    });
  const movement = await readMotion();
  await page.waitForTimeout(1500);
  expect(await readMotion()).not.toEqual(movement);
  await page.getByRole("button", { name: "Open North News" }).click();
  const guide = page.getByRole("region", { name: "On this channel" });
  await expect(guide).toContainText("Tomorrow Briefing");
  await expect(guide).toContainText("Stories from across the city.");
  await page.screenshot({
    path: "/tmp/restream-guide-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guide).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "/tmp/restream-guide-mobile.png",
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(100);
  const still = await readMotion();
  await page.waitForTimeout(250);
  expect(await readMotion()).toEqual(still);
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
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Open North News" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/restream-desktop.png", fullPage: true });
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/restream-movies.png", fullPage: true });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "/tmp/restream-categories.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Live TV", exact: true })
    .click();
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(
    page.getByRole("heading", { name: "North News", level: 1 }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/restream-detail.png", fullPage: true });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await page.screenshot({ path: "/tmp/restream-player.png", fullPage: true });
  await collapseTitle(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/restream-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(
    page.getByRole("region", { name: "On this channel" }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "/tmp/restream-mobile-detail.png",
    fullPage: true,
  });
  await collapseTitle(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByRole("button", { name: "Open category filters" }).click();
  await page.getByRole("button", { name: "Documentary", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open Cinema One" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: "/tmp/restream-mobile-320.png",
    fullPage: true,
  });
});

test("channel schedule scrolls without a scrollbar on desktop, mobile and during playback", async ({
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
  await page.goto("/");
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
  await expect(guide).toBeVisible();
  await expect(page.locator(".controls-title, .player-meta")).toHaveCount(0);
  await expect(
    page
      .locator(".site-header")
      .getByRole("searchbox", { name: "Search channels" }),
  ).toBeVisible();
  await collapseTitle(page);
});

for (const item of [live, movie, series]) {
  test(`${item.kind} tiles keep descriptions in details and a filtered playing tile stays available to close`, async ({
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
    await page.goto(item.kind === "live" ? "/" : `/?section=${item.kind}`);
    const tile = page.getByRole("button", { name: `Open ${item.name}` });
    await expect(tile.locator("h3")).toHaveText(item.name);
    await expect(tile.locator(".card-description")).toHaveCount(0);
    if (item.kind === "live")
      await expect(tile.locator(".card-programme")).toHaveText(
        "Morning Report",
      );
    else await expect(tile.locator(".card-content")).toHaveText(item.name);
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
    const search = page.locator(".header-search").getByRole("searchbox");
    await search.fill("nothing here");
    await expect(page.getByText("No matches found")).toBeVisible();
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute("aria-expanded", "true");
    await search.fill("Search result");
    await expect(
      page.getByRole("button", { name: "Open Search result" }),
    ).toBeVisible();
    await expect(tile).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("search"))
      .toBe("Search result");
    expect(new URL(page.url()).searchParams.get("item")).toBe(item.id);
    expect(
      await originalVideo!.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect(api.sessionItemIds).toHaveLength(1);
    expect(api.events).not.toContain("DELETE");
    await tile.click();
    await expect(
      page.getByRole("region", { name: "Expanded title" }),
    ).toHaveCount(0);
    await expect.poll(() => api.events.includes("DELETE")).toBe(true);
    await expect(tile).toHaveCount(0);
    await expect(search).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Open Search result" }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("item")).toBeNull();
    expect(new URL(page.url()).searchParams.get("search")).toBe(
      "Search result",
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
  await page.goto("/");
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

test("channel clicks open details before playback and tune immediately during playback, including search", async ({
  page,
}) => {
  const other = { ...live, id: "live-2", name: "World Report" };
  const api = await mockApi(page, {
    catalogItems: [live, other],
    releaseDelayMs: 200,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Open World Report" }).click();
  await expect(
    page.getByRole("heading", { name: other.name, level: 1 }),
  ).toBeVisible();
  expect(api.sessionItemIds).toEqual([]);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([other.id]);
  const search = page.locator(".header-search").getByRole("searchbox");
  await search.fill("North");
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([other.id, live.id]);
  await expect(
    page.getByLabel(`${live.name} video`, { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".title-page.watching")).toHaveCount(1);
  expect(
    api.events
      .filter((event) => event === "POST" || event === "DELETE")
      .slice(0, 3),
  ).toEqual(["POST", "DELETE", "POST"]);
  await expect(
    page.getByRole("alert").filter({ hasText: "No room available" }),
  ).toHaveCount(0);
  await collapseTitle(page);
  await search.fill("");
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
  const api = await mockApi(page, {
    catalogItems: [live, middle, last],
    createDelayMs: 1000,
    releaseDelayMs: 150,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([live.id]);
  await page.getByRole("button", { name: "Open World Report" }).click();
  await expect(
    page.getByLabel(`${middle.name} video`, { exact: true }),
  ).toBeVisible();
  const tuned = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/sessions") &&
      response.request().postDataJSON().itemId === last.id,
  );
  await page.getByRole("button", { name: "Open Metro Sports" }).click();
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
    page.getByRole("alert").filter({ hasText: "No room available" }),
  ).toHaveCount(0);
});

test("library refresh discovers new series and episodes while preserving playback and season selection", async ({
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
  const original = await page.locator("video").elementHandle();
  const episodeLoads = api.events.filter(
    (event) => event === "EPISODES",
  ).length;
  const browseLoads = api.events.filter((event) =>
    event.startsWith("BROWSE:"),
  ).length;
  published = true;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Refresh library" }).click();
  await expect
    .poll(() => api.events.filter((event) => event === "EPISODES").length)
    .toBeGreaterThan(episodeLoads);
  await expect
    .poll(
      () => api.events.filter((event) => event.startsWith("BROWSE:")).length,
    )
    .toBeGreaterThan(browseLoads);
  await expect(
    page.getByRole("button", { name: "Refresh library" }),
  ).toBeEnabled();
  const refreshedEpisodeLoads = api.events.filter(
    (event) => event === "EPISODES",
  ).length;
  const refreshedBrowseLoads = api.events.filter((event) =>
    event.startsWith("BROWSE:"),
  ).length;
  await page.getByRole("button", { name: "Refresh guide" }).click();
  await expect(page.getByRole("button", { name: "Refresh guide" })).toBeEnabled(
    { timeout: 8000 },
  );
  expect(api.events.filter((event) => event === "EPISODES")).toHaveLength(
    refreshedEpisodeLoads,
  );
  expect(
    api.events.filter((event) => event.startsWith("BROWSE:")),
  ).toHaveLength(refreshedBrowseLoads);
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Open Northern Lights" }),
  ).toBeVisible();
  await expect(
    page.locator(".episode-row").filter({ hasText: "New Arrival" }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Season" })).toHaveText(
    "Season 2",
  );
  await expect(page.locator(".episode-row.selected")).toContainText(
    "Fresh Start",
  );
  expect(
    await original!.evaluate(
      (element) =>
        element === document.querySelector("video") &&
        !(element as HTMLVideoElement).paused,
    ),
  ).toBe(true);
  expect(api.sessionItemIds).toEqual([episodes[2].id]);
  expect(api.events).not.toContain("DELETE");
});

test("settings shows sync details and refreshes library and guide without interrupting playback", async ({
  page,
}) => {
  const api = await mockApi(page, { refreshDelayMs: 3000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.sessionItemIds).toEqual([live.id]);
  const video = page.locator("video");
  await expect(page.locator(".primary-control")).toBeEnabled();
  await playableVideo(page);
  await video.evaluate((element) =>
    element.setAttribute("data-settings-marker", "same-player"),
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(
    page.getByText("America/Toronto", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Automatic", { exact: true })).toBeVisible();
  await expect(page.getByText("1 / 1", { exact: true })).toHaveCount(2);
  const library = page.getByRole("region", { name: "Library metadata" });
  const guide = page.getByRole("region", {
    name: "Programme guide",
    exact: true,
  });
  await expect(library).toContainText("Every 24 hours");
  await expect(guide).toContainText("Every 6 hours");
  await library.getByRole("button", { name: "Refresh library" }).click();
  await expect(
    library.getByRole("button", { name: "Refresh library" }),
  ).toBeDisabled();
  await expect(
    guide.getByRole("button", { name: "Refresh guide" }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "Check status" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Refresh all" })).toHaveCount(
    0,
  );
  await expect(
    library.locator('.settings-sync-state [role="status"]'),
  ).toHaveText("Syncing");
  await expect(library.locator(".settings-sync-refresh svg")).toHaveClass(
    /animate-spin/,
  );
  await expect(page.locator(".settings-page svg.animate-spin")).toHaveCount(1);
  expect(
    await library
      .locator('.settings-sync-state [role="status"]')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  await expect(
    library.getByRole("button", { name: "Refresh library" }),
  ).toBeEnabled({ timeout: 8000 });
  await guide.getByRole("button", { name: "Refresh guide" }).click();
  await expect(
    guide.getByRole("button", { name: "Refresh guide" }),
  ).toBeDisabled();
  await expect(
    guide.locator('.settings-sync-state [role="status"]'),
  ).toHaveText("Syncing");
  await expect(
    guide.getByRole("button", { name: "Refresh guide" }),
  ).toBeEnabled({ timeout: 8000 });
  await expect(
    guide.locator('.settings-sync-state [role="status"]'),
  ).toHaveText("Up to date");
  await expect(page.locator(".settings-page svg.animate-spin")).toHaveCount(0);
  expect(api.events.filter((event) => event.startsWith("REFRESH:"))).toEqual([
    "REFRESH:catalog",
    "REFRESH:epg",
  ]);
  expect(api.events).not.toContain("DELETE");
  await expect(video).toHaveAttribute("data-settings-marker", "same-player");
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "/tmp/restream-settings-desktop.png",
      fullPage: true,
    });
  await page.goBack();
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("data-settings-marker", "same-player");
  expect(api.sessionItemIds).toEqual([live.id]);
});

test("settings announces refresh failures and provider cooldowns", async ({
  page,
}) => {
  await mockApi(page, { refreshFailure: true });
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Refresh guide" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Refresh is temporarily unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Refresh guide" }),
  ).toBeEnabled();
  await page.route("**/api/status", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Server unavailable" }),
    }),
  );
  await expect(page.getByRole("button", { name: "Check status" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Couldn’t check the server" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh library" }),
  ).toBeDisabled();
  await page.unrouteAll({ behavior: "wait" });
  await mockApi(page, { cooldown: true });
  await page.reload();
  await expect(page.getByText(/The provider requested a pause/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh library" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Refresh guide" }),
  ).toBeDisabled();
});

test("mobile settings is reachable, fits narrow screens and handles an unconfigured provider", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await mockApi(page);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("view")).toBe("settings");
  await page.getByRole("button", { name: "Refresh guide" }).click();
  await expect(page.getByRole("button", { name: "Refresh guide" })).toBeEnabled(
    { timeout: 8000 },
  );
  expect(api.events).toContain("REFRESH:epg");
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "/tmp/restream-settings-mobile.png",
      fullPage: true,
    });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.unrouteAll({ behavior: "wait" });
  await mockApi(page, { unconfigured: true });
  await page.reload();
  await expect(
    page.getByText("Provider setup required", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh library" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Refresh guide" }),
  ).toBeDisabled();
});
