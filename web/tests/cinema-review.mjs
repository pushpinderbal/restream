import { chromium, expect } from "@playwright/test";
import { access, mkdir, writeFile } from "node:fs/promises";

// UI fixtures only: this review checks navigation and layout, not HLS decoding.
const target = process.env.RESTREAM_PREVIEW_URL || "http://127.0.0.1:5173";
const directory = new URL("../../output/cinema-review/", import.meta.url);
await mkdir(directory, { recursive: true });
const fallbackChromium =
  "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (await access(fallbackChromium)
    .then(() => fallbackChromium)
    .catch(() => undefined));
const browser = await chromium.launch({ executablePath });
const posters = [
  "8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
  "gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
  "xUfRZu2mi8jH6SzQEJGP6tjBuYj.jpg",
  "qJ2tW6WMUDux911r6m7haRef0WH.jpg",
  "9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg",
  "d5NXSklXo0qyIYkgV94XAgMIckC.jpg",
].map((path) => `https://image.tmdb.org/t/p/w500/${path}`);
const backdrop =
  "https://image.tmdb.org/t/p/w1280/rLb2cwF3Pazuxaj0sRXQ037tGI1.jpg";
const categories = [
  ["movie", "Drama"],
  ["movie", "Adventure"],
  ["movie", "Documentary"],
  ["series", "Drama"],
  ["series", "Crime"],
  ["series", "Documentary"],
  ["live", "News"],
  ["live", "Sports"],
  ["live", "Documentary"],
].map(([kind, name]) => ({ kind, name, id: `${kind}-${name.toLowerCase()}` }));
const titles = {
  movie: [
    "The Quiet Coast",
    "Beyond the Ridge",
    "A World in Motion",
    "Last Light",
    "Northern Passage",
    "Oceans Apart",
    "The Long Weekend",
    "Across the Valley",
    "Wild Earth",
  ],
  series: [
    "Night Shift",
    "City Stories",
    "Natural Wonders",
    "The Harbour",
    "Cold Case Files",
    "Our Planet",
    "New Beginnings",
    "The District",
    "Open Country",
  ],
  live: [
    "North News",
    "Arena Sports",
    "World Documentary",
    "City News",
    "Sports Extra",
    "Wildlife Channel",
  ],
};
const items = Object.entries(titles).flatMap(([kind, names]) =>
  names.map((name, index) => {
    const category = categories.filter((value) => value.kind === kind)[
      index % 3
    ];
    return {
      id: `${kind}-${index + 1}`,
      kind,
      name,
      category: category.name,
      categoryId: category.id,
      image: kind === "live" ? undefined : posters[index % posters.length],
      number: kind === "live" ? String(index + 1) : undefined,
      duration: 6900,
      description:
        "Unexpected connections and extraordinary places. A story about finding your way, wherever life takes you.",
    };
  }),
);
const episodes = [1, 2, 3].map((episode) => ({
  id: `episode-${episode}`,
  kind: "episode",
  name: ["First Light", "After Hours", "A New Day"][episode - 1],
  episode,
  season: 1,
  category: "Drama",
  duration: 2700,
}));
const discoveryTitles = (kind) =>
  items
    .filter((item) => item.kind === kind)
    .map((item, index) => ({
      item,
      name: item.name,
      poster: item.image,
      backdrop,
      overview: item.description,
      year: 2025 - index,
      rating: 8.2,
      genres: [item.category],
    }));
const programs = items
  .filter((item) => item.kind === "live")
  .flatMap((item) =>
    [0, 1, 2].map((slot) => ({
      channelId: item.id,
      title: ["The Morning Report", "Around the World", "The Evening Edition"][
        slot
      ],
      description: "Stories, perspectives, and events from across the world.",
      start: new Date(Date.now() + (slot * 3600 - 1200) * 1000).toISOString(),
      end: new Date(
        Date.now() + ((slot + 1) * 3600 - 1200) * 1000,
      ).toISOString(),
    })),
  );
const report = {
  target,
  fixtureOnly: true,
  decoderValidated: false,
  checks: [],
  errors: [],
  pageErrors: [],
  screenshots: [],
};

