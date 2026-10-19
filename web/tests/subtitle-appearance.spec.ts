import { expect, test, type Page } from "@playwright/test";

const preferenceKey = "restream:subtitle-appearance";

async function mockSettings(page: Page) {
  const mutations: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!["GET", "HEAD"].includes(route.request().method()))
      mutations.push(path);
    const responses: Record<string, unknown> = {
      "/api/auth": {
        mode: "oidc",
        user: { id: "viewer", name: "Alex", role: "viewer" },
      },
      "/api/status": {
        configured: true,
        refreshing: false,
        catalogUpdatedAt: "2026-10-18T12:00:00Z",
        library: {
          liveChannels: 0,
          categories: 0,
          programmes: 0,
          cachedMovies: 0,
          cachedSeries: 0,
        },
      },
      "/api/preferences": {
        categories: [],
        configuration: { dashboardCategories: [], blockedCategories: [] },
      },
      "/api/categories": { categories: [] },
      "/api/catalog": { items: [] },
      "/api/epg": { programs: [] },
      "/api/watch-history": {
        userId: "viewer",
        scope: "appearance-test",
        entries: [],
      },
      "/api/discovery": {
        configured: false,
        refreshing: false,
        trendingMovies: [],
        trendingSeries: [],
        exploreMovies: [],
        exploreSeries: [],
      },
    };
    return route.fulfill({
      contentType: "application/json",
      status: path in responses ? 200 : 404,
      body: JSON.stringify(responses[path] ?? { error: "Not found" }),
    });
  });
  return mutations;
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

