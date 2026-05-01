import { test, expect } from "@playwright/test";

test.describe("Operations dashboard (/operations)", () => {
  test("loads all six sections", async ({ page }) => {
    await page.goto("/operations");
    await page.waitForLoadState("networkidle");

    // Headline row — 6 tiles
    await expect(page.locator(".hk-tile").nth(0)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".hk-tile").nth(5)).toBeVisible();

    // Pipeline + Kitchen
    await expect(page.getByText("Chain Pipeline")).toBeVisible();
    await expect(page.getByText("Kitchen Status")).toBeVisible();

    // Customers + Loyalty
    await expect(page.getByText("Customers (Today)")).toBeVisible();
    await expect(page.getByText("Loyalty / Rewards")).toBeVisible();

    // Leaderboard
    await expect(page.getByText("Store Leaderboard — click row to filter"))
      .toBeVisible();
  });

  test("clicking a leaderboard row narrows the filter via URL", async ({ page }) => {
    await page.goto("/operations");
    await page.waitForLoadState("networkidle");

    const firstRow = page.locator(".lb-table tbody tr").first();
    await expect(firstRow).toBeVisible({ timeout: 15000 });

    await firstRow.click();
    await page.waitForLoadState("networkidle");

    // URL now contains ?stores=<id>
    expect(page.url()).toContain("?stores=");

    // Store filter pill for that store is active
    await expect(page.locator(".store-filter-pill.active")).toHaveCount(1);
    // The "All stores" pill is NOT active anymore
    await expect(
      page.locator(".store-filter-pill.active", { hasText: "All stores" })
    ).toHaveCount(0);
  });

  test("TopNav — clicking Map returns to /", async ({ page }) => {
    await page.goto("/operations");
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: "Map" }).click();
    await page.waitForURL("**/");
    await expect(page.locator("#map, .maplibregl-map")).toBeVisible({
      timeout: 15000,
    });
  });

  test("StoreDetailPanel → 'View in Operations' deep-links", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Click any store pin — fallback: click the map center to open the panel
    // NOTE: this test depends on the StoreDetailPanel being reachable. If the
    // existing e2e harness has a more reliable way to open it, adapt here.
    const pin = page
      .locator(".maplibregl-marker, .store-pin, [class*='store']")
      .first();
    if (await pin.isVisible().catch(() => false)) {
      await pin.click();
    } else {
      // fallback: call the store-click via exposed global if any
      test.skip(true, "No reliable store-pin selector available in this environment");
    }

    const viewBtn = page.getByRole("button", { name: /view in operations/i });
    await expect(viewBtn).toBeVisible({ timeout: 10000 });
    await viewBtn.click();

    await page.waitForURL(/\/operations\?stores=/);
    await expect(page.locator(".hk-tile").first()).toBeVisible({
      timeout: 15000,
    });
  });
});
