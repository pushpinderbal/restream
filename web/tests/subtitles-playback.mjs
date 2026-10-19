import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkCaptionPlacement } from "./caption-placement.mjs";

const baseURL = process.argv[2];
const mode = process.argv[3] || "transcode";
if (!baseURL)
  throw new Error("Usage: bun tests/subtitles-playback.mjs <baseURL>");
const output = fileURLToPath(new URL("../../output/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--autoplay-policy=no-user-gesture-required"],
});

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const history = await (
      await context.request.get(`${baseURL}/api/watch-history`)
    ).json();
    await context.request.delete(`${baseURL}/api/watch-history`, {
      data: { scope: history.scope },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(baseURL);
    const navigation = page.getByRole("navigation", {
      name: width <= 820 ? "Primary navigation" : "Library",
      exact: true,
    });
    await navigation.getByRole("button", { name: "VOD", exact: true }).click();
    await page.getByRole("tab", { name: "Movies", exact: true }).click();
    await page
      .getByRole("button", { name: "Open Test movie", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Expanded title", exact: true })
      .getByRole("button", { name: /^(Play|Resume)$/, exact: true })
      .click();
    const video = page.locator("video");
    await expect
      .poll(() => video.evaluate((v) => v.videoWidth > 0 && v.currentTime > 0))
      .toBe(true);
    await video.evaluate((v) => {
      window.subtitleTestVideo = v;
      v.pause();
    });
    const cc = page.getByRole("button", { name: "Subtitles", exact: true });
    await cc.click();
    const menu = page.getByRole("menu", { name: "Subtitles", exact: true });
    await expect(
      menu.getByRole("menuitemradio", { name: "Off", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await menu
      .getByRole("menuitemradio", { name: "English", exact: true })
      .click();
    const caption = () =>
      video.evaluate((v) =>
        Array.from(v.textTracks)
          .flatMap((track) =>
            track.mode === "showing"
              ? Array.from(track.activeCues || []).map((cue) => cue.text)
              : [],
          )
          .join("\n"),
      );
    const expectCaption = async (text) => {
      try {
        await expect.poll(caption).toContain(text);
      } catch (error) {
        console.log(
          "Subtitle diagnostic:",
          await video.evaluate((v) => ({
            time: v.currentTime,
            ready: v.readyState,
            paused: v.paused,
            tracks: Array.from(v.textTracks).map((t) => ({
              mode: t.mode,
              cues: Array.from(t.cues || []).map((c) => ({
                start: c.startTime,
                end: c.endTime,
                text: c.text,
              })),
            })),
          })),
        );
        throw error;
      }
    };
    await expectCaption("Provider subtitle fixture");
    await checkCaptionPlacement(page, video, { kind: "provider", mode, width });
    await cc.click();
    await expect(
      menu.getByRole("menuitemradio", { name: "English", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await page.screenshot({
      path: `${output}/subtitles-${width}.png`,
      fullPage: true,
    });
    let failSpanish = true;
    await page.route("**/subtitles-1.json?*", (route) =>
      failSpanish
        ? route.fulfill({
            status: 502,
            body: "Provider subtitles temporarily unavailable",
          })
        : route.continue(),
    );
    await menu
      .getByRole("menuitemradio", { name: "Spanish", exact: true })
      .click();
    await cc.click();
    await expect(
      menu.getByText("Subtitles temporarily unavailable", { exact: true }),
    ).toBeVisible();
    failSpanish = false;
    await menu
      .getByRole("menuitem", { name: "Try again", exact: true })
      .click();
    await expect.poll(caption).toContain("Subtítulos del proveedor");
    await expect.poll(() => video.evaluate((v) => v.textTracks.length)).toBe(1);
    await cc.click();
    await menu.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect.poll(caption).toBe("");
    await cc.click();
    await menu
      .getByRole("menuitemradio", { name: "English", exact: true })
      .click();
    await expect.poll(caption).toContain("Provider subtitle fixture");

    // Seek past the local buffer: the server creates a new video generation.
    const timeline = page.locator(".timeline");
    const bounds = await timeline.boundingBox();
    const oldSource = await video.evaluate((v) => v.currentSrc);
    const seek = page.waitForResponse(
      (response) =>
        response.url().endsWith("/seek") &&
        response.request().method() === "POST",
    );
    await timeline.click({
      position: { x: bounds.width * 0.7, y: bounds.height / 2 },
    });
    const next = await (await seek).json();
    expect(next.offset).toBeGreaterThan(30);
    let subtitleOffset = next.offset;
    if (mode === "copy") {
      await expect
        .poll(async () => {
          const current = await (
            await context.request.get(`${baseURL}/api/sessions/${next.id}`)
          ).json();
          subtitleOffset = current.subtitleOffset;
          return subtitleOffset;
        })
        .not.toBeUndefined();
      expect(subtitleOffset).toBeLessThan(next.offset - 1);
    }
    await expect
      .poll(() =>
        video.evaluate(
          (v, old) => v.currentSrc !== old && v.readyState >= 2,
          oldSource,
        ),
      )
      .toBe(true);
    await video.evaluate(async (v) => {
      await v.play();
    });
    await expect
      .poll(() => video.evaluate((v) => v.currentTime > 0))
      .toBe(true);
    await video.evaluate((v) => v.pause());
    await expectCaption("Provider subtitle fixture");
    const state = await video.evaluate((v) => ({
      sameVideo: v === window.subtitleTestVideo,
      trackCount: v.textTracks.length,
      cueStart: v.textTracks[0].cues[0].startTime,
      cueEnd: v.textTracks[0].cues[0].endTime,
    }));
    expect(state.sameVideo).toBe(true);
    expect(state.trackCount).toBe(1);
    expect(state.cueStart).toBe(0);
    expect(state.cueEnd).toBeCloseTo(60 - subtitleOffset, 1);
    if (width === 1440) {
      await page
        .getByRole("button", { name: "Full screen", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => !!document.fullscreenElement))
        .toBe(true);
      await cc.click();
      await expect(menu).toBeVisible();
      expect(
        await menu.evaluate((node) =>
          document.fullscreenElement.contains(node),
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Exit full screen", exact: true })
        .click();
    }
    const positions = await page
      .getByRole("button", { name: "Full screen", exact: true })
      .boundingBox();
    const videoBounds = await video.boundingBox();
    expect(positions.x + positions.width).toBeLessThanOrEqual(
      videoBounds.x + videoBounds.width,
    );
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(video).toHaveCount(0);
    if (width === 1440) {
      await navigation
        .getByRole("button", { name: "Home", exact: true })
        .click();
      const resumed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/sessions" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("region", { name: "Continue watching", exact: true })
        .getByRole("button", { name: "Resume Test movie", exact: true })
        .click();
      expect((await (await resumed).json()).offset).toBeGreaterThan(30);
      await expect
        .poll(() =>
          video.evaluate((v) => v.videoWidth > 0 && v.currentTime > 0),
        )
        .toBe(true);
      await expectCaption("Provider subtitle fixture");
      await expect(cc).toHaveAttribute("data-active", "true");
      await page
        .getByRole("button", { name: "Stop playback", exact: true })
        .click();
      await expect(video).toHaveCount(0);
    }
    expect(errors).toEqual([]);
    await context.close();
    console.log(
      `Provider subtitles (${mode}): selection, switching, Off, seek timing, cleanup, and ${width}px layout passed`,
    );
  }
} finally {
  await browser.close();
}
