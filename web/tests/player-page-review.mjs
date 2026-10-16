import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const target = process.env.RESTREAM_PREVIEW_URL || "http://127.0.0.1:8080";
const reviewTarget = process.env.RESTREAM_REVIEW_TARGET;
const runtimeReview = reviewTarget === "movie-runtime";
const libraryMovieReview = reviewTarget === "library-movie";
const referenceReview =
  reviewTarget === "reference-live" ||
  reviewTarget === "reference-series" ||
  libraryMovieReview;
const directory = new URL(
  runtimeReview || referenceReview
    ? `../../output/watch-workspace-review/${reviewTarget}/`
    : "../../output/watch-workspace-review/",
  import.meta.url,
);
const historyKey = "restream.watch-history.v1";
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const sessionIds = new Set();
const responses = new Set();
const report = {
  errors: [],
  console: [],
  starts: [],
  decoded: [],
  interactions: [],
  viewports: [],
  sessionEvents: [],
};
let sessionDuration = 0;
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (path === "/api/sessions" && request.method() === "POST")
    report.sessionEvents.push({
      action: "create",
      itemId: request.postDataJSON().itemId,
    });
  if (/^\/api\/sessions\/[^/]+$/.test(path) && request.method() === "DELETE")
    report.sessionEvents.push({ action: "release" });
});
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning")
    report.console.push({
      type: message.type(),
      text: message.text().replace(/https?:\/\/\S+/g, "[URL]"),
    });
});
page.on("response", (response) => {
  if (
    response.request().method() !== "POST" ||
    new URL(response.url()).pathname !== "/api/sessions" ||
    response.status() !== 201
  )
    return;
  const body = response.request().postDataJSON();
  const task = response
    .json()
    .then((session) => {
      sessionIds.add(session.id);
      sessionDuration = session.duration;
      report.starts.push({ itemId: body.itemId, start: body.start || 0 });
    })
    .catch(() => {})
    .finally(() => responses.delete(task));
  responses.add(task);
});
const navigation = () =>
  page.getByRole("navigation", {
    name: page.viewportSize().width <= 820 ? "Primary navigation" : "Library",
    exact: true,
  });
const navigateLibrary = async (kind) => {
  const types = page.getByRole("tablist", { name: "VOD type", exact: true });
  if (kind === "live" || !(await types.isVisible()))
    await navigation()
      .getByRole("button", {
        name: kind === "live" ? "Live TV" : "VOD",
        exact: true,
      })
      .click();
  if (kind !== "live")
    await types
      .getByRole("tab", {
        name: kind === "movie" ? "Movies" : "Shows",
        exact: true,
      })
      .click();
};
const openSearch = async () => {
  await navigation()
    .getByRole("button", { name: "Search", exact: true })
    .click();
  const input = page.getByRole("searchbox", {
    name: "Search library",
    exact: true,
  });
  await expect(input).toHaveValue("");
  return input;
};
const workspace = () =>
  page.getByRole("region", { name: "Watch workspace", exact: true });
const sidebar = () =>
  workspace().getByRole("complementary", {
    name: "Watch context",
    exact: true,
  });
const history = () =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || '{"entries":[]}').entries,
    historyKey,
  );
