import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const baseURL = process.argv[2];
if (!baseURL) throw new Error("Expected the local OIDC test application URL");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
const page = await browser.newPage({ baseURL });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.emulateMedia({ reducedMotion: "reduce" });
const layouts = [
  ["desktop", 1440, 1000],
  ["mobile", 390, 844],
  ["small-mobile", 320, 720],
];
async function expectNoOverflow() {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function screenshot(name) {
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({ path: `output/auth-ui/${name}.png` });
}
if (process.env.CAPTURE_SCREENSHOTS)
  await mkdir("output/auth-ui", { recursive: true });
try {
  await page.goto("/");
  const signIn = page.getByRole("link", { name: "Sign in", exact: true });
  // Layout needs resizing, not another OIDC handshake for each viewport.
  for (const [name, width, height] of layouts) {
    await page.setViewportSize({ width, height });
    await expect(signIn).toBeVisible();
    await expectNoOverflow();
    await screenshot(`oidc-login-${name}`);
  }
  await signIn.click();
  const account = page.getByRole("button", { name: "Account", exact: true });
  await expect(account).toBeVisible({ timeout: 30000 });
  await account.click();
  const menu = page.getByRole("menu", { name: "Account", exact: true });
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByLabel("Portal URL", { exact: true })).toBeVisible();
  for (const [name, width, height] of layouts) {
    await page.setViewportSize({ width, height });
    await expect(account).toBeVisible();
    await account.click();
    await expect(
      menu.getByText("Administrator", { exact: true }),
    ).toBeVisible();
    await expectNoOverflow();
    await screenshot(`oidc-account-${name}`);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(account).toBeFocused();
  }
  await account.click();
  await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(signIn).toBeVisible();
  const protectedResponse = await page.request.get("/api/settings");
  expect(protectedResponse.status()).toBe(401);
  expect(errors).toEqual([]);
  console.log(
    "OIDC discovery, signed tokens, PKCE login, Settings, account and logout verified on desktop and mobile.",
  );
} finally {
  await browser.close();
}
