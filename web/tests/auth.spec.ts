import { expect, test, type Page, type Locator } from "@playwright/test";
import { createHistoryFixture } from "./watch-history-fixture";

type Auth = {
  mode: "none" | "oidc";
  user: null | { id: string; name: string; role: "admin" | "viewer" };
};
const viewer: Auth = {
  mode: "oidc",
  user: { id: "alice", name: "Alice", role: "viewer" },
};
const admin: Auth = {
  mode: "oidc",
  user: { id: "bob", name: "Bob", role: "admin" },
};
async function mock(page: Page, initial: Auth) {
  const history = createHistoryFixture();
  let auth = initial;
  let authGate: Promise<void> | undefined;
  let expired = false;
  let authChecks = 0;
  let logoutRequests = 0;
  const privateRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth") {
      authChecks++;
      if (authGate) await authGate;
      return route.fulfill({ json: auth });
    }
    privateRequests.push(url.pathname + url.search);
    if (await history.handle(route, auth.user?.id ?? "shared")) return;
    if (expired && url.pathname === "/api/browse")
      return route.fulfill({
        status: 401,
        json: { error: "Sign in required" },
      });
    const bodies: Record<string, unknown> = {
      "/api/settings": {
        providerEnvironment: [],
        provider: {
          portalUrl: "http://provider.example",
          mac: "00:11:22:33:44:55",
          timezone: "UTC",
          serialNumber: "",
          deviceId: "",
          deviceId2: "",
        },
        library: {
          refreshIntervalSeconds: 3600,
          dashboardCategories: [],
          blockedCategories: [],
          guideHours: 48,
        },
        discovery: { tmdbTokenConfigured: false },
        playback: { maxStreams: 2, transcodeMode: "auto" },
        updatedAt: "2026-10-17T12:00:00Z",
      },
      "/api/status": {
        configured: true,
        refreshing: false,
        catalogUpdatedAt: "2026-10-17T10:00:00Z",
        libraryUpdatedAt: "2026-10-17T10:05:00Z",
        epgUpdatedAt: "2026-10-17T10:10:00Z",
        preferencesUpdatedAt: "2026-10-17T09:00:00Z",
        library: {
          liveChannels: auth.user?.role === "viewer" ? 4 : 12,
          categories: auth.user?.role === "viewer" ? 2 : 6,
          cachedMovies: auth.user?.role === "viewer" ? 24 : 120,
          cachedSeries: auth.user?.role === "viewer" ? 6 : 30,
          programmes: auth.user?.role === "viewer" ? 20 : 80,
          guideStartsAt: "2026-10-17T00:00:00Z",
          guideEndsAt: "2026-10-19T00:00:00Z",
        },
        ...(auth.user?.role === "viewer"
          ? {}
          : {
              activeStreams: 0,
              maxStreams: 2,
              timezone: "UTC",
              guideHours: 48,
              playback: { transcodeMode: "auto", sessionTimeoutSeconds: 45 },
              sync: {
                catalog: {
                  running: false,
                  queued: false,
                  intervalSeconds: 3600,
                  nextRefreshAt: "2026-10-17T11:00:00Z",
                  lastSuccessfulAt: "2026-10-17T10:00:00Z",
                },
                epg: {
                  running: false,
                  queued: false,
                  intervalSeconds: 1800,
                  nextRefreshAt: "2026-10-17T10:40:00Z",
                  lastSuccessfulAt: "2026-10-17T10:10:00Z",
                },
              },
            }),
      },
      "/api/preferences": { refreshIntervalSeconds: 3600, categories: [] },
      "/api/categories": { categories: [] },
      "/api/catalog": { items: [] },
      "/api/epg": { programs: [] },
      "/api/browse": { items: [], page: 1, total: 0, hasMore: false },
      "/api/discovery": {
        configured: false,
        trendingMovies: [],
        trendingSeries: [],
        exploreMovies: [],
        exploreSeries: [],
      },
    };
    return route.fulfill({ json: bodies[url.pathname] || {} });
  });
  await page.route("**/auth/logout", async (route) => {
    logoutRequests++;
    expect(route.request().method()).toBe("POST");
    auth = { mode: "oidc", user: null };
    await route.fulfill({ status: 204 });
  });
  return {
    history,
    privateRequests,
    authChecks: () => authChecks,
    logoutRequests: () => logoutRequests,
    holdAuthChecks: (gate: Promise<void>) => {
      authGate = gate;
    },
    setAuth: (next: Auth) => {
      auth = next;
    },
    expire: () => {
      expired = true;
      auth = { mode: "oidc", user: null };
    },
  };
}