const noPlayback = async () => {
  await expect(page.locator("video")).toHaveCount(0, { timeout: 15000 });
  await expect
    .poll(async () => (await page.request.get(`${target}/api/status`)).json(), {
      timeout: 15000,
    })
    .toMatchObject({ activeStreams: 0 });
};
const decoded = async (action, libraryKind) => {
  await expect(workspace()).toBeVisible();
  await expect(page.locator("video")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Back to / })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /NOW PLAYING/i })).toHaveCount(
    0,
  );
  await expect(sidebar()).toBeVisible();
  const origin = await page.evaluate(
    () => window.history.state?.restreamPlayerOrigin?.url,
  );
  const fromSearch =
    origin && new URL(origin, page.url()).searchParams.get("view") === "search";
  if (fromSearch) {
    await expect(
      page.getByRole("region", { name: /^(Movies|Shows|Live TV) results$/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: /^(Movies|Shows|Live TV) library$/ }),
    ).toHaveCount(0);
    await expect(
      navigation().getByRole("button", { name: "Search", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  } else if (libraryKind) {
    const label =
      libraryKind === "live"
        ? "Live TV"
        : libraryKind === "movie"
          ? "Movies"
          : "Shows";
    await expect(
      page.getByRole("region", { name: `${label} library`, exact: true }),
    ).toBeVisible({ timeout: 90000 });
    await expect(
      page.getByRole("region", { name: "Explore", exact: true }),
    ).toHaveCount(0);
  } else {
    await expect(
      page.getByRole("region", { name: "Explore", exact: true }),
    ).toBeVisible({ timeout: 90000 });
  }
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("view")).toBe("player");
  await page.waitForFunction(
    () => {
      const video = document.querySelector("video");
      return (
        video &&
        !video.paused &&
        video.currentTime > 0.5 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      );
    },
    undefined,
    { timeout: 90000 },
  );
  const sample = await page.locator("video").evaluate((video) => ({
    width: video.videoWidth,
    height: video.videoHeight,
    currentTime: video.currentTime,
  }));
  report.decoded.push({ action, ...sample });
  console.log(`Verified real decoded playback: ${action}`);
};
const waitForProgress = async () => {
  await page.waitForFunction(
    () => document.querySelector("video")?.currentTime >= 12,
    undefined,
    { timeout: 90000 },
  );
  await page.locator(".playback-area").hover();
  await page
    .getByRole("region", { name: "Player", exact: true })
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await history()).find((entry) => entry.title.kind !== "live")
          ?.position,
      { timeout: 10000 },
    )
    .toBeGreaterThanOrEqual(10);
};
const screenshot = async (name) => {
  if (name.startsWith("workspace-"))
    await page.locator(".playback-area").hover();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: new URL(name, directory).pathname,
    fullPage: true,
  });
};
const dashboard = async () => {
  await navigation().getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Home", exact: true }),
  ).toBeVisible();
  await noPlayback();
};
const viewport = async (width, height) => {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(350);
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth > innerWidth,
    overflowing: [...document.querySelectorAll("body *")]
      .map((element) => ({
        element: element.tagName,
        class:
          typeof element.className === "string" ? element.className : "svg",
        right: element.getBoundingClientRect().right,
        width: element.getBoundingClientRect().width,
      }))
      .filter((element) => element.width > 0 && element.right > innerWidth + 1)
      .slice(0, 12),
  }));
  report.viewports.push({ width, ...layout });
  expect(layout.overflow, JSON.stringify(layout.overflowing)).toBe(false);
};

