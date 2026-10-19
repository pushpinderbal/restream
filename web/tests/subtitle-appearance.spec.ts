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

for (const width of [1440, 320]) {
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
