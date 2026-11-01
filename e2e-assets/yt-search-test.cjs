const { chromium } = require("/home/z/.npm-global/lib/node_modules/playwright");
const fs = require("fs");
const BASE = "http://127.0.0.1:81";
const GRANT = fs.readFileSync("/tmp/test-session.txt", "utf8").trim();

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1380, height: 900 }, locale: "en-AU", timezoneId: "Australia/Sydney" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  const fails = [];
  page.on("response", (r) => { if (r.status() >= 400) { const u = r.url(); if (u.includes("youtube") || u.includes("ytimg")) fails.push(r.status() + " " + u.slice(0, 110)); } });

  await context.addCookies([{ name: "sj_access", value: GRANT, url: BASE }]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[placeholder*='Search Bing']", { timeout: 60_000 });
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(2500); const c = await page.evaluate(() => !!window.__sjController); if (c) break; }

  // navigate to youtube
  await page.fill("input[placeholder*='Search Bing']", "youtube.com");
  await page.press("input[placeholder*='Search Bing']", "Enter");
  await page.waitForTimeout(12000);

  // type in YouTube's own search box and press Enter
  const ytFrame = () => page.frames().find((f) => f.parentFrame() && /youtube/i.test(f.url()));
  let searched = false;
  for (let i = 0; i < 8 && !searched; i++) {
    const f = ytFrame();
    if (f) {
      try {
        const box = f.locator("input#search, ytd-searchbox input, input[name='search_query']").first();
        if (await box.count()) {
          await box.fill("lofi hip hop radio");
          await box.press("Enter");
          searched = true;
          console.log("typed youtube search: lofi hip hop radio");
        }
      } catch (e) { /* retry */ }
    }
    if (!searched) await page.waitForTimeout(3000);
  }
  if (!searched) { console.log("NO SEARCH BOX FOUND"); }

  // wait for results
  let resultsText = "";
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(4000);
    const f = ytFrame();
    if (f) {
      try {
        const t = await f.locator("body").innerText({ timeout: 2000 }).catch(() => "");
        if (t.length > resultsText.length) resultsText = t;
        const titles = await f.locator("ytd-video-renderer h3, h3#video-title, ytd-rich-item-renderer #video-title-link").allInnerTexts({ timeout: 2000 }).catch(() => []);
        if (titles.length) {
          console.log("SEARCH RESULTS FOUND:", titles.length);
          titles.slice(0, 6).forEach((t2) => console.log("  -", t2.slice(0, 80)));
          await page.screenshot({ path: "/home/z/my-project/download/yt-search-final.png" });
          console.log("YOUTUBE SEARCH WORKS");
          console.log("failed requests:", fails.length);
          fails.slice(0, 5).forEach((x) => console.log("  x", x));
          await browser.close();
          process.exit(0);
        }
      } catch {}
    }
  }
  await page.screenshot({ path: "/home/z/my-project/download/yt-search-final.png" });
  console.log("NO SEARCH RESULTS. body text len:", resultsText.length);
  console.log("body text first 400:", resultsText.slice(0, 400).replace(/\n+/g, " | "));
  console.log("failed requests:", fails.length);
  fails.slice(0, 10).forEach((x) => console.log("  x", x));
  await browser.close();
  process.exit(1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
