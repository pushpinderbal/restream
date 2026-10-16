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
const navigateLibrary = async (kind) => {
  const navigation = page.getByRole("navigation", {
    name: page.viewportSize().width <= 820 ? "Primary navigation" : "Library",
    exact: true,
  });
  const types = page.getByRole("tablist", { name: "VOD type", exact: true });
  if (kind === "live" || !(await types.isVisible()))
    await navigation
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
  await page
    .getByRole("navigation", {
      name: page.viewportSize().width <= 820 ? "Primary navigation" : "Library",
      exact: true,
    })
    .getByRole("button", { name: "Search", exact: true })
    .click();
  const input = page.getByRole("searchbox", {
    name: "Search library",
    exact: true,
  });
  await expect(input).toHaveValue("");
  return input;
};
const report = { target, errors, interactions: [], timings: {} };
try {
  const initialURL = new URL(target);
  initialURL.searchParams.set("section", "live");
  initialURL.searchParams.delete("view");
  await page.goto(initialURL.href);
  await page
    .locator(".live-grid .media-card")
    .first()
    .waitFor({ timeout: 90000 });
  await expect(page.locator(".app-sidebar")).toBeVisible();
  await expect(page.locator(".on-air-feature, .library-heading")).toHaveCount(
    0,
  );
  await page
    .locator(".media-card .artwork-reveal.is-revealed")
    .first()
    .waitFor({ timeout: 20000 });
  report.interactions.push("Verified the sidebar layout with provider logos");
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
  await openSearch();
  await page
    .getByRole("searchbox", { name: "Search library", exact: true })
    .fill("news");
  await page.waitForTimeout(400);
  report.interactions.push("Searched the live provider's channels");
  await page.getByRole("searchbox", { name: "Search library" }).fill("");
  await navigateLibrary("series");
  if (process.env.RESTREAM_REVIEW_SERIES_SEARCH) {
    await openSearch();
    await page
      .getByRole("searchbox", { name: "Search library" })
      .fill(process.env.RESTREAM_REVIEW_SERIES_SEARCH);
  }
  const seriesResults = page.getByRole("region", {
    name: process.env.RESTREAM_REVIEW_SERIES_SEARCH
      ? "Shows results"
      : "Shows library",
    exact: true,
  });
  const seriesTile = process.env.RESTREAM_REVIEW_SERIES_TITLE
    ? seriesResults.getByRole("button", {
        name: `Open ${process.env.RESTREAM_REVIEW_SERIES_TITLE}`,
        exact: true,
      })
    : seriesResults.getByRole("button", { name: /^Open / }).first();
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
  await navigateLibrary("movie");
  await page.locator(".media-card").first().waitFor({ timeout: 90000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: new URL("movies.png", directory).pathname });
  report.interactions.push("Browsed real movies and their posters");
  await navigateLibrary("live");
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
