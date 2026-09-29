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

test.afterEach(async ({ page }) => {
  const close = page.getByRole("button", { name: "Close player" });
  if (await close.isVisible().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(100);
  }
});

async function mockApi(
  page: Page,
  options: {
    initialEmpty?: boolean;
    capacity?: boolean;
    producerEnded?: boolean;
    starting?: boolean;
    refreshing?: boolean;
    createDelayMs?: number;
    episodesFailureOnce?: boolean;
    catalogItems?: Record<string, unknown>[];
    guidePrograms?: typeof programs;
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
        configured: true,
        refreshing: options.refreshing ?? false,
        catalogUpdatedAt: catalogReady ? "2026-09-28T12:00:00Z" : undefined,
        activeStreams: active ? 1 : 0,
        maxStreams: 1,
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
        categories: [
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
      const item = (options.catalogItems ?? [live, movie, series]).find((value) => value.id === id);
      return item ? json({ item }) : json({ error: "Title unavailable" }, 404);
    }
    if (path === "/api/refresh" && method === "POST") {
      events.push("REFRESH");
      return json({ error: "Refresh must be scheduled by the server" }, 405);
    }
    if (path === "/api/series/series-1/episodes") {
      episodeAttempts++;
      events.push("EPISODES");
      if (options.episodesFailureOnce && episodeAttempts <= 2)
        return json({ error: "Episodes are temporarily unavailable" }, 503);
      return json({ items: episodes });
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
  await expect(page.getByText("Morning Report")).toBeVisible();
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
  await page.getByRole("button", { name: "Back to library" }).click();
  await expect(page.getByRole("button", { name: "Open North News" })).toBeVisible();
});

test("section row opens and closes the adjacent categories without an extra arrow", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const movies = page.getByRole("navigation", { name: "Library" }).getByRole("button", { name: "Movies", exact: true });
  await movies.click();
  await expect(movies).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("complementary", { name: "Categories" }).getByRole("button", { name: "Drama" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open The Quiet Coast" })).toBeVisible();
  await movies.click();
  await expect(movies).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Show Movies categories" })).toHaveCount(0);
});

test("empty mixed-kind pages advance in bounded groups and preserve the cursor", async ({ page }) => {
  const api = await mockApi(page, { browseResponse: async (params) => {
    const number = Number(params.get("page"));
    return { items: number < 6 ? [] : [movie], page: number, total: 100, hasMore: number < 6 };
  } });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Library" }).getByRole("button", { name: "Movies", exact: true }).click();
  await expect(page.getByText("No movies in the pages checked yet")).toBeVisible();
  expect(api.events.filter((event) => event.startsWith("BROWSE:"))).toHaveLength(5);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: "Open The Quiet Coast" })).toBeVisible();
  expect(api.events.filter((event) => event.startsWith("BROWSE:"))).toHaveLength(6);
});

test("episode list can retry without starting a stream", async ({ page }) => {
  const api = await mockApi(page, { episodesFailureOnce: true });
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Episodes are temporarily unavailable" })).toBeVisible();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: "Retry episodes" }).click();
  await expect(page.getByRole("button", { name: /First Light/ })).toBeVisible();
  expect(api.events.filter((event) => event === "EPISODES").length).toBeGreaterThanOrEqual(2);
  expect(api.events).not.toContain("POST");
});

test("season selection chooses its episode before Play and does not switch an active stream", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/?section=series");
  await page.getByRole("button", { name: "Open Night Shift" }).click();
  const season = page.getByRole("combobox", { name: "Season" });
  await expect(season).toHaveValue("1");
  await season.selectOption("2");
  await expect(page.getByText("Selected · S2 E1 · Fresh Start")).toBeVisible();
  expect(api.sessionItemIds).toHaveLength(0);
  await page.getByRole("button", { name: "Play episode" }).click();
  await expect.poll(() => api.sessionItemIds).toEqual(["episode-3"]);
  await season.selectOption("1");
  await expect(page.getByRole("button", { name: /After Hours/ })).toBeVisible();
  expect(api.sessionItemIds).toEqual(["episode-3"]);
  await page.getByRole("button", { name: /After Hours/ }).click();
  await expect.poll(() => api.sessionItemIds).toEqual(["episode-3", "episode-2"]);
  await expect.poll(() => api.events.filter((value) => value === "POST" || value === "DELETE").slice(0, 3)).toEqual(["POST", "DELETE", "POST"]);
  await page.getByRole("button", { name: "Close player" }).click();
  await expect(page.getByText("Selected · S1 E2 · After Hours")).toBeVisible();
  await page.getByRole("button", { name: "Play episode" }).click();
  await expect.poll(() => api.sessionItemIds).toEqual(["episode-3", "episode-2", "episode-2"]);
});

