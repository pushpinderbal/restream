import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const target = process.env.RESTREAM_PREVIEW_URL || "http://127.0.0.1:5180";
const seriesSearch =
  process.env.RESTREAM_REVIEW_SERIES_SEARCH || "Designated Survivor";
const historyKey = "restream.watch-history.v1";
const directory = new URL(
  "../../output/discovery-dashboard-review/",
  import.meta.url,
);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const sessionIds = new Set();
const responseTasks = new Set();
const report = {
  metadataConfigured: null,
  errors: [],
  interactions: [],
  verifiedPlayback: [],
  sessionStarts: [],
  seededCompletion: [],
  viewportChecks: [],
};
let seekRequests = 0;
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (request.method() === "POST" && path === "/api/sessions") {
    const body = request.postDataJSON();
    report.sessionStarts.push({ itemId: body.itemId, start: body.start || 0 });
  }
  if (request.method() === "POST" && /\/api\/sessions\/[^/]+\/seek$/.test(path))
    seekRequests++;
});
page.on("response", (response) => {
  const path = new URL(response.url()).pathname;
  if (
    (response.request().method() === "POST" &&
      path === "/api/sessions" &&
      response.status() === 201) ||
    (path === "/api/discovery" && response.ok())
  ) {
    const task = response
      .json()
      .then((body) => {
        if (path === "/api/sessions") sessionIds.add(body.id);
        else {
          report.metadataConfigured = body.configured;
          report.discovery = {
            trendingMovies: body.trendingMovies?.length || 0,
            trendingSeries: body.trendingSeries?.length || 0,
            exploreMovies: body.exploreMovies?.length || 0,
            exploreSeries: body.exploreSeries?.length || 0,
          };
        }
      })
      .catch(() => {})
      .finally(() => responseTasks.delete(task));
    responseTasks.add(task);
  }
});

const screenshot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({
    path: new URL(name, directory).pathname,
    fullPage: true,
  });
};
const dashboard = async () => {
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
};
const history = () =>
  page.evaluate((key) => {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved).entries : [];
  }, historyKey);
const personalSectionsAreEmpty = async () => {
  await expect(
    page.getByRole("region", { name: "Continue watching", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Recently played", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Up next", exact: true }),
  ).toHaveCount(0);
};
const discoveryIsUseful = async () => {
  await expect(page.locator(".discovery-poster-card").first()).toBeVisible({
    timeout: 120000,
  });
  await expect
    .poll(() => report.metadataConfigured, { timeout: 120000 })
    .not.toBeNull();
  const label =
    report.discovery.trendingMovies || report.discovery.trendingSeries
      ? "Trending now"
      : "Explore your library";
  await expect(
    page.getByRole("region", { name: label, exact: true }),
  ).toBeVisible();
  if (!report.metadataConfigured) {
    expect(report.discovery.trendingMovies).toBe(0);
    expect(report.discovery.trendingSeries).toBe(0);
    await expect(
      page.getByRole("heading", { name: "Trending now", exact: true }),
    ).toHaveCount(0);
  }
};
const decoded = async (kind, title, action = "play") => {
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
    currentTime: Number(video.currentTime.toFixed(2)),
  }));
  report.verifiedPlayback.push({ kind, title, action, ...sample });
  console.log(`Verified real playback: ${kind}, ${action}, ${title}`);
};
const stop = async () => {
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await expect(page.locator("video")).toHaveCount(0, { timeout: 15000 });
  await expect
    .poll(async () => (await page.request.get(`${target}/api/status`)).json(), {
      timeout: 15000,
    })
    .toMatchObject({ activeStreams: 0 });
};
const recentCard = (title) =>
  page
    .getByRole("region", { name: "Recently played", exact: true })
    .getByRole("button", { name: `Open ${title}`, exact: true });