for (const width of [1440, 390, 320]) {
  test(`viewer subtitle appearance is immediate, local, and persists at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mutations = await mockSettings(page);
    await page.goto("/?view=settings");
    const section = page.getByRole("region", {
      name: "Subtitles",
      exact: true,
    });
    await expect(section).toBeVisible();
    await expect(page.getByLabel("Portal URL", { exact: true })).toHaveCount(0);
    const preview = section.locator(".subtitle-preview-caption");
    await expect(preview).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(preview.locator("span").first()).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0.8)",
    );
    await expect(
      section.getByRole("button", { name: "Reset subtitle style" }),
    ).toBeDisabled();
    const initialSize = await preview.evaluate((element) =>
      parseFloat(getComputedStyle(element).fontSize),
    );
    await choose(page, "Font", "Serif");
    await choose(page, "Text size", "Large");
    await choose(page, "Text color", "Yellow");
    await choose(page, "Background", "None");
    await expect(preview).toHaveCSS("font-family", /Georgia/);
    await expect(preview).toHaveCSS("color", "rgb(255, 229, 107)");
    await expect(preview.locator("span").first()).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(preview).not.toHaveCSS("text-shadow", "none");
    expect(
      await preview.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBeCloseTo(initialSize * 1.25, 1);
    expect(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        preferenceKey,
      ),
    ).toEqual({
      font: "serif",
      size: "large",
      color: "yellow",
      background: "none",
    });
    await expect(
      page.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (process.env.CAPTURE_SCREENSHOTS && width !== 320)
      await page.screenshot({
        path: `../output/subtitle-settings-${width}.png`,
        fullPage: true,
      });
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Font", exact: true }),
    ).toContainText("Serif");
    await expect(preview).toHaveCSS("color", "rgb(255, 229, 107)");
    await section.getByRole("button", { name: "Reset subtitle style" }).click();
    await expect(preview).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(
      page.getByRole("combobox", { name: "Text size", exact: true }),
    ).toContainText("Medium");
    expect(
      await page.evaluate((key) => localStorage.getItem(key), preferenceKey),
    ).toBeNull();
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("subtitle appearance synchronizes across tabs, including changes made while Settings is closed", async ({
  page,
  context,
}) => {
  await mockSettings(page);
  await page.goto("/?view=settings");
  const other = await context.newPage();
  await mockSettings(other);
  await other.goto("/?view=settings");
  await choose(page, "Text color", "Cyan");
  await expect(
    other.getByRole("combobox", { name: "Text color", exact: true }),
  ).toContainText("Cyan");
  await other.getByRole("button", { name: "Reset subtitle style" }).click();
  await expect(
    page.getByRole("combobox", { name: "Text color", exact: true }),
  ).toContainText("White");

  // Unmount settings without reloading the application/module store.
  await other
    .getByRole("navigation", { name: "Library", exact: true })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await expect(
    other.getByRole("combobox", { name: "Text color", exact: true }),
  ).toHaveCount(0);
  await choose(page, "Text color", "Yellow");
  await other
    .getByRole("button", { name: "Account", exact: true })
    .filter({ visible: true })
    .click();
  await other.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    other.getByRole("combobox", { name: "Text color", exact: true }),
  ).toContainText("Yellow");
});

test("subtitle appearance remains usable when browser storage is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
  });
  await mockSettings(page);
  await page.goto("/?view=settings");
  const preview = page.locator(".subtitle-preview-caption");
  await expect(page.getByText(/Browser storage is unavailable/)).toBeVisible();
  await choose(page, "Text color", "Cyan");
  await expect(preview).toHaveCSS("color", "rgb(128, 237, 255)");
  await page
    .getByRole("navigation", { name: "Library", exact: true })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Account", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(preview).toHaveCSS("color", "rgb(128, 237, 255)");
  await page.getByRole("button", { name: "Reset subtitle style" }).click();
  await expect(preview).toHaveCSS("color", "rgb(255, 255, 255)");
});

test("invalid stored subtitle preferences fall back to safe defaults", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        font: "serif",
        size: 500,
        color: "url(untrusted)",
        background: null,
      }),
    );
  }, preferenceKey);
  await mockSettings(page);
  await page.goto("/?view=settings");
  await expect(
    page.getByRole("combobox", { name: "Font", exact: true }),
  ).toContainText("Serif");
  await expect(
    page.getByRole("combobox", { name: "Text size", exact: true }),
  ).toContainText("Medium");
  await expect(page.locator(".subtitle-preview-caption")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
});

test("native video cues use the same selected colors and fonts as the preview", async ({
  page,
}, testInfo) => {
  await mockSettings(page);
  await page.goto("/?view=settings");
  await choose(page, "Font", "Monospace");
  await choose(page, "Text color", "Cyan");
  await choose(page, "Background", "Solid black");
  // A real MediaStream exercises Chromium's native cue renderer without a
  // provider or an encoded fixture. The canvas only supplies the video frame.
  await page.evaluate(async () => {
    const preview = document.querySelector<HTMLElement>(
      ".subtitle-appearance-preview",
    )!;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#516d79";
    context.fillRect(0, 0, 640, 360);
    const wrapper = document.createElement("div");
    wrapper.className = "video-wrap";
    wrapper.dataset.nativeAppearance = "";
    wrapper.style.cssText = `${preview.style.cssText}; position: fixed; z-index: 100; inset: 10px auto auto 10px; width: 640px; height: 360px; background: #516d79;`;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = canvas.captureStream(1);
    video.style.cssText = "width: 100%; height: 100%;";
    wrapper.append(video);
    document.body.append(wrapper);
    const track = video.addTextTrack("subtitles", "Native style preview", "en");
    track.addCue(
      new VTTCue(0, 3600, "The coast is clear.\nLet’s see what comes next."),
    );
    track.mode = "showing";
    await video.play();
  });
  const native = page.locator("[data-native-appearance]");
  await expect
    .poll(() =>
      native
        .locator("video")
        .evaluate((video) => video.textTracks[0].activeCues?.length),
    )
    .toBe(1);
  await native.screenshot({
    path: process.env.CAPTURE_SCREENSHOTS
      ? "../output/subtitle-native-cyan.png"
      : testInfo.outputPath("native-subtitle-cyan-monospace.png"),
  });
  await expect(page.locator(".subtitle-preview-caption")).toHaveCSS(
    "font-family",
    /Courier New/,
  );
  await expect(page.locator(".subtitle-preview-caption")).toHaveCSS(
    "color",
    "rgb(128, 237, 255)",
  );
});