test("opening a title uses history and only Play allocates a stream", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(page).toHaveURL(/item=live-1/);
  await expect(page.getByRole("heading", { name: "North News" })).toBeVisible();
  expect(api.events).not.toContain("POST");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => api.events.includes("POST")).toBe(true);
  const liveSection = page.getByRole("navigation", { name: "Library" }).getByRole("button", { name: "Live TV", exact: true });
  await liveSection.click();
  await expect(liveSection).toHaveAttribute("aria-expanded", "true");
  await liveSection.click();
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  expect(api.events).not.toContain("DELETE");
  await page.goBack();
  await expect(page.getByRole("button", { name: "Open North News" })).toBeVisible();
  await expect.poll(() => api.events.includes("DELETE")).toBe(true);
});

test("live keyword search matches nonadjacent words and deep links resolve", async ({ page }) => {
  const api = await mockApi(page, { catalogItems: [live, { ...live, id: "live-colors", name: "Colors India 4K" }] });
  await page.goto("/");
  await page.getByRole("searchbox").fill("colors 4k");
  await expect(page.getByRole("button", { name: "Open Colors India 4K" })).toBeVisible();
  await page.getByRole("button", { name: "Open Colors India 4K" }).click();
  expect(api.events).not.toContain("POST");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Colors India 4K" })).toBeVisible();
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
  await page.getByRole("button", { name: "Play episode" }).click();
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
      api.events.filter((event) => ["POST", "DELETE"].includes(event)).slice(0, 3),
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
  await page.getByRole("button", { name: "Play episode" }).click();
  await expect
    .poll(
      () => api.events.filter((event) => ["POST", "DELETE"].includes(event)).length,
    )
    .toBe(1);
  await page.getByRole("button", { name: /After Hours/ }).click();
  await expect
    .poll(() =>
      api.events.filter((event) => ["POST", "DELETE"].includes(event)).slice(0, 3),
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

test("browse only fetches selected pages and retries a failed page", async ({
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
    page.getByRole("button", { name: "Open The Quiet Coast" }),
  ).toBeVisible();
  expect(
    api.events.filter((event) => event.startsWith("BROWSE:")),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "Load more" }).click();
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
  await expect(page.getByRole("button", { name: "Open Night Shift" })).toBeVisible();
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

test("mobile library menu restores keyboard focus", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Open library menu" });
  await menu.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  const liveSection = drawer.getByRole("button", { name: "Live TV", exact: true });
  await liveSection.click();
  await expect(liveSection).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.getByRole("button", { name: "Documentary" })).toBeVisible();
  await liveSection.click();
  await expect(liveSection).toHaveAttribute("aria-expanded", "false");
  await expect(drawer.getByRole("button", { name: "Documentary" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(menu).toBeFocused();
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
  await page.screenshot({ path: "/tmp/restream-desktop.png", fullPage: true });
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
  await page.screenshot({ path: "/tmp/restream-movies.png", fullPage: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/restream-categories.png", fullPage: true });
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Live TV", exact: true })
    .click();
  await page.getByRole("button", { name: "Open North News" }).click();
  await expect(page.getByRole("heading", { name: "North News" })).toBeVisible();
  await page.screenshot({ path: "/tmp/restream-detail.png", fullPage: true });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
  await page.screenshot({ path: "/tmp/restream-player.png", fullPage: true });
  await page.getByRole("button", { name: "Back to library" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/restream-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Open North News" }).click();
  await page.screenshot({ path: "/tmp/restream-mobile-detail.png", fullPage: true });
  await page.getByRole("button", { name: "Back to library" }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByRole("button", { name: "Open library menu" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Documentary" })
    .click();
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