const recordCompletion = async () => {
  const entry = (await history()).find(
    (value) => value.title.kind === "series",
  );
  expect(entry).toBeTruthy();
  report.seededCompletion.push({
    title: entry.title.name,
    episode: entry.item.name,
    season: entry.item.season || 1,
    episodeNumber: entry.item.episode,
    note: "Completion seeded from a genuinely played provider episode; not a full episode viewing.",
  });
  await page.evaluate(
    ({ key, id }) => {
      const saved = JSON.parse(localStorage.getItem(key));
      saved.entries = saved.entries.map((value) =>
        value.title.id === id
          ? {
              ...value,
              completed: true,
              position: value.duration || value.position,
              updatedAt: Date.now(),
            }
          : value,
      );
      localStorage.setItem(key, JSON.stringify(saved));
    },
    { key: historyKey, id: entry.title.id },
  );
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "Up next", exact: true }),
  ).toBeVisible({ timeout: 90000 });
  return entry;
};
const providerNextEpisode = async (entry) => {
  const season = entry.item.season || 1;
  const path = `${target}/api/series/${encodeURIComponent(entry.title.id)}/episodes`;
  const response = await page.request.get(`${path}?season=${season}`);
  expect(response.ok()).toBe(true);
  const result = await response.json();
  const episodes = result.items
    .filter((item) => item.kind === "episode")
    .sort(
      (a, b) =>
        (a.season || 1) - (b.season || 1) ||
        (a.episode || 0) - (b.episode || 0),
    );
  const index = episodes.findIndex((item) => item.id === entry.item.id);
  expect(index).toBeGreaterThanOrEqual(0);
  if (episodes[index + 1]) return episodes[index + 1];
  const nextSeason = result.seasons
    ?.filter((value) => value > season)
    .sort((a, b) => a - b)[0];
  expect(nextSeason).toBeDefined();
  const following = await (
    await page.request.get(`${path}?season=${nextSeason}`)
  ).json();
  return following.items
    .filter((item) => item.kind === "episode")
    .sort((a, b) => (a.episode || 0) - (b.episode || 0))[0];
};