function account(page: Page) {
  return page
    .getByRole("button", { name: "Account", exact: true })
    .filter({ visible: true });
}
function accountMenu(page: Page) {
  return page.getByRole("menu", { name: "Account", exact: true });
}
async function openAccount(page: Page) {
  await account(page).click();
  await expect(accountMenu(page)).toBeVisible();
  return accountMenu(page);
}

async function reviewInteraction(page: Page, target: Locator, label: string) {
  if (!process.env.INTERACTION_REVIEW) return;
  await target.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../output/interaction-review/${label}.png` });
}

async function focusUnderline(target: Locator, pseudo = "::before") {
  return target.evaluate((element, selector) => {
    const style = getComputedStyle(element, selector);
    return (
      style.content !== "none" &&
      style.content !== "normal" &&
      style.display !== "none" &&
      Number(style.opacity) > 0 &&
      parseFloat(style.width) > 0 &&
      parseFloat(style.height) > 0
    );
  }, pseudo);
}

async function expectPointerFocus(page: Page, target: Locator) {
  await expect(page.locator("html")).toHaveAttribute(
    "data-input-modality",
    "pointer",
  );
  await expect(target).toHaveCSS("outline-style", "none");
  await expect(target).toHaveCSS("box-shadow", "none");
  await expect(target).not.toHaveCSS("text-decoration-line", /underline/);
  if (
    await target.evaluate((element) => element.classList.contains("focus-icon"))
  )
    await expect.poll(() => focusUnderline(target)).toBe(false);
}

async function expectKeyboardIcon(page: Page, target: Locator) {
  await expect(page.locator("html")).toHaveAttribute(
    "data-input-modality",
    "keyboard",
  );
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS("outline-style", "none");
  await expect(target).toHaveCSS("box-shadow", "none");
  await expect.poll(() => focusUnderline(target)).toBe(true);
}

async function openSettings(page: Page) {
  const menu = await openAccount(page);
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(menu).toHaveCount(0);
}

function navigation(page: Page) {
  return page.getByRole("navigation", { name: "Library", exact: true });
}

test("login gate prevents protected requests and reports callback errors", async ({
  page,
}) => {
  const state = await mock(page, { mode: "oidc", user: null });
  await page.goto("/?view=settings&auth_error=access_denied");
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }),
  ).toHaveAttribute("href", "/auth/login");
  await expect(page.getByRole("alert")).toContainText("does not have access");
  expect(state.privateRequests).toEqual([]);
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/auth-ui/login-desktop.png",
      fullPage: true,
    });
});

test("failed session check fails closed and supports retry", async ({
  page,
}) => {
  const state = await mock(page, { mode: "none", user: null });
  await page.route("**/api/auth", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Unable to check");
  expect(state.privateRequests).toEqual([]);
  await page.unroute("**/api/auth");
  // Restore the broad API handler after removing the exact temporary failure.
  await page.route("**/api/auth", (route) =>
    route.fulfill({ json: { mode: "none", user: null } }),
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(account(page)).toBeVisible();
});

for (const width of [1440, 320]) {
  test(`anonymous Account provides Settings without sign-out at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const state = await mock(page, { mode: "none", user: null });
    await page.goto("/");
    const nav =
      width <= 820
        ? page.getByRole("navigation", { name: "Primary navigation" })
        : navigation(page);
    await expect(nav.getByRole("button")).toHaveCount(5);
    await expect(
      nav.getByRole("button", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    const menu = await openAccount(page);
    await expect(menu.getByText("Anonymous", { exact: true })).toBeVisible();
    await expect(
      menu.getByText("No sign-in required", { exact: true }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveCount(1);
    await expect(
      menu.getByRole("menuitem", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /Sign(?:ing)? out/ }),
    ).toHaveCount(0);
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/auth-ui/anonymous-account-${width}.png`,
      });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(account(page)).toBeFocused();
    await expectKeyboardIcon(page, account(page));
    await reviewInteraction(
      page,
      account(page),
      `account-${width}-keyboard-escape`,
    );
    await openAccount(page);
    // A locator click waits for stability; raw mouse input can race Radix's
    // deferred outside-click listener when the menu has just mounted.
    await page.locator("html").click({
      position: { x: width - 8, y: 100 },
    });
    await expect(menu).toHaveCount(0);
    await expect(account(page)).toBeFocused();
    await expectPointerFocus(page, account(page));
    await reviewInteraction(
      page,
      account(page),
      `account-${width}-pointer-outside`,
    );
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expectKeyboardIcon(page, account(page));
    await reviewInteraction(
      page,
      account(page),
      `account-${width}-keyboard-tab`,
    );
    await account(page).press("ArrowDown");
    await expect(
      menu.getByRole("menuitem", { name: "Settings", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(account(page)).toBeFocused();
    await reviewInteraction(
      page,
      account(page),
      `account-${width}-keyboard-arrow-escape`,
    );
    await expectKeyboardIcon(page, account(page));
    await openSettings(page);
    await expectPointerFocus(page, account(page));
    await reviewInteraction(
      page,
      account(page),
      `account-${width}-pointer-settings`,
    );
    await expect(page.getByLabel("Portal URL", { exact: true })).toBeVisible();
    await expect(account(page)).toHaveAttribute("aria-current", "page");
    await expect(account(page)).toHaveClass(/active/);
    for (const section of ["Subtitles", "Status", "About"]) {
      if (width > 820)
        await page
          .getByRole("navigation", { name: "Settings sections", exact: true })
          .getByRole("link", { name: section, exact: true })
          .click();
      else {
        await page
          .getByRole("combobox", { name: "Jump to section", exact: true })
          .click();
        await page.getByRole("option", { name: section, exact: true }).click();
      }
      await expect(
        page.getByRole("heading", { name: section, exact: true }),
      ).toBeInViewport();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(state.logoutRequests()).toBe(0);
  });
}

const adminStatusLabels = [
  "Catalog refresh",
  "Guide refresh",
  "Next catalog refresh",
  "Next guide refresh",
  "Guide coverage",
  "Cached movies",
  "Cached shows",
  "Guide programmes",
  "Playback processing",
  "Playback idle timeout",
  "Streams",
  "Refresh interval",
];

test("viewer setup guidance protects every route and fits mobile widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mock(page, viewer);
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { configured: false, refreshing: false } }),
  );
  const notice = page.getByRole("status", {
    name: "Provider setup",
    exact: true,
  });
  async function expectViewerNotice() {
    await expect(notice).toHaveText(
      "Ask an administrator to connect your provider to start watching.",
    );
    await expect(notice.getByRole("button")).toHaveCount(0);
    await expect(
      page.getByText("Provider not configured", { exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  // The route authorization behavior is identical at every breakpoint.
  for (const [name, url] of [
    ["home", "/"],
    ["live", "/?section=live"],
    ["movies", "/?section=movie"],
    ["shows", "/?section=series"],
    ["search", "/?view=search&search=North"],
    ["player", "/?view=player&section=movie&item=movie-1"],
  ]) {
    await page.goto(url);
    await expectViewerNotice();
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/provider-setup/viewer-${name}-1440.png`,
      });
  }
  // The same notice is shared by all routes. Resize the mounted notice to
  // cover mobile wrapping without repeating six full app loads per width.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectViewerNotice();
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/provider-setup/viewer-player-${width}.png`,
      });
  }
  expect(
    state.privateRequests.some((path) => path.startsWith("/api/settings")),
  ).toBe(false);
});

for (const width of [1440, 320]) {
  test(`viewer can access Subtitles, Status, and About through Settings at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const state = await mock(page, viewer);
    await page.goto("/?view=settings");
    await expect(
      page.getByRole("heading", { name: "Status", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "About", exact: true }),
    ).toBeAttached();
    await expect(page.getByLabel("Portal URL", { exact: true })).toHaveCount(0);
    for (const label of ["Save changes", "Discard", "Refresh now"])
      await expect(
        page.getByRole("button", { name: label, exact: true }),
      ).toHaveCount(0);
    const status = page.locator("#settings-status");
    for (const label of adminStatusLabels)
      await expect(status.getByText(label, { exact: true })).toHaveCount(0);
    await expect(
      status
        .getByText("Live channels", { exact: true })
        .locator("..")
        .locator("dd"),
    ).toHaveText("4");
    await expect(
      status
        .getByText("Categories", { exact: true })
        .locator("..")
        .locator("dd"),
    ).toHaveText("2");
    const nav =
      width <= 820
        ? page.getByRole("navigation", { name: "Primary navigation" })
        : navigation(page);
    await expect(nav.getByRole("button", { name: "Settings" })).toHaveCount(0);
    await nav.getByRole("button", { name: "Home", exact: true }).click();
    const menu = await openAccount(page);
    await expect(menu.getByText("Alice", { exact: true })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(status).toBeVisible();
    if (width > 820) {
      const sections = page.getByRole("navigation", {
        name: "Settings sections",
        exact: true,
      });
      await expect(sections.getByRole("link")).toHaveText([
        "Subtitles",
        "Status",
        "About",
      ]);
      await sections.getByRole("link", { name: "About", exact: true }).click();
    } else {
      const jump = page.getByRole("combobox", {
        name: "Jump to section",
        exact: true,
      });
      await jump.click();
      await expect(page.getByRole("option")).toHaveText([
        "Subtitles",
        "Status",
        "About",
      ]);
      await page.getByRole("option", { name: "About", exact: true }).click();
    }
    await expect(page.locator("#settings-about")).toBeInViewport();
    if (width > 820)
      await page
        .getByRole("navigation", { name: "Settings sections", exact: true })
        .getByRole("link", { name: "Status", exact: true })
        .click();
    else {
      await page
        .getByRole("combobox", { name: "Jump to section", exact: true })
        .click();
      await page.getByRole("option", { name: "Status", exact: true }).click();
    }
    await expect(status).toBeInViewport();
    expect(
      state.privateRequests.some(
        (path) =>
          path.startsWith("/api/settings") ||
          path.includes("manage=1") ||
          path.startsWith("/api/refresh"),
      ),
    ).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/settings-design/status-viewer-${width}.png`,
        fullPage: false,
      });
    await openAccount(page);
    await accountMenu(page)
      .getByRole("menuitem", { name: "Sign out", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Alice", { exact: true })).toHaveCount(0);
  });
}

test("expired sessions remove the signed-in private app", async ({ page }) => {
  const state = await mock(page, admin);
  await page.goto("/");
  await expect(account(page)).toBeVisible();
  await expect(
    navigation(page).getByRole("button", { name: "Settings" }),
  ).toHaveCount(0);
  state.expire();
  await navigation(page)
    .getByRole("button", { name: "VOD", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(navigation(page)).toHaveCount(0);
});

test("server history is isolated by user and identity changes reload the account", async ({
  page,
}) => {
  const state = await mock(page, viewer);
  for (const [user, name] of [
    ["shared", "Anonymous movie"],
    ["alice", "Alice movie"],
    ["bob", "Bob movie"],
  ]) {
    const item = { id: name, name, kind: "movie", category: "Drama" };
    state.history.seed(
      [
        {
          title: item,
          item,
          watchedAt: Date.now(),
          position: 120,
          duration: 3600,
          completed: false,
        },
      ],
      user,
    );
  }
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Alice movie/ }).first(),
  ).toBeVisible();
  await expect(page.getByText("Anonymous movie", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Bob movie", { exact: true })).toHaveCount(0);
  // Rechecking an unchanged identity preserves component state and loaded data.
  await page
    .getByRole("button", { name: "Account", exact: true })
    .filter({ visible: true })
    .click();
  const before = state.authChecks();
  const preferenceLoads = state.privateRequests.filter(
    (path) => path === "/api/preferences",
  ).length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.authChecks()).toBeGreaterThan(before);
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  expect(
    state.privateRequests.filter((path) => path === "/api/preferences").length,
  ).toBe(preferenceLoads);
  state.setAuth(admin);
  // The session cookie can change before AuthGate finishes its delayed focus
  // recheck. An Alice-mounted client must not render Bob's history response.
  let releaseAuth!: () => void;
  state.holdAuthChecks(
    new Promise<void>((resolve) => {
      releaseAuth = resolve;
    }),
  );
  const switchedHistory = page.waitForResponse("**/api/watch-history");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await switchedHistory;
  await expect(page.getByText("Bob movie", { exact: true })).toHaveCount(0);
  releaseAuth();
  await expect(
    page.getByRole("button", { name: /Bob movie/ }).first(),
  ).toBeVisible();
  await expect(page.getByText("Alice movie", { exact: true })).toHaveCount(0);
});

test("permission loss rechecks the role while content denial keeps the current app", async ({
  page,
}) => {
  const state = await mock(page, admin);
  await page.goto("/");
  await expect(account(page)).toBeVisible();
  await page.route("**/api/browse?**", (route) =>
    route.fulfill({
      status: 403,
      json: { error: "Category blocked", code: "category_blocked" },
    }),
  );
  await navigation(page)
    .getByRole("button", { name: "VOD", exact: true })
    .click();
  await expect(
    page.getByText("Category blocked", { exact: true }),
  ).toBeVisible();
  await openAccount(page);
  await expect(
    accountMenu(page).getByRole("menuitem", { name: "Settings" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.route("**/api/settings", (route) => {
    state.setAuth(viewer);
    return route.fulfill({
      status: 403,
      json: { error: "Administrator required", code: "forbidden" },
    });
  });
  await openAccount(page);
  await accountMenu(page).getByRole("menuitem", { name: "Settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Status", exact: true }),
  ).toBeVisible();
  // Status is visible during the admin session too. Wait for the role recheck
  // to replace that app before testing the viewer's controls and Account menu.
  await expect(
    page
      .getByRole("navigation", { name: "Settings sections", exact: true })
      .getByRole("link"),
  ).toHaveText(["Subtitles", "Status", "About"]);
  await expect(page.getByLabel("Portal URL", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await openAccount(page);
  await expect(
    accountMenu(page).getByRole("menuitem", { name: "Settings" }),
  ).toBeVisible();
});

test("admin navigation fits 320px with accessible controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mock(page, admin);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav.getByRole("button")).toHaveCount(5);
  for (const button of await nav.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await nav.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByText("Bob", { exact: true })).toBeVisible();
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: "../output/auth-ui/account-admin-320.png",
      fullPage: true,
    });
});

test("auth works without BroadcastChannel and rechecks on focus", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { value: undefined });
  });
  const state = await mock(page, { mode: "none", user: null });
  await page.goto("/");
  await expect(account(page)).toBeVisible();
  state.setAuth({ mode: "oidc", user: null });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

for (const width of [1440, 320]) {
  test(`admin opens Settings from Account and menu closes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const state = await mock(page, admin);
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    const menu = await openAccount(page);
    await expect(menu.getByText("Bob", { exact: true })).toBeVisible();
    await expect(
      menu.getByText("Administrator", { exact: true }),
    ).toBeVisible();
    await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByLabel("Portal URL", { exact: true })).toBeVisible();
    await expect(account(page)).toHaveAttribute("aria-current", "page");
    await expect(account(page)).toHaveClass(/active/);
    if (width > 820)
      await page
        .getByRole("navigation", { name: "Settings sections", exact: true })
        .getByRole("link", { name: "Status", exact: true })
        .click();
    else {
      await page
        .getByRole("combobox", { name: "Jump to section", exact: true })
        .click();
      await page.getByRole("option", { name: "Status", exact: true }).click();
    }
    await expect(
      page.getByRole("heading", { name: "Status", exact: true }),
    ).toBeInViewport();
    if (width > 820)
      await expect(
        page
          .getByRole("navigation", { name: "Settings sections", exact: true })
          .getByRole("link", { name: "Status", exact: true }),
      ).toHaveAttribute("aria-current", "location");
    else
      await expect(
        page.getByRole("combobox", { name: "Jump to section", exact: true }),
      ).toContainText("Status");
    const status = page.locator("#settings-status");
    for (const label of adminStatusLabels)
      await expect(status.getByText(label, { exact: true })).toBeVisible();
    await expect(
      status
        .getByText("Cached movies", { exact: true })
        .locator("..")
        .locator("dd"),
    ).toHaveText("120");
    await expect(
      status
        .getByText("Cached shows", { exact: true })
        .locator("..")
        .locator("dd"),
    ).toHaveText("30");
    await expect(
      status.getByRole("button", { name: "Refresh now", exact: true }),
    ).toBeVisible();
    if (process.env.CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../output/settings-design/status-admin-${width}.png`,
        fullPage: false,
      });
    // A provider role downgrade removes an already mounted administrative form.
    state.setAuth({ mode: "oidc", user: { ...admin.user!, role: "viewer" } });
    const before = state.authChecks();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => state.authChecks()).toBeGreaterThan(before);
    await expect(page.getByLabel("Portal URL", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh now", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Status", exact: true }),
    ).toBeVisible();
    for (const label of adminStatusLabels)
      await expect(
        page.locator("#settings-status").getByText(label, { exact: true }),
      ).toHaveCount(0);

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("Account menu supports keyboard selection and Escape restores focus", async ({
  page,
}) => {
  await mock(page, admin);
  await page.goto("/");
  const trigger = account(page);
  await expect(trigger).toBeVisible();
  await page.keyboard.press("Tab");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const settings = accountMenu(page).getByRole("menuitem", {
    name: "Settings",
    exact: true,
  });
  const signOut = accountMenu(page).getByRole("menuitem", {
    name: "Sign out",
    exact: true,
  });
  await expect(settings).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(signOut).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(accountMenu(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(settings).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(accountMenu(page)).toHaveCount(0);
  await expect(page.getByLabel("Portal URL", { exact: true })).toBeVisible();
});

test("pending sign-out prevents duplicate requests and errors allow retry", async ({
  page,
}) => {
  await mock(page, viewer);
  let attempts = 0;
  let resolveFailure!: () => void;
  const pending = new Promise<void>((resolve) => {
    resolveFailure = resolve;
  });
  await page.route("**/auth/logout", async (route) => {
    attempts++;
    if (attempts === 1) {
      await pending;
      await route.fulfill({ status: 503, json: { error: "Try again" } });
    } else await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  const menu = await openAccount(page);
  await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  const signingOut = menu.getByRole("menuitem", {
    name: "Signing out…",
    exact: true,
  });
  await expect(menu).toBeVisible();
  await expect(signingOut).toBeDisabled();
  await expect.poll(() => attempts).toBe(1);
  // Keyboard and programmatic activation must both respect pending state.
  await page.keyboard.press("Enter");
  await signingOut.dispatchEvent("click");
  expect(attempts).toBe(1);
  resolveFailure();
  await expect(menu.getByRole("alert")).toContainText("Unable to sign out");
  await expect(menu).toBeVisible();
  const retry = menu.getByRole("menuitem", { name: "Sign out", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});
