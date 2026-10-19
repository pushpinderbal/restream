import { chromium, expect } from "@playwright/test";
import { checkCaptionPlacement } from "./caption-placement.mjs";

const baseURL = process.argv[2];
const mode = process.argv[3];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--autoplay-policy=no-user-gesture-required"],
});

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const history = await (
      await context.request.get(`${baseURL}/api/watch-history`)
    ).json();
    await context.request.delete(`${baseURL}/api/watch-history`, {
      data: { scope: history.scope },
    });
    await context.addInitScript(() => {
      localStorage.setItem(
        "restream:subtitles",
        JSON.stringify({ language: "eng", label: "English" }),
      );
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/?view=player&section=movie&item=movie%3A4`);
    const video = page.locator("video");
    const cc = page.getByRole("button", { name: "Subtitles", exact: true });
    const menu = page.getByRole("menu", { name: "Subtitles", exact: true });
    const caption = () =>
      video.evaluate((v) =>
        Array.from(v.textTracks)
          .filter((track) => track.mode === "showing")
          .flatMap((track) =>
            Array.from(track.activeCues || []).map((cue) => cue.text),
          )
          .join("\n"),
      );
    const embeddedCaption = async () => {
      await expect
        .poll(caption, { timeout: 20_000 })
        .toContain("Embedded caption fixture");
      await video.evaluate((v) => v.pause());
      await expect
        .poll(() =>
          video.evaluate(
            (v) =>
              Array.from(v.textTracks).filter((t) => t.mode === "showing")
                .length,
          ),
        )
        .toBe(1);
    };
    await embeddedCaption();
    await checkCaptionPlacement(page, video, { kind: "embedded", mode, width });
    await cc.click();
    // Canonical English preference beats the Spanish provider SRT.
    await expect(
      menu.getByRole("menuitemradio", {
        name: "English (embedded)",
        exact: true,
      }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      menu.getByRole("menuitemradio", { name: "Spanish", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const originalSource = await video.evaluate((v) => v.currentSrc);
    await video.evaluate((v) => {
      v.currentTime = 4.2;
    });
    await expect.poll(caption).toContain("Embedded caption fixture");
    expect(await video.evaluate((v) => v.currentSrc)).toBe(originalSource);

    // A server seek has a fresh HLS timestamp origin. HLS.js aligns the embedded
    // cues directly to its decoded frames in both copy and transcode mode.
    const bounds = await page.locator(".timeline").boundingBox();
    await page.mouse.click(
      bounds.x + bounds.width * (42.2 / 64),
      bounds.y + bounds.height / 2,
    );
    await expect
      .poll(() => video.evaluate((v) => v.currentSrc), { timeout: 20_000 })
      .not.toBe(originalSource);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await embeddedCaption();
    await cc.click();
    await menu.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect.poll(caption).toBe("");
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("restream:subtitles")),
      ),
    ).toBeNull();
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(video).toHaveCount(0);

    // Provider English wins over embedded English. Its temporary failure falls
    // back without interrupting video, then an explicit retry restores it.
    await page.evaluate(() =>
      localStorage.setItem(
        "restream:subtitles",
        JSON.stringify({ language: "eng", label: "English" }),
      ),
    );
    await page.goto(`${baseURL}/?view=player&section=movie&item=movie%3A5`);
    await expect
      .poll(caption, { timeout: 20_000 })
      .toContain("Provider subtitle fixture");
    await cc.click();
    await expect(
      menu.getByRole("menuitemradio", { name: "English", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await video.evaluate((v) => v.pause());
    let failProvider = true;
    await page.route("**/subtitles-0.json?*", (route) =>
      failProvider
        ? route.fulfill({ status: 502, body: "Temporarily unavailable" })
        : route.continue(),
    );
    await cc.click();
    await menu
      .getByRole("menuitemradio", { name: "English", exact: true })
      .click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await embeddedCaption();
    await cc.click();
    await expect(
      menu.getByText("Subtitles temporarily unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitemradio", {
        name: "English (embedded)",
        exact: true,
      }),
    ).toHaveAttribute("aria-checked", "true");
    failProvider = false;
    await menu
      .getByRole("menuitem", { name: "Try again", exact: true })
      .click();
    await expect.poll(caption).toContain("Provider subtitle fixture");
    await cc.click();
    await menu.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect.poll(caption).toBe("");
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await expect(video).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
    console.log(
      `Embedded captions ${mode} at ${width}px: language fallback, local/server seeking, provider priority/retry, Off passed`,
    );
  }
} finally {
  await browser.close();
}