async function mockApi(page) {
  let active = false;
  await page.addInitScript(() => {
    for (const name of [
      "MediaSource",
      "ManagedMediaSource",
      "WebKitMediaSource",
    ])
      Reflect.deleteProperty(window, name);
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return type === "application/vnd.apple.mpegurl"
        ? "probably"
        : original.call(this, type);
    };
    document.addEventListener(
      "error",
      (event) => {
        if (event.target instanceof HTMLMediaElement)
          event.stopImmediatePropagation();
      },
      true,
    );
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    const session = {
      id: "session-1",
      url: "/api/streams/session-1/0/index.m3u8",
      state: "ready",
      duration: 6900,
      offset: 0,
    };
    if (path === "/api/status")
      return json({
        configured: true,
        refreshing: false,
        activeStreams: active ? 1 : 0,
        maxStreams: 2,
        timezone: "UTC",
        guideHours: 48,
        catalogUpdatedAt: "2026-10-15T12:00:00Z",
        libraryUpdatedAt: "2026-10-15T12:00:00Z",
        epgUpdatedAt: "2026-10-15T12:00:00Z",
        playback: { transcodeMode: "auto", sessionTimeoutSeconds: 45 },
        library: {
          liveChannels: 6,
          categories: 9,
          cachedMovies: 9,
          cachedSeries: 9,
          programmes: programs.length,
          guideEndsAt: programs.at(-1).end,
        },
        sync: Object.fromEntries(
          ["catalog", "epg"].map((kind) => [
            kind,
            {
              queued: false,
              running: false,
              lastSuccessfulAt: "2026-10-15T12:00:00Z",
              nextRefreshAt: new Date(Date.now() + 3600000).toISOString(),
              intervalSeconds: 21600,
            },
          ]),
        ),
      });
    if (path === "/api/preferences")
      return json({
        refreshIntervalSeconds: 21600,
        configuration: { dashboardCategories: [], blockedCategories: [] },
        categories: [],
      });
    if (path === "/api/catalog")
      return json({ items: items.filter((item) => item.kind === "live") });
    if (path === "/api/categories") return json({ categories });
    if (path === "/api/epg") return json({ programs });
    if (path === "/api/discovery")
      return json({
        configured: true,
        refreshing: false,
        trendingMovies: discoveryTitles("movie").slice(0, 6),
        trendingSeries: discoveryTitles("series").slice(0, 6),
        exploreMovies: discoveryTitles("movie"),
        exploreSeries: discoveryTitles("series"),
      });
    if (path === "/api/browse") {
      const selected = items.filter(
        (item) =>
          item.kind === url.searchParams.get("kind") &&
          (!url.searchParams.get("category") ||
            url.searchParams.get("category") === "*" ||
            item.categoryId === url.searchParams.get("category")) &&
          item.name
            .toLowerCase()
            .includes((url.searchParams.get("search") || "").toLowerCase()),
      );
      return json({
        items: selected,
        total: selected.length,
        page: Number(url.searchParams.get("page") || 1),
        hasMore: false,
      });
    }
    if (/^\/api\/items\//.test(path))
      return json({
        item: items.find(
          (item) => item.id === decodeURIComponent(path.split("/").at(-1)),
        ),
      });
    if (/^\/api\/series\/[^/]+\/episodes$/.test(path))
      return json({ items: episodes });
    if (path === "/api/sessions" && method === "POST") {
      active = true;
      return json(session, 201);
    }
    if (path === "/api/sessions/session-1" && method === "DELETE") {
      active = false;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/sessions/session-1") return json(session);
    if (path.endsWith("/heartbeat")) return route.fulfill({ status: 204 });
    if (path.endsWith("/index.m3u8"))
      return route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-ENDLIST\n",
      });
    if (path === "/api/refresh") return json({ accepted: true }, 202);
    report.errors.push(`Unexpected API request: ${method} ${path}`);
    return json({ error: "Unexpected review fixture request" }, 404);
  });
}

