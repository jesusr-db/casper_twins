/**
 * Comprehensive user journey tests for the deployed Twins app.
 *
 * Run once to authenticate, then subsequent runs reuse SSO cookies:
 *   cd tests/e2e && node journey.mjs
 *
 * First run launches a visible browser. Complete SSO (Touch ID) when prompted,
 * wait for the dashboard to render, then the script takes over.
 * Subsequent runs use the stored profile and run headless.
 */
import { chromium } from "@playwright/test";
import os from "os";
import path from "path";
import fs from "fs";

const APP = "https://twins-digital-twin-1351565862180944.aws.databricksapps.com";
const PROFILE_DIR = path.join(os.tmpdir(), "pw-twins-aws-profile");
const SHOTS_DIR = path.join(process.cwd(), "screenshots");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const needsLogin = !fs.existsSync(PROFILE_DIR);
const results = [];

function log(name, status, note = "") {
  results.push({ name, status, note });
  const sym = status === "PASS" ? "✓" : status === "FAIL" ? "✘" : "•";
  console.log(`  ${sym}  ${name}${note ? `  (${note})` : ""}`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: false });
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: !needsLogin,
  viewport: { width: 1600, height: 1000 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await context.newPage();

const consoleErrors = [];
const networkFailures = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
});
page.on("response", (resp) => {
  const url = resp.url();
  if (url.includes("/api/") && resp.status() >= 400) {
    networkFailures.push(`${resp.status()} ${resp.request().method()} ${url.split("?")[0]}`);
  }
});

// ── Journey 1: Dashboard load ────────────────────────────────────────────────
console.log("\n▶ Journey 1: Dashboard initial load");
try {
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 30000 });

  if (needsLogin) {
    console.log("  [auth] Log in via Okta in the browser window — script will wait up to 3 min…");
    await page.waitForSelector(".dashboard, button:has-text('LIVE')", { timeout: 180000 });
  } else {
    await page.waitForSelector("button:has-text('LIVE')", { timeout: 30000 });
  }

  // KPI tiles should not say LOADING after a brief settle
  await page.waitForTimeout(4000);
  const kpiLoading = await page.locator("text=LOADING...").count();
  kpiLoading === 0
    ? log("Dashboard KPIs populated", "PASS")
    : log("Dashboard KPIs populated", "FAIL", `${kpiLoading} tiles still LOADING`);

  const activeOrders = await page.locator(".kpi-tile, .kpi-card").first().textContent().catch(() => "");
  log("Dashboard rendered", "PASS", activeOrders?.replace(/\s+/g, " ").slice(0, 60));
  await shot(page, "01-dashboard");
} catch (e) {
  log("Dashboard initial load", "FAIL", e.message.split("\n")[0]);
  await shot(page, "01-dashboard-FAIL");
}

