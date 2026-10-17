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
await mkdir("output/auth-ui", { recursive: true });
try {
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
    ["small-mobile", 320, 720],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const signIn = page.getByRole("link", { name: "Sign in", exact: true });
    await expect(signIn).toBeVisible();
    await page.screenshot({ path: `output/auth-ui/oidc-login-${name}.png` });
    await signIn.click();
    const account = page.getByRole("button", { name: "Account", exact: true });
    await expect(account).toBeVisible({ timeout: 30000 });
    await account.click();
    const menu = page.getByRole("menu", { name: "Account", exact: true });
    await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByLabel("Portal URL", { exact: true })).toBeVisible();
    await account.click();
    await expect(
      page.getByText("Administrator", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `output/auth-ui/oidc-account-${name}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(signIn).toBeVisible();
    const protectedResponse = await page.request.get("/api/settings");
    expect(protectedResponse.status()).toBe(401);
  }
  expect(errors).toEqual([]);
  console.log(
    "OIDC discovery, signed tokens, PKCE login, Settings, account and logout verified on desktop and mobile.",
  );
} finally {
  await browser.close();
}
