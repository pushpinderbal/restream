import { chromium } from "@playwright/test";

const baseURL = process.argv[2];
if (!baseURL) throw new Error("Usage: bun tests/real-playback.mjs <baseURL>");

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--autoplay-policy=no-user-gesture-required"],
});

const page = await browser.newPage();
const browserErrors = [];
const sessionIds = new Set();
let seekCount = 0;
page.on("pageerror", (error) => {
  browserErrors.push(error.message);
  console.log("Browser error:", error.message);
});
page.on("request", (request) => {
  if (/\/api\/sessions\/[^/]+\/seek$/.test(request.url())) seekCount++;
});
page.on("response", async (response) => {
  if (
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/sessions" &&
    response.status() === 201
  ) {
    try {
      sessionIds.add((await response.json()).id);
    } catch {
      // Cleanup still happens through the player and heartbeat expiry.
    }
  }
});

const videoState = () => {
  const video = document.querySelector("video");
  return (
    video && {
      time: video.currentTime,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight,
      src: video.currentSrc,
    }
  );
};
const progressing = () => {
  const video = document.querySelector("video");
  return (
    video && !video.paused && video.currentTime > 0.5 && video.videoWidth > 0
  );
};

try {
  await page.goto(baseURL);
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
  await page.getByRole("button", { name: "Open Test movie" }).click();
  const play = page.getByRole("button", { name: "Play", exact: true });
  await play.waitFor({ timeout: 30000 });
  const started = Date.now();
  await play.click();
  await page
    .waitForFunction(progressing, undefined, { timeout: 15000 })
    .catch(async (error) => {
      console.log(
        "Video state:",
        JSON.stringify(await page.evaluate(videoState)),
      );
      console.log(
        "Player alerts:",
        await page.getByRole("alert").allTextContents(),
      );
      await page.screenshot({ path: "/tmp/restream-playback-debug.png" });
      throw error;
    });
  const decoded = await page.evaluate(videoState);
  console.log(
    `Decoded HLS ${decoded.width}x${decoded.height}; first progressing frame in ${Date.now() - started}ms`,
  );

  const persistentVideo = await page.locator("video").elementHandle();
  for (const section of ["Series", "Live TV", "Movies"]) {
    await page
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", { name: section, exact: true })
      .click();
    const state = await page.evaluate(videoState);
    if (
      !(await persistentVideo.evaluate(
        (element) => element === document.querySelector("video"),
      )) ||
      state.src !== decoded.src ||
      state.paused ||
      !state.width ||
      seekCount !== 0
    )
      throw new Error(
        `Switching to ${section} interrupted the decoding player`,
      );
  }
  await page.getByRole("button", { name: "Open Test movie" }).click();
  console.log("Library tabs preserve the same decoding player and HLS source");

  const area = page.locator(".playback-area");
  const controls = page.locator(".video-controls");
  await page.mouse.move(1, 1);
  await area.hover();
  await page.waitForTimeout(3100);
  if ((await controls.getAttribute("data-visible")) !== "false")
    throw new Error("Playing controls did not auto-hide");
  await area.hover({ position: { x: 30, y: 30 } });
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await page.mouse.move(100, 100);
  await page.waitForTimeout(3100);
  if ((await controls.getAttribute("data-visible")) !== "false")
    throw new Error("Fullscreen controls did not auto-hide");
  await page.mouse.move(200, 120);
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await area.hover({ position: { x: 40, y: 40 } });
  console.log(
    "Controls fade after inactivity, including fullscreen, and return on pointer activity",
  );

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("video")?.paused,
    undefined,
    {
      timeout: 5000,
    },
  );
  await page.waitForTimeout(1200);
  const sourceBeforeResume = (await page.evaluate(videoState)).src;
  await page.keyboard.press("m");
  if (!(await page.evaluate(() => document.querySelector("video")?.muted)))
    throw new Error("Mute shortcut failed");
  await page.keyboard.press("m");
  await page.keyboard.press("k");
  await page.waitForFunction(progressing, undefined, { timeout: 10000 });
  if (
    (await page.evaluate(videoState)).src !== sourceBeforeResume ||
    seekCount !== 0
  )
    throw new Error("Pause/resume unnecessarily restarted the stream");
  console.log("Pause/resume keeps the same HLS generation");

  await area.hover({ position: { x: 50, y: 40 } });
  await page.getByRole("button", { name: "Back 10 seconds" }).click();
  await page.waitForTimeout(500);
  if (seekCount !== 0) throw new Error("Buffered rewind restarted the stream");
  console.log("Buffered rewind seeks locally");

  await area.hover({ position: { x: 60, y: 40 } });
  await page.getByRole("button", { name: "Forward 10 seconds" }).click();
  await page.waitForTimeout(500);
  if (seekCount !== 0)
    throw new Error("Available forward seek restarted the stream");
  console.log("Available forward seek stays local");
  await page.screenshot({ path: "/tmp/restream-real-player.png" });
  const bounds = await page.locator(".timeline").boundingBox();
  if (!bounds) throw new Error("Timeline not visible");
  const seeksBefore = seekCount;
  const sourceBeforeSeek = (await page.evaluate(videoState)).src;
  const seekResponse = page.waitForResponse(
    (response) =>
      /\/api\/sessions\/[^/]+\/seek$/.test(response.url()) &&
      response.request().method() === "POST",
    { timeout: 5000 },
  );
  await page.mouse.click(
    bounds.x + bounds.width * 0.9,
    bounds.y + bounds.height / 2,
  );
  await seekResponse;
  if (seekCount <= seeksBefore)
    throw new Error("Timeline did not request a seek");
  await page.waitForFunction(
    (previous) => document.querySelector("video")?.currentSrc !== previous,
    sourceBeforeSeek,
    { timeout: 30000 },
  );
  await page.waitForFunction(progressing, undefined, { timeout: 30000 });
  const afterSeek = await page.evaluate(videoState);
  if (afterSeek.paused || afterSeek.width === 0)
    throw new Error("Playback did not resume after timeline seek");
  console.log("Timeline seek decoded new HLS generation");
  await page.setViewportSize({ width: 390, height: 844 });
  await area.hover({ position: { x: 70, y: 40 } });
  await page.screenshot({ path: "/tmp/restream-real-player-mobile.png" });
  if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390)
    throw new Error("Player overflows mobile viewport");

  const playingVideo = await page.locator("video").elementHandle();
  const sourceBeforeSearch = (await page.evaluate(videoState)).src;
  const itemBeforeSearch = new URL(page.url()).searchParams.get("item");
  const timeBeforeSettings = (await page.evaluate(videoState)).time;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  const beforeRefresh = await (
    await page.request.get(`${baseURL}/api/status`)
  ).json();
  const libraryRefreshed = page.waitForResponse(async (response) => {
    if (!response.url().endsWith("/api/status")) return false;
    const status = await response.json();
    return (
      status.libraryUpdatedAt !== beforeRefresh.libraryUpdatedAt &&
      !status.refreshing
    );
  });
  await page.getByRole("button", { name: "Refresh library" }).click();
  await libraryRefreshed;
  await page.getByRole("button", { name: "Refresh guide" }).click();
  await page.waitForFunction(
    (previous) => {
      const video = document.querySelector("video");
      return video && !video.paused && video.currentTime > previous + 0.3;
    },
    timeBeforeSettings,
    { timeout: 5000 },
  );
  if (
    !(await playingVideo.evaluate((element) => element.isConnected)) ||
    (await page.evaluate(videoState)).src !== sourceBeforeSearch
  )
    throw new Error(
      "Settings or background library/guide refresh restarted playback",
    );
  await page.getByRole("button", { name: "Movies", exact: true }).click();
  await area.waitFor({ state: "visible" });
  console.log(
    "Settings, library refresh, and guide refresh preserve the same decoding player",
  );
  await page
    .locator(".header-search")
    .getByRole("searchbox")
    .fill("No matching film");
  await page.getByText("No matches found", { exact: true }).waitFor();
  const filteredVideo = await page.evaluate(videoState);
  if (
    !(await playingVideo.evaluate((element) => element.isConnected)) ||
    filteredVideo.src !== sourceBeforeSearch ||
    filteredVideo.paused ||
    !filteredVideo.width
  )
    throw new Error("Search interrupted the playing HLS stream");
  if (new URL(page.url()).searchParams.get("item") !== itemBeforeSearch)
    throw new Error("Search dropped the selected title from the URL");
  if ((await page.locator('.media-card[aria-expanded="true"]').count()) !== 1)
    throw new Error("Filtered playing tile is unavailable to close");
  console.log(
    "Search preserves decoded playback and keeps the selected tile available to close",
  );

  await page.locator('.media-card[aria-expanded="true"]').click();
  await page.waitForFunction(
    async (url) =>
      (await (await fetch(`${url}/api/status`)).json()).activeStreams === 0,
    baseURL,
    { timeout: 10000 },
  );
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: "Live TV", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Test live", exact: true })
    .click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(progressing, undefined, { timeout: 15000 });
  const firstLiveSource = (await page.evaluate(videoState)).src;
  await page
    .getByRole("button", { name: "Open Test live two", exact: true })
    .click();
  await page.waitForFunction(
    (previous) => {
      const video = document.querySelector("video");
      return (
        video &&
        video.currentSrc !== previous &&
        !video.paused &&
        video.videoWidth > 0 &&
        video.currentTime > 0.5
      );
    },
    firstLiveSource,
    { timeout: 15000 },
  );
  const liveStatus = await (await fetch(`${baseURL}/api/status`)).json();
  if (liveStatus.activeStreams !== 1)
    throw new Error("Channel tune lost its single stream slot");
  console.log(
    "One-click live channel switch decodes the next channel with one stream slot",
  );
  await page.locator('.media-card[aria-expanded="true"]').click();
  await page.waitForFunction(
    async (url) =>
      (await (await fetch(`${url}/api/status`)).json()).activeStreams === 0,
    baseURL,
    { timeout: 10000 },
  );
  if (browserErrors.length) throw new Error(browserErrors.join("\n"));
  console.log("Leaving player released stream slot; no browser errors");
} finally {
  for (const id of sessionIds) {
    await fetch(`${baseURL}/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => {});
  }
  await browser.close();
}
