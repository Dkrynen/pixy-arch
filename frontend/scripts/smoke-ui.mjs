// UI smoke test: node scripts/smoke-ui.mjs [appUrl]
// Screenshots go to PIXY_ARCH_SCREENSHOT_DIR, or the OS temp dir by default.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

const appUrl = process.argv[2] ?? process.env.PIXY_ARCH_URL ?? "http://127.0.0.1:8000/";
const screenshotDir = process.env.PIXY_ARCH_SCREENSHOT_DIR ?? tmpdir();
mkdirSync(screenshotDir, { recursive: true });
const desktopShot = join(screenshotDir, "pixy-arch-desktop.png");
const mobileShot = join(screenshotDir, "pixy-arch-mobile.png");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const logs = [];

page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    logs.push(`${message.type()}: ${message.text()}`);
  }
});
page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

// The app holds an EventSource to /api/hotplug/events open for the life of
// the page, so "networkidle" never settles. "load" is enough: the waits
// below cover the data-dependent UI.
await page.goto(appUrl, { waitUntil: "load" });
await page.getByRole("heading", { name: "Pixy Arch" }).waitFor({ state: "visible" });
await page.getByRole("button", { name: /Refresh controls/i }).click();
// The app-bar chip reads "Connected" once a capture device is selected.
await page.waitForFunction(() => document.body.innerText.includes("Connected"));
await page.getByRole("heading", { name: "PTZ", exact: true }).waitFor({ state: "visible" });
await page.getByRole("heading", { name: "Image", exact: true }).waitFor({ state: "visible" });
await page.getByRole("heading", { name: "Focus", exact: true }).waitFor({ state: "visible" });
await page.getByRole("heading", { name: "Exposure", exact: true }).waitFor({ state: "visible" });
await page.getByRole("heading", { name: "Smart Pixy" }).waitFor({ state: "visible" });
await page.getByText("Tracking & follow").waitFor({ state: "visible" });
await page.getByText("Gesture control").waitFor({ state: "visible" });
// Secondary sections ship collapsed; expanding one exercises the disclosure.
await page.getByText("Orientation").click();
await page.getByText("Auto rotate").waitFor({ state: "visible" });
// View switching remounts the deck and re-collapses sections, so capture now.
const hasAutoRotate = await page.evaluate(() => document.body.innerText.includes("Auto rotate"));
await page.screenshot({ path: desktopShot, fullPage: false });

// Diagnostics deck: exercised via the view switch, not visible by default.
await page.getByRole("button", { name: /Diagnostics/i }).click();
await page.getByRole("heading", { name: "UVC extension" }).waitFor({ state: "visible" });
const diagnosticsText = await page.locator("body").innerText();
await page.getByRole("button", { name: /Control Deck/i }).click();
await page.getByRole("heading", { name: "PTZ", exact: true }).waitFor({ state: "visible" });

await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(250);
await page.screenshot({ path: mobileShot, fullPage: false });

const bodyText = await page.locator("body").innerText();
const result = {
  title: await page.title(),
  url: page.url(),
  hasPixyArch: bodyText.includes("Pixy Arch"),
  hasPtzControl: (await page.getByRole("heading", { name: "PTZ", exact: true }).count()) === 1,
  hasImageControl: (await page.getByRole("heading", { name: "Image", exact: true }).count()) === 1,
  hasFocusControl: (await page.getByRole("heading", { name: "Focus", exact: true }).count()) === 1,
  hasExposureControl: (await page.getByRole("heading", { name: "Exposure", exact: true }).count()) === 1,
  hasSmartPixy: bodyText.includes("Smart Pixy"),
  hasTrackingFollow: bodyText.toLowerCase().includes("tracking & follow"),
  hasGestureControl: bodyText.includes("Gesture control"),
  hasAutoRotate,
  hasFutureDeck: diagnosticsText.toLowerCase().includes("uvc extension"),
  hasReadySignal: bodyText.includes("Connected"),
  rangeCount: await page.locator('input[type="range"]').count(),
  toggleCount: await page.locator(".toggle-switch").count(),
  selectCount: await page.locator("select").count(),
  logs,
  screenshots: [desktopShot, mobileShot]
};

await browser.close();

if (
  !result.hasPixyArch ||
  !result.hasPtzControl ||
  !result.hasImageControl ||
  !result.hasFocusControl ||
  !result.hasExposureControl ||
  !result.hasSmartPixy ||
  !result.hasTrackingFollow ||
  !result.hasGestureControl ||
  !result.hasAutoRotate ||
  !result.hasFutureDeck ||
  !result.hasReadySignal ||
  result.logs.length > 0
) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
