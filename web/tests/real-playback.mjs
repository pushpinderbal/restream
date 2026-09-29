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
page.on("pageerror", (error) => browserErrors.push(error.message));
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
  await play.click();
  await page.waitForFunction(progressing, undefined, { timeout: 30000 });
  const decoded = await page.evaluate(videoState);
  console.log(`Decoded HLS ${decoded.width}x${decoded.height}`);

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
  await play.click();
  await page.waitForFunction(
    (previous) => document.querySelector("video")?.currentSrc !== previous,
    sourceBeforeResume,
    { timeout: 30000 },
  );
  await page.waitForFunction(progressing, undefined, { timeout: 30000 });
  if (!seekCount)
    throw new Error("Pause/resume did not request a new HLS generation");
  console.log("Pause/resume decoded new HLS generation");

  const timeline = page.getByRole("slider", { name: "Seek position" });
  const bounds = await timeline.boundingBox();
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
    bounds.x + bounds.width * 0.45,
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

  await page.getByRole("button", { name: "Close player" }).click();
  await page.waitForFunction(
    async (url) =>
      (await (await fetch(`${url}/api/status`)).json()).activeStreams === 0,
    baseURL,
    { timeout: 10000 },
  );
  if (browserErrors.length) throw new Error(browserErrors.join("\n"));
  console.log("Closing player released stream slot; no browser errors");
} finally {
  for (const id of sessionIds) {
    await fetch(`${baseURL}/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => {});
  }
  await browser.close();
}
