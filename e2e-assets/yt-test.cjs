const { chromium } = require("/home/z/.npm-global/lib/node_modules/playwright");
const fs = require("fs");

const BASE = "http://127.0.0.1:81";
const GRANT = fs.readFileSync("/tmp/test-session.txt", "utf8").trim();

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1380, height: 900 },
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);

  const netLog = [];
  page.on("response", (r) => { const u = r.url(); if (u.includes("youtube.com") && u.includes("/~/sj/")) netLog.push("RES " + r.status() + " " + u.slice(0, 100)); });
  page.on("pageerror", (e) => netLog.push("PAGEERROR " + String(e).slice(0, 150)));
  const consoleErrs = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text().slice(0, 120)); });

  await context.addCookies([{ name: "sj_access", value: GRANT, url: BASE }]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[placeholder*='Search Bing']", { timeout: 60_000 });

  // wait for engine boot
  let booted = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2500);
    const c = await page.evaluate(() => !!window.__sjController);
    if (c) { booted = true; console.log("engine controller booted at t=" + (i + 1) * 2.5 + "s"); break; }
  }
  console.log("ENGINE BOOTED:", booted);

  await page.fill("input[placeholder*='Search Bing']", "youtube.com");
  await page.press("input[placeholder*='Search Bing']", "Enter");
  console.log("navigating to youtube.com (enriched with hl=en&gl=AU)...");

  let loaded = false;
  let innerText = "";
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(3000);
    const frames = page.frames();
    for (const f of frames) {
      if (!f.parentFrame()) continue;
      try {
        const t = await f.locator("body").innerText({ timeout: 1500 }).catch(() => "");
        if (t.length > innerText.length) innerText = t;
      } catch {}
    }
    if (i % 5 === 0) console.log(`t=${(i + 1) * 3}s textLen=${innerText.length}`);
    if (innerText.length > 800) { loaded = true; break; }
  }
  console.log("YOUTUBE LOADED:", loaded);
  console.log("INNER TEXT first 600:", innerText.slice(0, 600).replace(/\n+/g, " | "));
  await page.screenshot({ path: "/home/z/my-project/download/yt-test-final.png" });
  console.log("console errors:", consoleErrs.length);
  consoleErrs.slice(0, 5).forEach((e) => console.log("  -", e));
  await browser.close();
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