const captureReference = async () => {
  const live = reviewTarget === "reference-live";
  const kind = live ? "live" : libraryMovieReview ? "movie" : "series";
  let query = live
    ? "CP24"
    : libraryMovieReview
      ? process.env.RESTREAM_REVIEW_MOVIE_SEARCH || "Practical"
      : "Designated Survivor";
  const lookupCategory = libraryMovieReview
    ? process.env.RESTREAM_REVIEW_MOVIE_CATEGORY || "71"
    : "*";
  const catalog = await (
    await page.request.get(
      live
        ? `${target}/api/catalog`
        : `${target}/api/browse?kind=${kind}&category=${encodeURIComponent(lookupCategory)}&search=${encodeURIComponent(query)}&page=1`,
    )
  ).json();
  const title = catalog.items.find((item) =>
    live
      ? item.kind === "live" && item.name === "CP24 4K"
      : libraryMovieReview
        ? item.kind === "movie"
        : item.kind === "series" &&
          /^Designated Survivor(?: -|$)/.test(item.name),
  );
  expect(title).toBeTruthy();
  if (libraryMovieReview)
    query =
      title.name.split(/\s+/).find((word) => word.length > 3) || title.name;
  await page.goto(`${target}/?view=search`);
  await page
    .getByRole("searchbox", { name: "Search library", exact: true })
    .fill(query);
  await page
    .getByRole("region", {
      name: live
        ? "Live TV results"
        : libraryMovieReview
          ? "Movies results"
          : "Shows results",
      exact: true,
    })
    .getByRole("button", { name: `Open ${title.name}`, exact: true })
    .click({ timeout: 90000 });
  let selected = title;
  if (live || libraryMovieReview) {
    await page
      .getByRole("region", { name: "Expanded title", exact: true })
      .getByRole("button", { name: "Play", exact: true })
      .click();
  } else {
    await page.getByRole("combobox", { name: "Season", exact: true }).click();
    await page.getByRole("option", { name: "Season 2", exact: true }).click();
    const episodePage = await (
      await page.request.get(
        `${target}/api/series/${encodeURIComponent(title.id)}/episodes?season=2`,
      )
    ).json();
    selected = episodePage.items.find(
      (item) =>
        item.kind === "episode" && item.season === 2 && item.episode === 1,
    );
    expect(selected).toBeTruthy();
    await page
      .getByRole("region", { name: "Expanded title", exact: true })
      .getByRole("button", { name: `Play ${selected.name}`, exact: true })
      .click({ timeout: 90000 });
  }
  await decoded(
    live
      ? "CP24 4K reference"
      : libraryMovieReview
        ? "library movie reference"
        : "Designated Survivor S2 E1 reference",
    kind,
  );
  await Promise.allSettled([...responses]);
  expect(report.starts.at(-1).itemId).toBe(selected.id);
  if (libraryMovieReview) {
    const origin = await page.evaluate(
      () => window.history.state.restreamPlayerOrigin.url,
    );
    const switchAt = report.sessionEvents.length;
    await page.goBack();
    await expect.poll(() => page.url()).toBe(origin);
    await noPlayback();
    await expect(
      page.getByRole("searchbox", { name: "Search library", exact: true }),
    ).toHaveValue(query);
    await page.goForward();
    await decoded("Search movie restored by browser Forward", "movie");
    expect(report.starts.at(-1).itemId).toBe(selected.id);
    expect(
      report.sessionEvents.slice(switchAt).map((event) => event.action),
    ).toEqual(["release", "create"]);
    report.interactions.push(
      "Browser Back restored the exact Search query and released playback; Forward decoded the same movie again.",
    );
  }
  report.reference = {
    title: title.name,
    titleId: title.id,
    playedItemId: selected.id,
    season: selected.season,
    episode: selected.episode,
  };
  if (!live && !libraryMovieReview) {
    await expect(
      sidebar().getByRole("combobox", { name: "Season", exact: true }),
    ).toHaveText("Season 2");
    await expect(
      sidebar().getByRole("button", {
        name: `Play ${selected.name}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
  }
  report.metadataConfigured = (
    await (await page.request.get(`${target}/api/discovery`)).json()
  ).configured;
  await viewport(1440, 1024);
  await page.locator(".playback-area").hover();
  await page.screenshot({
    path: new URL(`workspace-${kind}-viewport-desktop.png`, directory).pathname,
    fullPage: false,
  });
  await screenshot(`workspace-${kind}-desktop.png`);
  await viewport(390, 844);
  await page.locator(".playback-area").hover();
  await page.screenshot({
    path: new URL(`workspace-${kind}-viewport-mobile.png`, directory).pathname,
    fullPage: false,
  });
  await screenshot(`workspace-${kind}-mobile.png`);
  await viewport(320, 844);
  await expect(page.locator("video")).toHaveCount(1);
  const searchOrigin = await page.evaluate(
    () => window.history.state.restreamPlayerOrigin.url,
  );
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await noPlayback();
  await expect.poll(() => page.url()).toBe(searchOrigin);
  await expect(
    page.getByRole("searchbox", { name: "Search library", exact: true }),
  ).toHaveValue(query);
  report.interactions.push(
    "Reference source decoded on desktop/mobile, then Stop released its only session.",
  );
};

try {
  if (referenceReview) {
    await captureReference();
  } else {
    await page.goto(`${target}/?view=dashboard`);
    await expect(page.locator(".discovery-poster-card").first()).toBeVisible({
      timeout: 120000,
    });
    const discovery = await (
      await page.request.get(`${target}/api/discovery`)
    ).json();
    report.metadataConfigured = discovery.configured;
    expect(await history()).toEqual([]);
    if (!runtimeReview) {
      await screenshot("dashboard-empty-desktop.png");
      await viewport(390, 844);
      await screenshot("dashboard-empty-mobile.png");
      await viewport(1440, 1024);
    }
    const playMovie = page
      .locator(".discovery-feature-actions")
      .getByRole("button", { name: /^Play/ });
    let initialMovieContext;
    if (await playMovie.isVisible()) await playMovie.click();
    else {
      initialMovieContext = "movie";
      await navigateLibrary("movie");
      await page
        .getByRole("region", { name: "Movies library", exact: true })
        .locator(".media-card")
        .first()
        .click({ timeout: 90000 });
      await page
        .getByRole("region", { name: "Expanded title", exact: true })
        .getByRole("button", { name: "Play", exact: true })
        .click();
    }
    await decoded("initial movie", initialMovieContext);
    if (runtimeReview) {
      await Promise.allSettled([...responses]);
      const initialDuration = sessionDuration;
      // The initial create response may still carry provider metadata. Playback
      // readiness polling replaces it with the probed full source duration.
      const readySession = await (
        await page.request.get(
          `${target}/api/sessions/${encodeURIComponent([...sessionIds].at(-1))}`,
        )
      ).json();
      sessionDuration = readySession.duration;
      expect(sessionDuration).toBeGreaterThan(0);
      const minutes = Math.round(sessionDuration / 60);
      const durationText =
        minutes >= 60
          ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
          : `${minutes}m`;
      await expect(sidebar().locator(".watch-media-meta")).toContainText(
        `Movie · ${durationText}`,
      );
      const sourceSeconds = Math.floor(sessionDuration);
      const clockDuration = `${sourceSeconds >= 3600 ? `${Math.floor(sourceSeconds / 3600)}:` : ""}${String(Math.floor(sourceSeconds / 60) % 60).padStart(2, "0")}:${String(sourceSeconds % 60).padStart(2, "0")}`;
      await page.locator(".playback-area").hover();
      await expect(page.locator(".time-readout")).toContainText(
        `/ ${clockDuration}`,
      );
      const movie = (await history()).find(
        (entry) => entry.title.kind === "movie",
      );
      report.runtime = {
        itemDuration: movie.title.duration,
        initialDuration,
        sourceDuration: sessionDuration,
        sidebar: await sidebar().locator(".watch-media-meta").innerText(),
        playerClock: await page.locator(".time-readout").innerText(),
      };
      await page.screenshot({
        path: new URL("workspace-movie-viewport-desktop.png", directory)
          .pathname,
        fullPage: false,
      });
      await screenshot("workspace-movie-desktop.png");
      await viewport(390, 844);
      await screenshot("workspace-movie-mobile.png");
      for (const width of [900, 821, 320]) await viewport(width, 844);
      await page
        .getByRole("button", { name: "Stop playback", exact: true })
        .click();
      await noPlayback();
      report.interactions.push(
        "The movie sidebar and player clock used the probed source runtime; Stop released its only session.",
      );
    } else {
      await waitForProgress();
      const movie = (await history()).find(
        (entry) => entry.title.kind === "movie",
      );
      expect(movie.position).toBeGreaterThanOrEqual(10);
      await navigation()
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible();
      await noPlayback();
      report.interactions.push(
        "Movie progress saved and session released on navigation to Settings.",
      );

      await page.goBack();
      await decoded("movie restored by browser Back", initialMovieContext);
      expect(report.starts.at(-1).start).toBeGreaterThanOrEqual(
        movie.position - 0.1,
      );
      await page.reload();
      await decoded("movie restored by reload", initialMovieContext);
      expect(report.starts.at(-1).itemId).toBe(movie.item.id);
      const origin = await page.evaluate(
        () => window.history.state?.restreamPlayerOrigin,
      );
      await page
        .getByRole("button", { name: "Stop playback", exact: true })
        .click();
      await expect.poll(() => page.url()).toBe(origin.url);
      await noPlayback();
      report.interactions.push(
        "Browser Back and full reload resumed real movie playback; Stop restored its origin.",
      );
      if (new URL(page.url()).searchParams.get("view") !== "dashboard")
        await dashboard();

      const resume = page.getByRole("button", {
        name: `Resume ${movie.title.name}`,
        exact: true,
      });
      await expect(resume).toBeVisible();
      await resume.click();
      await decoded("movie Resume");
      expect(report.starts.at(-1).start).toBeGreaterThan(10);
      const originalMovieVideo = await page.locator("video").elementHandle();
      const activeExplore = page.getByRole("region", {
        name: "Explore",
        exact: true,
      });
      const startsBeforeExplore = report.starts.length;
      const shows = activeExplore
        .getByRole("group", { name: "Discovery type", exact: true })
        .getByRole("button", { name: "Shows", exact: true });
      if (await shows.isEnabled()) {
        await shows.click();
        await expect(
          activeExplore.locator(".discovery-poster-card").first(),
        ).toBeVisible({ timeout: 90000 });
      }
      await activeExplore
        .getByRole("group", { name: "Discovery type", exact: true })
        .getByRole("button", { name: "Movies", exact: true })
        .click();
      expect(report.starts.length).toBe(startsBeforeExplore);
      expect(
        await originalMovieVideo.evaluate(
          (element) => element === document.querySelector("video"),
        ),
      ).toBe(true);
      await expect(page.getByRole("searchbox")).toHaveCount(0);
      report.interactions.push(
        "Home discovery type controls preserved the same decoder/session; Search remains a separate destination.",
      );
      await screenshot("workspace-movie-desktop.png");
      await viewport(390, 844);
      await screenshot("workspace-movie-mobile.png");
      await expect(
        page
          .getByRole("navigation", { name: "Primary navigation", exact: true })
          .getByRole("button"),
      ).toHaveCount(5);
      await viewport(1440, 1024);
      const resumeOrigin = await page.evaluate(
        () => window.history.state.restreamPlayerOrigin,
      );
      await page
        .getByRole("button", { name: "Stop playback", exact: true })
        .click();
      await noPlayback();
      await expect(
        page.getByRole("region", { name: "Home", exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          () =>
            page.evaluate(
              (scroll) => Math.abs(scrollY - scroll),
              resumeOrigin.scroll,
            ),
          { timeout: 10000 },
        )
        .toBeLessThan(3);
      report.interactions.push(
        "Home Resume used a nonzero source position and Stop restored the origin scroll.",
      );

      await openSearch();
      await page
        .getByRole("searchbox", { name: "Search library", exact: true })
        .fill("CP24");
      const channel = page
        .getByRole("region", { name: "Live TV results", exact: true })
        .getByRole("button", { name: /^Open / })
        .filter({ hasText: "CP24" })
        .first();
      await channel.click({ timeout: 90000 });
      await page
        .getByRole("region", { name: "Expanded title", exact: true })
        .getByRole("button", { name: "Play", exact: true })
        .click();
      await decoded("Live TV", "live");
      const channels = sidebar().getByRole("region", {
        name: "Channels",
        exact: true,
      });
      await expect(channels).toBeVisible();
      const watchButtons = channels.getByRole("button", { name: /^Watch / });
      let alternative;
      for (const button of await watchButtons.all()) {
        if (
          (await button.getAttribute("aria-current")) !== "true" &&
          /CP24/i.test(await button.getAttribute("aria-label"))
        ) {
          alternative = button;
          break;
        }
      }
      if (!alternative) {
        for (const button of await watchButtons.all()) {
          if ((await button.getAttribute("aria-current")) !== "true") {
            alternative = button;
            break;
          }
        }
      }
      expect(alternative).toBeTruthy();
      const switchAt = report.sessionEvents.length;
      await alternative.click();
      await decoded("Live TV switched through sidebar", "live");
      expect(
        report.sessionEvents.slice(switchAt).map((event) => event.action),
      ).toEqual(["release", "create"]);
      await screenshot("workspace-live-desktop.png");
      await viewport(390, 844);
      await screenshot("workspace-live-mobile.png");
      await viewport(1440, 1024);
      await navigateLibrary("movie");
      await noPlayback();
      await expect(
        page.getByRole("region", { name: "Movies library", exact: true }),
      ).toBeVisible();
      report.interactions.push(
        "Real Live TV switched from a contextual channel row with release-before-create; Movies navigation released playback.",
      );

      await openSearch();
      await page
        .getByRole("searchbox", { name: "Search library", exact: true })
        .fill(
          process.env.RESTREAM_REVIEW_SERIES_SEARCH || "Designated Survivor",
        );
      await page
        .getByRole("region", { name: "Shows results", exact: true })
        .getByRole("button", { name: /^Open / })
        .filter({
          hasText:
            process.env.RESTREAM_REVIEW_SERIES_SEARCH || "Designated Survivor",
        })
        .first()
        .click({ timeout: 90000 });
      await page.locator(".episode-row").first().waitFor({ timeout: 90000 });
      await page.getByRole("combobox", { name: "Season", exact: true }).click();
      const options = page.getByRole("option");
      if ((await options.count()) > 1) await options.nth(1).click();
      else await page.keyboard.press("Escape");
      await page.locator(".episode-row").first().waitFor({ timeout: 90000 });
      await page.locator(".episode-row").first().click();
      await decoded("selected series episode", "series");
      const episode = report.starts.at(-1).itemId;
      const seriesURL = page.url();
      await page.waitForFunction(
        () => document.querySelector("video")?.currentTime >= 12,
        undefined,
        { timeout: 90000 },
      );
      await page.locator(".playback-area").hover();
      await page
        .getByRole("region", { name: "Player", exact: true })
        .getByRole("button", { name: "Pause", exact: true })
        .click();
      const seriesEntry = (await history()).find(
        (entry) => entry.title.kind === "series",
      );
      expect(seriesEntry.position).toBeGreaterThanOrEqual(10);
      await page.reload();
      await decoded("selected series episode restored by reload", "series");
      expect(page.url()).toBe(seriesURL);
      expect(report.starts.at(-1).itemId).toBe(episode);
      expect(report.starts.at(-1).start).toBeGreaterThanOrEqual(
        seriesEntry.position - 0.1,
      );
      const episodePage = await (
        await page.request.get(
          `${target}/api/series/${encodeURIComponent(seriesEntry.title.id)}/episodes?season=${seriesEntry.item.season || 1}`,
        )
      ).json();
      const seasonEpisodes = episodePage.items
        .filter((item) => item.kind === "episode")
        .sort((a, b) => (a.episode || 0) - (b.episode || 0));
      const nextEpisode =
        seasonEpisodes[
          seasonEpisodes.findIndex((item) => item.id === episode) + 1
        ];
      expect(nextEpisode).toBeTruthy();
      const episodeSwitchAt = report.sessionEvents.length;
      await sidebar()
        .getByRole("button", { name: `Play ${nextEpisode.name}`, exact: true })
        .click();
      await decoded("series episode switched through sidebar", "series");
      expect(report.starts.at(-1).itemId).toBe(nextEpisode.id);
      expect(
        report.sessionEvents
          .slice(episodeSwitchAt)
          .map((event) => event.action),
      ).toEqual(["release", "create"]);
      await expect(
        sidebar().getByRole("button", {
          name: `Play ${nextEpisode.name}`,
          exact: true,
        }),
      ).toHaveAttribute("aria-current", "true");
      await screenshot("workspace-series-desktop.png");
      await viewport(390, 844);
      await screenshot("workspace-series-mobile.png");
      await viewport(1440, 1024);
      await page
        .getByRole("complementary", { name: "Watch context", exact: true })
        .getByRole("button", { name: "Title details", exact: true })
        .click();
      await noPlayback();
      await expect(
        page.getByRole("combobox", { name: "Season", exact: true }),
      ).toHaveText(`Season ${seriesEntry.item.season || 1}`);
      report.interactions.push(
        "A real selected episode survived workspace reload, switched through side episodes with release-before-create, and Title details returned to the correct season without playback.",
      );

      await dashboard();
      await expect(
        page.getByRole("region", { name: "Recently played", exact: true }),
      ).toBeVisible();
      await screenshot("dashboard-desktop.png");
      for (const width of [900, 821, 390, 320]) {
        await viewport(width, 844);
        if (width === 390) await screenshot("dashboard-mobile.png");
      }
    }
  }
  expect(report.errors).toEqual([]);
} catch (error) {
  report.failure = error.message;
  report.alerts = await page
    .getByRole("alert")
    .allTextContents()
    .catch(() => []);
  await screenshot("failure.png").catch(() => {});
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...responses]);
  for (const id of sessionIds)
    await page.request
      .delete(`${target}/api/sessions/${encodeURIComponent(id)}`)
      .catch(() => {});
  await writeFile(
    new URL("review.json", directory),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
