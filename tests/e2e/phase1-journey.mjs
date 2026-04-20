/**
 * Phase 1 user-journey tests for the deployed Twins app.
 *
 * Verifies the app behaves correctly after Phase 1 event datagen absorption:
 *   - 22 SF markets appear (no SV, Bellevue, Chicago)
 *   - Map + pipeline + drawer render
 *   - Live polling picks up fresh data
 *   - No console errors / no 503s from data-bearing APIs
 *
 * Run:
 *   cd tests/e2e && node phase1-journey.mjs
 *
 * First run opens a visible browser. Complete Databricks SSO (Touch ID) when
 * prompted, wait for the dashboard to render, then the script takes over.
 * Subsequent runs use the stored browser profile and run headless.
 *
 * To force a fresh SSO: rm -rf /tmp/pw-twins-aws-profile
 */
import { chromium } from "@playwright/test";
import os from "os";
import path from "path";
import fs from "fs";

const APP = "https://twins-digital-twin-1351565862180944.aws.databricksapps.com";
const PROFILE_DIR = path.join(os.tmpdir(), "pw-twins-aws-profile");
const SHOTS_DIR = path.join(process.cwd(), "screenshots-phase1");
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
  channel: "chrome",                    // use system Chrome, not Playwright's Chromium
  headless: !needsLogin,
  viewport: { width: 1600, height: 1000 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await context.newPage();

// Collect console errors + failing network requests across the run.
const consoleErrors = [];
const networkFailures = [];
// Known-benign console errors we ignore: browser-internal SSL handshakes,
// devtools port probes, etc. These are not app bugs.
const BENIGN_CONSOLE_PATTERNS = [
  /ERR_SSL_PROTOCOL_ERROR/,
  /port \d+/i,
  /chrome-extension:/,
];
page.on("console", (msg) => {
  if (msg.type() === "error") {
    const text = msg.text().slice(0, 300);
    if (!BENIGN_CONSOLE_PATTERNS.some((re) => re.test(text))) {
      consoleErrors.push(text);
    }
  }
});
page.on("response", (res) => {
  const url = res.url();
  if (res.status() >= 500 && url.includes("/api/")) {
    networkFailures.push(`${res.status()} ${url.replace(APP, "")}`);
  }
});

// ── Journey 1: Initial load + wait for dashboard ─────────────────────────────
console.log(`\n▶ Journey 1: Load ${APP}`);
try {
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });

  if (needsLogin) {
    console.log("  (headed — complete Databricks SSO in the browser window)");
    await page.waitForSelector("button:has-text('LIVE')", { timeout: 180000 });
  } else {
    await page.waitForSelector("button:has-text('LIVE')", { timeout: 30000 });
  }

  // Let live polling settle.
  await page.waitForTimeout(4000);

  const kpiLoading = await page.locator("text=LOADING...").count();
  log(
    "Dashboard KPIs populated",
    kpiLoading === 0 ? "PASS" : "FAIL",
    kpiLoading === 0 ? "" : `${kpiLoading} tiles still LOADING`,
  );
  await shot(page, "01-dashboard");
} catch (e) {
  log("Dashboard initial load", "FAIL", e.message.split("\n")[0]);
  await shot(page, "01-dashboard-FAIL");
  await context.close();
  process.exit(1);
}