async function check(page, label, action) {
  console.log(`CHECK ${label}`);
  try {
    await action();
    report.checks.push({ label, passed: true });
  } catch (error) {
    report.checks.push({ label, passed: false, error: error.message });
    await page.screenshot({
      path: new URL(`failure-${report.checks.length}.png`, directory).pathname,
      fullPage: false,
    });
  }
}
async function capture(page, name, preserveScroll = false) {
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      family: getComputedStyle(document.body).fontFamily,
      available: document.fonts.check('16px "Manrope Variable"'),
      loaded: [...document.fonts].some(
        (face) =>
          face.family.includes("Manrope Variable") && face.status === "loaded",
      ),
    };
  });
  expect(
    font.available && font.loaded && font.family.includes("Manrope Variable"),
  ).toBe(true);
  report.fonts ??= [];
  if (
    !report.fonts.some((value) => value.width === page.viewportSize().width)
  ) {
    report.fonts.push({ width: page.viewportSize().width, ...font });
    console.log("FONT", JSON.stringify(report.fonts.at(-1)));
  }
  const detail = preserveScroll || /-(expanded|player)$/.test(name);
  await page.evaluate((detail) => {
    if (!detail) window.scrollTo(0, 0);
    for (const image of document.images) image.loading = "eager";
  }, detail);
  await page.mouse.move((page.viewportSize()?.width || 1440) - 8, 8);
  await page.waitForTimeout(450);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const started = performance.now();
        let last = window.scrollY;
        let settled = started;
        function sample(now) {
          if (window.scrollY !== last) {
            last = window.scrollY;
            settled = now;
          }
          if (now - settled >= 250 || now - started > 2000) resolve();
          else requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      }),
  );
  await page.screenshot({
    path: new URL(`${name}.png`, directory).pathname,
    fullPage: /-search$/.test(name),
    animations: "disabled",
  });
  report.screenshots.push(`${name}.png`);
  const overflow = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll("body *")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          (rect.right > innerWidth + 1 || rect.left < -1) &&
          style.position !== "fixed" &&
          !node.closest('[class*="rail"], [class*="carousel"]')
        );
      })
      .slice(0, 10)
      .map((node) => ({
        tag: node.tagName,
        className: String(node.className),
        width: node.getBoundingClientRect().width,
      })),
  }));
  report.checks.push({
    label: `${name}: document has no horizontal overflow`,
    passed: overflow.document <= overflow.viewport,
    ...overflow,
  });
}
function navigation(page, width) {
  return page.getByRole("navigation", {
    name: width <= 820 ? "Primary navigation" : "Library",
    exact: true,
  });
}

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 1000 : 844 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on("pageerror", (error) =>
      report.pageErrors.push({ width, message: error.message }),
    );
    await mockApi(page);
    await page.goto(target, { waitUntil: "domcontentloaded" });
    const nav = navigation(page, width);
    await check(page, `${width}: five named navigation controls`, async () => {
      await expect(nav).toBeVisible();
      await expect(nav.getByRole("button")).toHaveCount(5);
      await expect(page.locator(".site-header")).toHaveCount(0);
      await expect(page.getByRole("searchbox")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Home", exact: true }),
      ).toHaveCount(0);
      for (const name of ["Home", "Search", "VOD", "Live TV", "Settings"]) {
        const button = nav.getByRole("button", { name, exact: true });
        await expect(button).toBeVisible();
        await expect(button.locator(".navigation-label")).toHaveCount(0);
        await expect(button).toHaveText("");
      }
    });
    await check(page, `${width}: Home discovery loaded`, async () => {
      await expect(
        page.locator(".discovery-feature:not(.discovery-feature-loading)"),
      ).toBeVisible();
    });
    await check(
      page,
      `${width}: discovery rails use bare chevrons and hide scrollbars`,
      async () => {
        const rail = page
          .getByRole("group", { name: "Titles", exact: true })
          .first();
        await expect(rail).toBeVisible();
        await expect(rail).toHaveCSS("scrollbar-width", "none");
        const next = page.getByRole("button", {
          name: "Scroll titles right",
          exact: true,
        });
        await rail.hover();
        await expect(next).toBeEnabled();
        await expect(next).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(next).toHaveCSS("border-top-width", "0px");
        await expect(next).toHaveCSS("box-shadow", "none");
        await next.click();
        await expect
          .poll(() => rail.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0);
        await expect(
          page.getByRole("button", { name: "Scroll titles left", exact: true }),
        ).toBeEnabled();
        await rail.evaluate((element) => {
          element.scrollLeft = 0;
        });
      },
    );
    if (width > 820) {
      await check(
        page,
        `${width}: profile stays at the viewport bottom`,
        async () => {
          const profile = await nav
            .getByRole("button", { name: "Settings", exact: true })
            .boundingBox();
          expect(profile.y + profile.height).toBeGreaterThan(900);
          expect(profile.y + profile.height).toBeLessThanOrEqual(1000);
        },
      );
    }
    await capture(page, `${width}-home`);
    await page.locator(".discovery-picks").scrollIntoViewIfNeeded();
    await capture(page, `${width}-home-rails`, true);
    await check(
      page,
      `${width}: VOD movies and category dropdown`,
      async () => {
        await nav.getByRole("button", { name: "VOD", exact: true }).click();
        await expect(
          page.getByRole("tablist", { name: "VOD type", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("searchbox")).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "On demand", exact: true }),
        ).toHaveCount(0);
        await expect(
          page
            .getByRole("tablist", { name: "VOD type", exact: true })
            .locator("svg"),
        ).toHaveCount(0);
        await expect(
          page.getByRole("combobox", { name: "Category", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Open The Quiet Coast",
            exact: true,
          }),
        ).toBeVisible();
      },
    );
    await capture(page, `${width}-vod`);
    await check(
      page,
      `${width}: accessible category dropdown selection`,
      async () => {
        const category = page.getByRole("combobox", {
          name: "Category",
          exact: true,
        });
        await expect(category).toHaveAttribute("aria-haspopup", "dialog");
        await category.click();
        await expect(
          page.getByRole("option", { name: "All categories", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
          page.getByRole("option", { name: "Adventure", exact: true }),
        ).toBeVisible();
        await capture(page, `${width}-category-menu`);
        await page.keyboard.press("Escape");
        await expect(category).toBeFocused();
        await category.click();
        await page
          .getByRole("combobox", { name: "Find category", exact: true })
          .fill("Adventure");
        await expect(
          page.getByRole("option", { name: "Adventure", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Enter");
        await expect(category).toContainText("Adventure");
        await expect(
          page.getByRole("button", {
            name: "Open Beyond the Ridge",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Open The Quiet Coast",
            exact: true,
          }),
        ).toHaveCount(0);
      },
    );
    await capture(page, `${width}-categories`);
    // Search has its own destination and keeps query state in its URL.
    await nav.getByRole("button", { name: "Search", exact: true }).click();
    await check(page, `${width}: title search`, async () => {
      const search = page
        .getByRole("searchbox", { name: "Search library" })
        .first();
      await expect(search).toHaveValue("");
      await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Search", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("combobox", { name: "Category", exact: true }),
      ).toHaveCount(0);
      await capture(page, `${width}-search-blank`);
      await search.fill("or");
      for (const name of ["Movies results", "Shows results", "Live TV results"])
        await expect(
          page
            .getByRole("region", { name, exact: true })
            .getByRole("button", { name: /^Open / })
            .first(),
        ).toBeVisible();
      await capture(page, `${width}-search`);
      await search.fill("Quiet");
      await expect(
        page.getByRole("button", { name: "Open The Quiet Coast", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Open Beyond the Ridge",
          exact: true,
        }),
      ).toHaveCount(0);
      await capture(page, `${width}-search-movie`);
    });
    await check(page, `${width}: expansion and play navigation`, async () => {
      await page
        .getByRole("button", { name: "Open The Quiet Coast", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Expanded title", exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          async () => {
            const limit =
              width <= 820
                ? (await nav.boundingBox())?.y
                : page.viewportSize().height;
            const play = await page
              .getByRole("button", { name: "Play", exact: true })
              .boundingBox();
            const close = await page
              .getByRole("button", { name: "Close title details", exact: true })
              .boundingBox();
            return Boolean(
              limit &&
                play &&
                close &&
                play.y >= 0 &&
                close.y >= 0 &&
                play.y + play.height <= limit + 1 &&
                close.y + close.height <= limit + 1,
            );
          },
          {
            message:
              "Expanded Play and close controls fit above the fixed navigation",
          },
        )
        .toBe(true);
      await capture(page, `${width}-expanded`);
      await page
        .getByRole("button", { name: "Close title details", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Expanded title", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Open The Quiet Coast", exact: true }),
      ).toBeFocused();
      await page
        .getByRole("button", { name: "Open The Quiet Coast", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Expanded title", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "Player", exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(/view=player/);
      await expect(
        page.getByRole("searchbox", { name: "Search library", exact: true }),
      ).toBeHidden();
      await expect(
        page.getByRole("tablist", { name: "Search type", exact: true }),
      ).toBeHidden();
      await capture(page, `${width}-player`);
      await page.goBack();
      await expect(page).not.toHaveURL(/view=player/);
    });
    await page.goto(`${target}/?view=library&section=movie`, {
      waitUntil: "domcontentloaded",
    });
    await check(page, `${width}: Shows switch and episodes`, async () => {
      await page
        .getByRole("tablist", { name: "VOD type", exact: true })
        .getByRole("tab", { name: "Shows", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Open Night Shift", exact: true }),
      ).toBeVisible();
      await capture(page, `${width}-shows`);
      await page
        .getByRole("button", { name: "Open Night Shift", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Expanded title", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Play First Light", exact: true }),
      ).toBeVisible();
    });
    await check(page, `${width}: Live TV and category selection`, async () => {
      await expect(
        page.getByRole("heading", { name: "Live TV", exact: true }),
      ).toHaveCount(0);
      await nav.getByRole("button", { name: "Live TV", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Live TV", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Open North News", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Category", exact: true }),
      ).toBeVisible();
      await capture(page, `${width}-live`);
      await page
        .getByRole("combobox", { name: "Category", exact: true })
        .click();
      await page.getByRole("option", { name: "Sports", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Open Arena Sports", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Open North News", exact: true }),
      ).toHaveCount(0);
    });
    await check(page, `${width}: Settings and return home`, async () => {
      await nav.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: /Settings/i }).first(),
      ).toBeVisible();
      await capture(page, `${width}-settings`);
      await nav.getByRole("button", { name: "Home", exact: true }).click();
      await expect(page).not.toHaveURL(/view=settings/);
    });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(
    new URL("report.json", directory),
    JSON.stringify(report, null, 2),
  );
  const failures = report.checks.filter((check) => !check.passed);
  await writeFile(
    new URL("report.md", directory),
    [
      "# Cinema UI review",
      "",
      `${report.checks.length - failures.length} checks passed; ${failures.length} failed. ${report.pageErrors.length} browser page errors.`,
      "",
      "Viewport screenshots: 1440 × 1000, 390 × 844, and 320 × 844. Fixed navigation is captured at its actual viewport position. Grouped Search results use full-page captures to show every section.",
      "",
      "Verified navigation, Home discovery, Movies/Shows, accessible category dropdown, rail chevrons, hidden scrollbars, global Search groups and query state, inline expansion, Play navigation, browser Back, episode listing, Live TV category selection, Settings, and document width.",
      "",
      "API and media responses are fixtures. Playback verification covers navigation and player presentation; this review does not validate media decoding. The workflow/real-playback suites cover playback separately.",
      "",
      ...failures.map(
        (failure) =>
          `- FAIL ${failure.label}: ${failure.error || JSON.stringify(failure)}`,
      ),
      "",
      "Screenshots:",
      ...report.screenshots.map((name) => `- [${name}](${name})`),
      "",
    ].join("\n"),
  );
  console.log(
    JSON.stringify(
      {
        passed: report.checks.length - failures.length,
        failed: failures.length,
        pageErrors: report.pageErrors,
        failures,
      },
      null,
      2,
    ),
  );
  if (failures.length || report.pageErrors.length || report.errors.length)
    process.exitCode = 1;
}