try {
  await page.goto(`${target}/?view=dashboard`);
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  expect(await history()).toEqual([]);
  await personalSectionsAreEmpty();
  await discoveryIsUseful();
  await screenshot("desktop-empty.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("mobile-empty.png");

  await page
    .getByRole("button", { name: "Browse Live TV", exact: true })
    .first()
    .click();
  await page.getByRole("searchbox", { name: "Search channels" }).fill("CP24");
  const unopenedChannel = page
    .getByRole("region", { name: "Live TV library", exact: true })
    .locator(".media-card")
    .filter({ hasText: "CP24" })
    .first();
  await unopenedChannel.click({ timeout: 90000 });
  await dashboard();
  await personalSectionsAreEmpty();
  expect(await history()).toEqual([]);
  report.interactions.push(
    "Opening CP24 details does not create watch history.",
  );

  await page.setViewportSize({ width: 1487, height: 1058 });
  let movieEntry;
  for (const [kind, label] of [
    ["live", "Live TV"],
    ["movie", "Movies"],
    ["series", "Series"],
  ]) {
    await page
      .getByRole("button", { name: `Browse ${label}`, exact: true })
      .first()
      .click();
    if (kind === "live")
      await page
        .getByRole("searchbox", { name: "Search channels" })
        .fill("CP24");
    if (kind === "series")
      await page
        .getByRole("searchbox", { name: "Search titles" })
        .fill(seriesSearch);
    const tile = page
      .getByRole("region", { name: `${label} library`, exact: true })
      .locator(".media-card")
      .filter({
        hasText:
          kind === "series" ? seriesSearch : kind === "live" ? "CP24" : "",
      })
      .first();
    await tile.waitFor({ timeout: 90000 });
    const title = await tile.locator("h3").innerText();
    await tile.click();
    if (kind === "series")
      await page.locator(".episode-row").first().click({ timeout: 90000 });
    else await page.getByRole("button", { name: "Play", exact: true }).click();
    await decoded(kind, title);

    if (kind === "movie") {
      const bufferedSeek = await page.waitForFunction(
        () => {
          const video = document.querySelector("video");
          if (!video) return false;
          return (
            [10, -10].find((delta) => {
              const target = video.currentTime + delta;
              return (
                target >= 16 &&
                Array.from({ length: video.buffered.length }, (_, i) => i).some(
                  (i) =>
                    video.buffered.start(i) + 0.5 <= target &&
                    video.buffered.end(i) > target + 0.5,
                )
              );
            }) || false
          );
        },
        undefined,
        { timeout: 60000 },
      );
      const delta = await bufferedSeek.jsonValue();
      const seeksBefore = seekRequests;
      const area = page.locator(".playback-area");
      await area.focus();
      const initialPosition = await page
        .locator("video")
        .evaluate((video) => video.currentTime);
      await area.press(delta > 0 ? "ArrowRight" : "ArrowLeft");
      await expect
        .poll(() =>
          page
            .locator("video")
            .evaluate(
              (video, desired) => Math.abs(video.currentTime - desired),
              initialPosition + delta,
            ),
        )
        .toBeLessThan(2);
      await expect
        .poll(() =>
          page.locator("video").evaluate((video) => video.currentTime),
        )
        .toBeGreaterThanOrEqual(15);
      expect(seekRequests).toBe(seeksBefore);
      await area.hover();
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect
        .poll(() => page.locator("video").evaluate((video) => video.paused))
        .toBe(true);
      report.interactions.push(
        "Used real player keyboard seeking inside the movie buffer, paused after 15 seconds, without a server seek.",
      );
    }
    await stop();
    await dashboard();
    await expect(recentCard(title)).toBeVisible();
    const recorded = (await history()).find(
      (entry) => entry.title.kind === kind,
    );
    expect(recorded?.title.name).toBe(title);
    if (kind === "movie") {
      movieEntry = recorded;
      expect(movieEntry.position).toBeGreaterThanOrEqual(15);
      await expect(
        page.getByRole("button", { name: `Resume ${title}`, exact: true }),
      ).toBeVisible();
    }
    report.interactions.push(
      `Actual ${label} playback appears in Recently played.`,
    );
  }

  await page.reload();
  expect((await history()).length).toBe(3);
  await expect(
    page.getByRole("button", {
      name: `Resume ${movieEntry.title.name}`,
      exact: true,
    }),
  ).toBeVisible();
  const startsBeforeResume = report.sessionStarts.length;
  await page
    .getByRole("button", {
      name: `Resume ${movieEntry.title.name}`,
      exact: true,
    })
    .click();
  await decoded("movie", movieEntry.title.name, "resume");
  const resumeRequest = report.sessionStarts[startsBeforeResume];
  expect(resumeRequest.itemId).toBe(movieEntry.item.id);
  expect(resumeRequest.start).toBeGreaterThan(0);
  await stop();
  await dashboard();
  report.interactions.push(
    "Reload preserved movie progress; Resume posted a nonzero source offset and decoded real video.",
  );

  let watchedSeries = await recordCompletion();
  const next = await providerNextEpisode(watchedSeries);
  const nextLabel = `Play ${watchedSeries.title.name} S${next.season || 1}${next.episode ? ` · E${next.episode}` : ""}: ${next.name}`;
  const upNext = page.getByRole("complementary", {
    name: "Up next",
    exact: true,
  });
  await expect(
    upNext.getByRole("button", { name: nextLabel, exact: true }),
  ).toBeVisible();
  await upNext.getByRole("button", { name: nextLabel, exact: true }).click();
  await decoded("series", watchedSeries.title.name, "up next");
  expect(report.sessionStarts.at(-1).itemId).toBe(next.id);
  await stop();
  await dashboard();
  watchedSeries = await recordCompletion();
  report.interactions.push(
    "Up next resolved the next real provider episode and played it successfully; completion flags were seeded for this review.",
  );

  const startsBeforeDetails = report.sessionStarts.length;
  await recentCard(watchedSeries.title.name).click();
  await expect(page.locator(".episode-row.selected strong")).toHaveText(
    watchedSeries.item.name,
    { timeout: 90000 },
  );
  await expect(
    page.getByRole("combobox", { name: "Season", exact: true }),
  ).toHaveText(`Season ${watchedSeries.item.season || 1}`);
  await expect(page.locator("video")).toHaveCount(0);
  expect(report.sessionStarts.length).toBe(startsBeforeDetails);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  report.interactions.push(
    "Recently played reopened the watched series season and episode without allocating a stream; browser Back restored Dashboard.",
  );

  await discoveryIsUseful();
  await screenshot("desktop-recent.png");
  for (const width of [900, 821, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    expect(overflow).toBe(false);
    if (width <= 390) {
      const navigation = page.getByRole("navigation", {
        name: "Primary navigation",
        exact: true,
      });
      await expect(navigation).toBeVisible();
      for (const label of [
        "Dashboard",
        "Live TV",
        "Movies",
        "Series",
        "Settings",
      ]) {
        const button = navigation.getByRole("button", {
          name: label,
          exact: true,
        });
        await expect(button).toBeVisible();
        const bounds = await button.boundingBox();
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(40);
      }
    }
    report.viewportChecks.push({ width, horizontalOverflow: overflow });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("mobile-recent.png");
  report.interactions.push(
    "Verified 900/821/390/320px layouts and all five accessible mobile navigation buttons.",
  );
  await page
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  await page.reload();
  await personalSectionsAreEmpty();
  expect(await history()).toEqual([]);
  await discoveryIsUseful();
  report.interactions.push(
    "Clear history survived reload; personal sections disappeared while real provider discovery remained available.",
  );
  expect(report.errors).toEqual([]);
} catch (error) {
  report.failure = error.message;
  await screenshot("failure.png").catch(() => {});
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...responseTasks]);
  for (const id of sessionIds)
    await page.request
      .delete(`${target}/api/sessions/${encodeURIComponent(id)}`)
      .catch(() => {});
  await writeFile(
    new URL("review.json", directory),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
