// Run: npm run verify:live  (from frontend/, backend must be running)
import { chromium } from "playwright";
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:8000";
const IMG = "img[alt='Live camera stream']";
const results = [];
const consoleErrors = [];
const pageErrors = [];
const badResponses = [];

const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8" }).trim(); } catch (e) { return `ERR: ${e.message}`; } };
const rec = (n, pass, ev) => { results.push({ n, pass, ev }); console.log(`${pass ? "PASS" : "FAIL"}  ${n}  —  ${ev}`); };
const failShot = async (page, tag) => { try { await page.screenshot({ path: `/tmp/pixy-fail-${tag}.png` }); } catch {} };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("response", (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

const imgState = () => page.evaluate(() => {
  const i = document.querySelector("img[alt='Live camera stream']");
  return i ? { src: i.src, complete: i.complete, w: i.naturalWidth, h: i.naturalHeight } : null;
});
const waitImg = async (ms = 9000) => {
  await page.waitForSelector(IMG, { state: "attached", timeout: ms });
  await page.waitForFunction(() => {
    const i = document.querySelector("img[alt='Live camera stream']");
    return i && i.complete && i.naturalWidth > 0;
  }, null, { timeout: ms });
};
const streamBtn = () => page.getByRole("button", { name: /^(Show|Hide) stream$/ });
const privacyUp = () => page.locator(".video-overlay.is-privacy").isVisible().catch(() => false);
const leavePrivacy = async () => {
  const btn = page.getByRole("button", { name: "Standard", exact: true });
  await page.waitForFunction(
    () => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Standard"); return b && !b.disabled; },
    null, { timeout: 15000 }
  );
  await btn.click();
};

try {
  // ---------- 1. Load ----------
  await page.goto(BASE, { waitUntil: "load" });
  await page.getByRole("heading", { name: "Pixy Arch" }).waitFor({ timeout: 10000 });
  await page.getByRole("heading", { name: "Live Monitor" }).waitFor({ timeout: 10000 });
  await page.getByRole("heading", { name: "PTZ Control" }).waitFor({ timeout: 15000 });
  await page.getByRole("heading", { name: "Smart Pixy" }).waitFor({ timeout: 10000 });
  rec("1-load", consoleErrors.length === 0 && pageErrors.length === 0,
    `consoleErrors=${JSON.stringify(consoleErrors)} pageErrors=${JSON.stringify(pageErrors)} http>=400=${JSON.stringify(badResponses)}`);

  // ---------- 2. Preview (+ privacy handling) ----------
  await streamBtn().click();
  await waitImg(9000);
  let st = await imgState();
  const srcOk = st && st.src.includes("/api/devices/") && st.src.includes("/stream?");
  const priv = await privacyUp();
  if (priv) {
    await leavePrivacy();
    await page.waitForSelector(".video-overlay.is-privacy", { state: "detached", timeout: 15000 }).catch(() => {});
  }
  const shot1 = await page.locator(".video-frame").screenshot();
  await page.waitForTimeout(2000);
  const shot2 = await page.locator(".video-frame").screenshot();
  const st2 = await imgState();
  const framesAdvance = !shot1.equals(shot2);
  rec("2-preview", !!(srcOk && st2 && st2.w > 0 && framesAdvance && !(await privacyUp())),
    `src=${st?.src} natural=${st2?.w}x${st2?.h} privacyInitially=${priv} framesAdvance=${framesAdvance}`);
  if (!(srcOk && framesAdvance)) await failShot(page, "2");

  // ---------- 10. Ownership note ----------
  const note = (await page.locator(".device-ownership-note").innerText()).trim();
  rec("10-ownership", /mirrors the virtual camera feed|other apps can attach/i.test(note) && !/Preview owns the camera/i.test(note),
    `note="${note}"`);

  // ---------- 3. Hide/Show x3 ----------
  let cycles = 0, cycleErr = "";
  for (let i = 0; i < 3; i++) {
    try {
      await page.getByRole("button", { name: "Hide stream" }).click();
      await page.waitForSelector(IMG, { state: "detached", timeout: 4000 });
      await page.getByRole("button", { name: "Show stream" }).click();
      await waitImg(8000);
      cycles++;
    } catch (e) { cycleErr = `cycle${i}: ${e.message}`; break; }
  }
  rec("3-togglex3", cycles === 3 && consoleErrors.length === 0,
    `cycles=${cycles} ${cycleErr} consoleErrors=${JSON.stringify(consoleErrors)}`);

  // ---------- 4. Reload mid-stream ----------
  await page.reload({ waitUntil: "load" });
  await page.getByRole("heading", { name: "Live Monitor" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Show stream" }).click();
  await waitImg(9000);
  const st4 = await imgState();
  const readers = sh("pgrep -af 'ffmpeg.*-i */dev/video10' || true");
  rec("4-reload-resilience", !!(st4 && st4.w > 0) && readers === "",
    `img=${JSON.stringify(st4)} video10-readerProcs="${readers}"`);

  // ---------- 5. Recording ----------
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.waitForFunction(() => document.body.innerText.match(/RECORDING 0\d:\d\d/i), null, { timeout: 10000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Stop recording" }).click();
  await page.waitForSelector(".video-record-path", { timeout: 10000 });
  const recText = await page.locator(".video-record-path").innerText();
  const recPath = recText.replace(/^Last recording:\s*/, "").trim();
  const ls = sh(`ls -la "${recPath}"`);
  const probe = sh(`ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height -of default=nw=1 "${recPath}"`);
  rec("5-recording", recText.includes("Last recording:") && ls.includes(recPath.split("/").pop()) && !probe.startsWith("ERR"),
    `path=${recPath}\nls=${ls}\nffprobe=${probe}`);

  // ---------- 6. Disclosures ----------
  const openStates = () => page.$$eval("details.smart-control", (ds) =>
    ds.map((d) => ({ label: d.querySelector("summary span")?.textContent.trim(), open: d.open })));
  const before = await openStates();
  const orientation = page.locator("details.smart-control", { has: page.locator("summary span", { hasText: "Orientation" }) });
  const oSummary = orientation.locator("summary");
  await oSummary.click();
  await page.waitForFunction(() => [...document.querySelectorAll("details.smart-control")]
    .find((d) => d.querySelector("summary span")?.textContent.trim() === "Orientation")?.open === true);
  const mirrorVisible = await orientation.getByText("Mirror", { exact: true }).isVisible();
  const autoRotVisible = await orientation.getByText("Auto Rotate").isVisible();
  await oSummary.click();
  const collapsedAgain = await page.waitForFunction(() => [...document.querySelectorAll("details.smart-control")]
    .find((d) => d.querySelector("summary span")?.textContent.trim() === "Orientation")?.open === false).then(() => true).catch(() => false);
  await oSummary.focus(); await page.keyboard.press("Enter");
  const kbOpen = await page.$$eval("details.smart-control", (ds) =>
    ds.find((d) => d.querySelector("summary span")?.textContent.trim() === "Orientation")?.open);
  const after = await openStates();
  const othersCollapsed = after.every((d) => d.open === false || ["Tracking & Follow", "Orientation"].includes(d.label));
  rec("6-disclosures",
    before.find((d) => d.label === "Tracking & Follow")?.open === true &&
    before.filter((d) => d.open).length === 1 &&
    mirrorVisible && autoRotVisible && collapsedAgain && kbOpen === true && othersCollapsed,
    `before=${JSON.stringify(before)} mirror=${mirrorVisible} autoRotate=${autoRotVisible} recollapse=${collapsedAgain} kbEnter=${kbOpen} after=${JSON.stringify(after)}`);
  await page.keyboard.press("Enter");

  // ---------- 7. View switching ----------
  await page.getByRole("button", { name: "Diagnostics" }).click();
  await page.getByRole("heading", { name: "Future Deck" }).waitFor({ timeout: 8000 });
  await page.getByRole("heading", { name: "HID Diagnostics" }).waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "Control Deck" }).click();
  await page.getByRole("heading", { name: "Live Monitor" }).waitFor({ timeout: 8000 });
  rec("7-views", consoleErrors.length === 0 && pageErrors.length === 0,
    `consoleErrors=${JSON.stringify(consoleErrors)} pageErrors=${JSON.stringify(pageErrors)}`);

  // ---------- 8. PTZ panel ----------
  const dirCount = await page.locator(".ptz-direction").count();
  const center = page.locator(".ptz-center");
  const box = await center.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(400); await page.mouse.up();
  }
  await page.waitForTimeout(500);
  rec("8-ptz", dirCount === 4 && !!box && consoleErrors.length === 0 && pageErrors.length === 0,
    `directionButtons=${dirCount} centerPad=${!!box} consoleErrors=${JSON.stringify(consoleErrors)}`);

  // ---------- 9. Viewport 800 ----------
  await page.screenshot({ path: "/tmp/pixy-desktop-1440.png" });
  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    clipped: [...document.querySelectorAll("button")].filter((b) => {
      const r = b.getBoundingClientRect(); return r.width > 0 && (r.right > document.documentElement.clientWidth + 1 || r.left < -1);
    }).map((b) => b.getAttribute("aria-label") || b.textContent.trim()).slice(0, 10),
  }));
  await page.screenshot({ path: "/tmp/pixy-narrow-800.png" });
  rec("9-viewport-800", overflow.scrollW <= 800 && overflow.clipped.length === 0,
    `scrollWidth=${overflow.scrollW} clippedButtons=${JSON.stringify(overflow.clipped)}`);

  console.log("\n==== SUMMARY ====");
  console.log(JSON.stringify({ results, consoleErrors, pageErrors, badResponses }, null, 2));
} catch (e) {
  console.error("HARNESS-ABORT:", e.message);
  await failShot(page, "abort");
  console.log(JSON.stringify({ results, consoleErrors, pageErrors, badResponses }, null, 2));
} finally {
  await browser.close();
}
