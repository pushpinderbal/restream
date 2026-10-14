import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const target = process.env.RESTREAM_PREVIEW_URL || "http://127.0.0.1:5180";
const directory = new URL("../../output/restored-ui-review/", import.meta.url);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const report = { target, errors, interactions: [], timings: {} };
try {
  await page.goto(target);
  await page
    .locator(".live-grid .media-card")
    .first()
    .waitFor({ timeout: 90000 });
  await expect(page.locator("canvas.galaxy-field")).toBeVisible();
  await expect(page.locator(".on-air-feature, .library-heading")).toHaveCount(
    0,
  );
  await page
    .locator(".media-card .artwork-reveal.is-revealed")
    .first()
    .waitFor({ timeout: 20000 });
  report.interactions.push(
    "Verified the original layout and background with provider logos",
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: new URL("desktop.png", directory).pathname });
  const tile = page.locator(".media-card").first();
  await tile.click();
  await page.getByRole("region", { name: "On this channel" }).waitFor();
  report.interactions.push(
    "Opened a channel and inspected its programme guide",
  );
  await page.waitForTimeout(600);
  await page.screenshot({
    path: new URL("channel-guide.png", directory).pathname,
  });
  await page.locator('.media-card[aria-expanded="true"]').click();
  await page.getByRole("searchbox", { name: "Search channels" }).fill("news");
  await page.waitForTimeout(400);
  report.interactions.push("Searched the live provider's channels");
  await page.getByRole("searchbox", { name: "Search channels" }).fill("");
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Series", exact: true })
    .click();
  if (process.env.RESTREAM_REVIEW_SERIES_SEARCH) {
    await page
      .getByRole("searchbox", { name: "Search titles" })
      .fill(process.env.RESTREAM_REVIEW_SERIES_SEARCH);
  }
  const seriesTile = process.env.RESTREAM_REVIEW_SERIES_TITLE
    ? page.getByRole("button", {
        name: `Open ${process.env.RESTREAM_REVIEW_SERIES_TITLE}`,
        exact: true,
      })
    : page.locator(".media-card").first();
  await seriesTile.waitFor({ timeout: 90000 });
  const started = Date.now();
  await seriesTile.click();
  await page.locator(".episode-row").first().waitFor({ timeout: 90000 });
  report.timings.initialEpisodeListMs = Date.now() - started;
  report.interactions.push(
    "Opened a real series and loaded its first season with episode names",
  );
  const selector = page.getByRole("combobox", { name: "Season" });
  await selector.click();
  const options = page.getByRole("option");
  if ((await options.count()) > 1) {
    const next = Date.now();
    await options.nth(1).click();
    await page.locator(".episode-row").first().waitFor({ timeout: 90000 });
    report.timings.secondSeasonMs = Date.now() - next;
    report.interactions.push("Switched seasons without fetching every season");
  } else await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.screenshot({ path: new URL("series.png", directory).pathname });
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Movies", exact: true })
    .click();
  await page.locator(".media-card").first().waitFor({ timeout: 90000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: new URL("movies.png", directory).pathname });
  report.interactions.push("Browsed real movies and their posters");
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Live TV", exact: true })
    .click();
  await page.locator(".live-grid .media-card").first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await page.screenshot({
    path: new URL("mobile.png", directory).pathname,
  });
  report.mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  if (report.mobileOverflow)
    throw new Error("Mobile page overflows the viewport");
  report.interactions.push("Checked mobile layout and persistent navigation");
  expect(errors).toEqual([]);
} catch (error) {
  report.failure = error.message;
  await page.waitForTimeout(600);
  await page.screenshot({
    path: new URL("failure.png", directory).pathname,
    fullPage: true,
  });
  process.exitCode = 1;
} finally {
  await writeFile(
    new URL("live-review.json", directory),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