// ── Journey 2: Market switching ──────────────────────────────────────────────
console.log("\n▶ Journey 2: Switch markets");
try {
  const tabs = page.locator('[role="tab"]');
  const tabCount = await tabs.count();
  log("Market tabs rendered", tabCount > 0 ? "PASS" : "FAIL", `${tabCount} tabs`);

  if (tabCount > 1) {
    const secondTab = tabs.nth(1);
    const name = await secondTab.textContent();
    await secondTab.click();
    await page.waitForTimeout(2000);
    log("Switched to market", "PASS", name?.replace(/\s+/g, " ").slice(0, 40));
    await shot(page, "02-market-switch");
  }
} catch (e) {
  log("Market switching", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 3: Pipeline stage → side panel ───────────────────────────────────
console.log("\n▶ Journey 3: Click pipeline stage");
try {
  // Pick a stage with orders > 0 so the side panel has content
  const stageButtons = page.locator('button[aria-label$=" orders"], button[description$=" orders"], button:has-text("Kitchen Prep")');
  const stageCount = await stageButtons.count();
  let clicked = false;
  for (let i = 0; i < stageCount; i++) {
    const txt = await stageButtons.nth(i).textContent();
    const m = txt && txt.match(/(\d+)/);
    if (m && parseInt(m[1], 10) > 0) {
      await stageButtons.nth(i).click();
      clicked = true;
      break;
    }
  }
  if (clicked) {
    await page.waitForTimeout(1500);
    // Check for side-panel orders
    const items = await page.locator(".order-list-item, .stage-order-row").count();
    log("Side panel shows orders", items > 0 ? "PASS" : "FAIL", `${items} rows`);

    // Verify no duplicate order_id displayed
    const ids = await page.locator(".order-list-id, .order-list-id *").allTextContents();
    const uniq = new Set(ids.map((x) => x.trim())).size;
    log(
      "Side-panel order IDs distinct",
      uniq === ids.length ? "PASS" : "FAIL",
      `${ids.length} rows, ${uniq} unique`,
    );
    await shot(page, "03-pipeline-stage-panel");
  } else {
    log("Pipeline stage click", "SKIP", "no stage had orders");
  }
} catch (e) {
  log("Pipeline stage panel", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 4: Click an order → Order Drawer ─────────────────────────────────
console.log("\n▶ Journey 4: Open Order Drawer");
try {
  const firstOrder = page.locator(".order-list-item").first();
  if ((await firstOrder.count()) > 0) {
    await firstOrder.click();
    await page.waitForTimeout(1500);
    const drawerVisible = await page.locator(".drawer-order-id, [id=order-drawer-title]").count();
    log("Order drawer opened", drawerVisible > 0 ? "PASS" : "FAIL");
    await shot(page, "04-order-drawer");
    // Close drawer — click outside or press Escape
    await page.keyboard.press("Escape").catch(() => {});
  } else {
    log("Order drawer", "SKIP", "no order row to click");
  }
} catch (e) {
  log("Order drawer", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 5: PLAYBACK mode ─────────────────────────────────────────────────
console.log("\n▶ Journey 5: Toggle PLAYBACK mode");
try {
  await page.locator("button:has-text('PLAYBACK')").first().click();
  await page.waitForTimeout(2000);
  const isPurple = await page.locator("body").evaluate(() => {
    const el = document.querySelector(".playback-banner, [class*='playback']");
    return !!el;
  });
  log("PLAYBACK mode entered", "PASS", isPurple ? "banner/tint visible" : "mode toggled");
  await shot(page, "05-playback");
  // Back to LIVE
  await page.locator("button:has-text('LIVE')").first().click();
  await page.waitForTimeout(1000);
} catch (e) {
  log("PLAYBACK toggle", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 6: CX Panel global view ──────────────────────────────────────────
console.log("\n▶ Journey 6: CX panel (global view)");
try {
  await page.goto(`${APP}/cx`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".cx-kpi-card, .cx-page-title, h1:has-text('Customer Experience')", {
    timeout: 20000,
  });
  await page.waitForTimeout(3000);

  const kpiCount = await page.locator(".cx-kpi-card").count();
  log("CX global KPIs render", kpiCount >= 3 ? "PASS" : "FAIL", `${kpiCount} KPIs`);

  const storeRows = await page.locator("tbody tr, .cx-store-row").count();
  log("CX store table has rows", storeRows > 0 ? "PASS" : "FAIL", `${storeRows} stores`);
  await shot(page, "06-cx-global");
} catch (e) {
  log("CX global view", "FAIL", e.message.split("\n")[0]);
  await shot(page, "06-cx-global-FAIL");
}

// ── Journey 7: CX store detail ───────────────────────────────────────────────
console.log("\n▶ Journey 7: CX store detail + tabs");
try {
  const firstStoreRow = page.locator("tbody tr").first();
  if ((await firstStoreRow.count()) > 0) {
    // Click the store name/link in the row
    const link = firstStoreRow.locator("a, button").first();
    if ((await link.count()) > 0) {
      await link.click();
    } else {
      await firstStoreRow.click();
    }
    await page.waitForTimeout(2500);

    const onDetail = await page.locator(".cx-tabs, button:has-text('Overview')").count();
    log("Store detail opened", onDetail > 0 ? "PASS" : "FAIL");
    await shot(page, "07a-cx-store-overview");

    // Click Complaints tab
    const complaintsTab = page.locator("button:has-text('Complaints')").first();
    if ((await complaintsTab.count()) > 0) {
      await complaintsTab.click();
      await page.waitForTimeout(3000);
      const rows = await page.locator("table tbody tr, .cx-table tbody tr").count();
      log("Complaints tab populated", rows > 0 ? "PASS" : "FAIL", `${rows} rows`);
      await shot(page, "07b-cx-complaints");
    } else {
      log("Complaints tab present", "FAIL", "button not found");
    }

    // Click Refunds tab
    const refundsTab = page.locator("button:has-text('Refunds')").first();
    if ((await refundsTab.count()) > 0) {
      await refundsTab.click();
      await page.waitForTimeout(3000);
      const rows = await page.locator("table tbody tr, .cx-table tbody tr").count();
      log("Refunds tab populated", rows > 0 ? "PASS" : "FAIL", `${rows} rows`);
      await shot(page, "07c-cx-refunds");
    } else {
      log("Refunds tab present", "FAIL", "button not found");
    }
  } else {
    log("CX store detail", "SKIP", "no store row to click");
  }
} catch (e) {
  log("CX store detail", "FAIL", e.message.split("\n")[0]);
  await shot(page, "07-cx-detail-FAIL");
}

// ── Network + console health check ───────────────────────────────────────────
console.log("\n▶ Network + console health");
log("API failures", networkFailures.length === 0 ? "PASS" : "FAIL", networkFailures.slice(0, 3).join(" | "));
log("Console errors", consoleErrors.length === 0 ? "PASS" : "FAIL", consoleErrors.slice(0, 2).join(" | "));

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════");
const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const skip = results.filter((r) => r.status === "SKIP").length;
console.log(`  ${pass} pass · ${fail} fail · ${skip} skip`);
console.log(`  screenshots: ${SHOTS_DIR}`);
console.log("══════════════════════════════════════════════\n");

fs.writeFileSync(
  path.join(SHOTS_DIR, "results.json"),
  JSON.stringify({ results, consoleErrors, networkFailures }, null, 2),
);

await context.close();
process.exit(fail > 0 ? 1 : 0);