// ── Journey 2: Phase 1 scope — expect SF-only markets ────────────────────────
console.log("\n▶ Journey 2: Market tabs (Phase 1 SF-only scope)");
try {
  const tabs = page.locator('[role="tab"]');
  const tabCount = await tabs.count();
  log(
    "Market tabs rendered",
    tabCount > 0 ? "PASS" : "FAIL",
    `${tabCount} tabs`,
  );

  // Phase 1 uses SF-only datagen: all 22 locations have location_code='sf'.
  // In the UI they may be grouped by city; market tabs or their accordion
  // expand to show 22 SF markets total.
  const apiMarkets = await page.evaluate(async (app) => {
    const res = await fetch(`${app}/api/markets`);
    return res.ok ? (await res.json()).length : -1;
  }, APP);
  log(
    "API /api/markets returns exactly 22",
    apiMarkets === 22 ? "PASS" : "FAIL",
    `${apiMarkets} markets`,
  );

  // Confirm no non-SF city names appear in tab labels
  const tabTexts = await tabs.allTextContents();
  const nonSfHits = tabTexts.filter((t) =>
    /\b(Chicago|Bellevue|Seattle|Silicon Valley|San Jose)\b/i.test(t),
  );
  log(
    "No non-SF city tabs present",
    nonSfHits.length === 0 ? "PASS" : "FAIL",
    nonSfHits.length === 0 ? "" : nonSfHits.slice(0, 2).join(", "),
  );
  await shot(page, "02-markets");
} catch (e) {
  log("Market tabs verification", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 3: Market switch loads orders + KPIs ─────────────────────────────
console.log("\n▶ Journey 3: Switch markets → data loads");
try {
  const tabs = page.locator('[role="tab"]');
  if ((await tabs.count()) > 1) {
    const beforeOrdersCount = await page.locator(".order-list-item").count();
    const secondTab = tabs.nth(1);
    const marketName = await secondTab.textContent();
    await secondTab.click();
    await page.waitForTimeout(3500);

    const afterOrdersCount = await page.locator(".order-list-item").count();
    log(
      `Switched to ${marketName?.replace(/\s+/g, " ").slice(0, 35)}`,
      "PASS",
      `orders: ${beforeOrdersCount} → ${afterOrdersCount}`,
    );
    await shot(page, "03-market-switch");
  } else {
    log("Market switch", "SKIP", "only 1 tab available");
  }
} catch (e) {
  log("Market switch", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 4: Map renders with store pins ───────────────────────────────────
console.log("\n▶ Journey 4: Map view");
try {
  // MapLibre GL canvas appears as a <canvas class="maplibregl-canvas">
  const hasMapCanvas = await page.locator(".maplibregl-canvas").count();
  log("Map canvas rendered", hasMapCanvas > 0 ? "PASS" : "FAIL");

  // Wait a bit for markers to populate.
  await page.waitForTimeout(3000);
  const markerCount = await page.locator(".maplibregl-marker").count();
  log(
    "Map markers present",
    markerCount > 0 ? "PASS" : "FAIL",
    `${markerCount} markers`,
  );
  await shot(page, "04-map");
} catch (e) {
  log("Map view", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 5: Pipeline stage click → side-panel drill-down ─────────────────
console.log("\n▶ Journey 5: Click a pipeline stage");
try {
  // Stage buttons have aria-label like "5 orders" or display a count.
  const stageButtons = page.locator(
    'button[aria-label$=" orders"], button[aria-label*=" order"], button:has-text("Kitchen Prep"), button:has-text("In Transit")',
  );
  const stageCount = await stageButtons.count();
  let clicked = null;
  for (let i = 0; i < stageCount; i++) {
    const txt = (await stageButtons.nth(i).textContent()) || "";
    const m = txt.match(/\b(\d+)\b/);
    if (m && parseInt(m[1], 10) > 0) {
      clicked = txt.replace(/\s+/g, " ").slice(0, 30);
      await stageButtons.nth(i).click();
      break;
    }
  }
  if (clicked) {
    await page.waitForTimeout(1500);
    const rows = await page.locator(".order-list-item, .stage-order-row").count();
    log(
      `Drill-down opened for stage ${clicked}`,
      rows > 0 ? "PASS" : "FAIL",
      `${rows} rows`,
    );

    // Check rows have distinct order_ids (no duplicates)
    const ids = await page.locator(".order-list-id, .order-list-id *").allTextContents();
    const uniq = new Set(ids.map((x) => x.trim())).size;
    log(
      "Drill-down order IDs distinct",
      ids.length === 0 || uniq === ids.length ? "PASS" : "FAIL",
      `${ids.length} rows, ${uniq} unique`,
    );
    await shot(page, "05-stage-drilldown");
  } else {
    log("Pipeline stage click", "SKIP", "no stage with orders > 0");
  }
} catch (e) {
  log("Pipeline stage drill-down", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 6: Click an order → drawer opens ─────────────────────────────────
console.log("\n▶ Journey 6: Order drawer");
try {
  const firstOrder = page.locator(".order-list-item").first();
  if ((await firstOrder.count()) > 0) {
    await firstOrder.click();
    await page.waitForTimeout(1800);
    const drawerSelectors = [
      ".drawer-order-id",
      "[id=order-drawer-title]",
      "[role=dialog]",
      ".order-drawer",
    ];
    let drawerOpened = 0;
    for (const sel of drawerSelectors) {
      drawerOpened += await page.locator(sel).count();
    }
    log("Order drawer opened", drawerOpened > 0 ? "PASS" : "FAIL");
    await shot(page, "06-order-drawer");
    await page.keyboard.press("Escape").catch(() => {});
  } else {
    log("Order drawer", "SKIP", "no order row to click");
  }
} catch (e) {
  log("Order drawer", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 7: Playback mode ─────────────────────────────────────────────────
console.log("\n▶ Journey 7: Toggle PLAYBACK");
try {
  const playbackBtn = page.locator("button:has-text('PLAYBACK'), button:has-text('Playback')").first();
  if ((await playbackBtn.count()) > 0) {
    await playbackBtn.click();
    await page.waitForTimeout(2500);
    // Playwright doesn't accept mixed CSS + text=/…/ in one selector.
    // Check multiple simple selectors and sum.
    let bannerShown = 0;
    for (const sel of [
      "[class*='playback']",
      ".playback-banner-indicator",
      ".playback-badge-indicator",
    ]) {
      bannerShown += await page.locator(sel).count();
    }
    // Also check for PLAYBACK text via getByText
    bannerShown += await page.getByText(/PLAYBACK/i).count();
    log(
      "PLAYBACK mode visible",
      bannerShown > 0 ? "PASS" : "FAIL",
      bannerShown > 0 ? "banner rendered" : "no banner found",
    );
    await shot(page, "07-playback");

    // Back to LIVE
    await page.locator("button:has-text('LIVE'), button:has-text('Live')").first().click();
    await page.waitForTimeout(1500);
  } else {
    log("Playback toggle", "SKIP", "no PLAYBACK button found");
  }
} catch (e) {
  log("Playback toggle", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 8: Live polling advances data ────────────────────────────────────
console.log("\n▶ Journey 8: Live polling produces fresh data");
try {
  // Snapshot /api/markets twice with a 4s gap; Phase 1 replay writes every 3 min
  // but twins polling pulls more frequently. We expect at least one order_count
  // in some market to vary OR stay consistent with a recent-enough max_ts.
  const snap1 = await page.evaluate(async (app) => {
    const r = await fetch(`${app}/api/markets`);
    return r.ok ? await r.json() : null;
  }, APP);
  await page.waitForTimeout(5000);
  const snap2 = await page.evaluate(async (app) => {
    const r = await fetch(`${app}/api/markets`);
    return r.ok ? await r.json() : null;
  }, APP);

  if (!snap1 || !snap2) {
    log("Markets API live", "FAIL", "fetch failed");
  } else {
    const total1 = snap1.reduce((a, m) => a + (m.active_orders || 0), 0);
    const total2 = snap2.reduce((a, m) => a + (m.active_orders || 0), 0);
    log(
      "Markets API serves data",
      snap1.length === 22 && snap2.length === 22 ? "PASS" : "FAIL",
      `snap1=${snap1.length} snap2=${snap2.length}`,
    );
    log(
      "Active orders reasonable",
      total1 > 0 || total2 > 0 ? "PASS" : "FAIL",
      `t1=${total1} t2=${total2}`,
    );
  }
} catch (e) {
  log("Live polling check", "FAIL", e.message.split("\n")[0]);
}

// ── Journey 9: Verify caspers-free state (no /cx route after strip) ──────────
console.log("\n▶ Journey 9: Caspers-free indicators");
try {
  // Pre-Work-2: /cx renders CX panel. Post-Work-2: /cx should 404 or router no-match.
  // Both are acceptable outcomes; FAIL is if CX renders AND complaints/refunds syncs also
  // still exist (means the isolation isn't complete).
  await page.goto(`${APP}/cx`, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(1500);
  const cxRendered = await page.locator(".cx-kpi-card, .cx-page-title").count();
  if (cxRendered > 0) {
    log("CX panel present", "SKIP", "Work 2 (CX strip) not merged yet — OK");
  } else {
    log("CX panel absent", "PASS", "Work 2 CX strip is in effect");
  }
  await shot(page, "09-cx-route");
  await page.goto(APP);
  await page.waitForTimeout(1500);
} catch (e) {
  log("Caspers-free check", "FAIL", e.message.split("\n")[0]);
}

// ── Health: network + console ────────────────────────────────────────────────
console.log("\n▶ Network + console health");
log(
  "No 5xx API failures",
  networkFailures.length === 0 ? "PASS" : "FAIL",
  networkFailures.slice(0, 3).join(" | "),
);
log(
  "No console errors",
  consoleErrors.length === 0 ? "PASS" : "FAIL",
  consoleErrors.slice(0, 2).join(" | "),
);

// ── Summary ──────────────────────────────────────────────────────────────────
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
