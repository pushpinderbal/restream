import { chromium, expect } from "@playwright/test";

const baseURL = process.argv[2];
const mode = process.argv[3];
const mobile = mode === "transcode";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({
  viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  hasTouch: mobile,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const video = page.locator("video");
const area = page.getByLabel("Video player", { exact: true });
const reveal = () => area.press("ArrowUp");
const progressing = () => {
  const element = document.querySelector("video");
  return (
    element &&
    !element.paused &&
    element.currentTime > 0.5 &&
    element.videoWidth > 0
  );
};
let session;
try {
  await page.goto(`${baseURL}/?section=movie`);
  await page
    .getByRole("button", { name: "Open Test movie", exact: true })
    .click();
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sessions" &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  session = await (await created).json();
  await page.waitForFunction(progressing, undefined, { timeout: 15000 });
  const originalSource = await video.evaluate((element) => element.currentSrc);
  await reveal();
  await page
    .getByRole("button", { name: "Playback speed: 1×", exact: true })
    .click();
  const changed = page.waitForResponse((response) =>
    response.url().endsWith("/speed"),
  );
  await page.getByRole("menuitemradio", { name: "2×", exact: true }).click();
  const response = await changed;
  expect(response.status()).toBe(200);
  const accelerated = await response.json();
  expect(accelerated.id).toBe(session.id);
  expect(accelerated.playbackRate).toBe(2);
  expect(accelerated.offset).toBeCloseTo(
    response.request().postDataJSON().position,
    2,
  );
  await expect(video).toHaveJSProperty("playbackRate", 2);
  await page.waitForFunction(progressing, undefined, { timeout: 15000 });
  const acceleratedSource = await video.evaluate(
    (element) => element.currentSrc,
  );
  expect(acceleratedSource).not.toBe(originalSource);
  const before = await video.evaluate((element) => ({
    time: element.currentTime,
    clock: performance.now(),
  }));
  await expect
    .poll(async () => video.evaluate((element) => element.currentTime), {
      timeout: 8000,
    })
    .toBeGreaterThan(before.time + 4);
  const after = await video.evaluate((element) => ({
    time: element.currentTime,
    clock: performance.now(),
  }));
  expect(
    (after.time - before.time) / ((after.clock - before.clock) / 1000),
  ).toBeGreaterThan(1.6);
  await expect
    .poll(
      () =>
        video.evaluate((element) =>
          element.buffered.length
            ? element.buffered.end(element.buffered.length - 1) -
              element.currentTime
            : 0,
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThan(35);
  expect(
    (await (await page.request.get(`${baseURL}/api/status`)).json())
      .activeStreams,
  ).toBe(1);

  await reveal();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page
    .getByRole("button", { name: "Playback speed: 2×", exact: true })
    .click();
  await page.screenshot({ path: `/tmp/restream-speed-${mode}.png` });
  const reset = page.waitForResponse((response) =>
    response.url().endsWith("/speed"),
  );
  await page
    .getByRole("menuitemradio", { name: "1× (Normal)", exact: true })
    .click();
  expect((await (await reset).json()).playbackRate).toBe(1);
  await expect(video).toHaveJSProperty("playbackRate", 1);
  await expect
    .poll(() => video.evaluate((element) => element.currentSrc))
    .not.toBe(acceleratedSource);
  await expect(video).toHaveJSProperty("paused", true);
  await reveal();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(progressing, undefined, { timeout: 15000 });
  const bounds = await page
    .getByRole("button", { name: "Playback speed: 1×", exact: true })
    .boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(
    page.viewportSize().width,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize().width);
  expect(errors).toEqual([]);
  console.log(
    `${mode}: ${mobile ? "mobile" : "desktop"} playback advances at 2×, returns to 1× while paused, and retains one stream slot`,
  );
} finally {
  if (session)
    await page.request.delete(`${baseURL}/api/sessions/${session.id}`);
  await browser.close();
}
