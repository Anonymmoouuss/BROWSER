const { chromium } = require("/home/z/.npm-global/lib/node_modules/playwright");
const fs = require("fs");
const BASE = "http://127.0.0.1:81";
const GRANT = fs.readFileSync("/tmp/test-session.txt", "utf8").trim();

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1380, height: 900 }, locale: "en-AU", timezoneId: "Australia/Sydney" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);

  await context.addCookies([{ name: "sj_access", value: GRANT, url: BASE }]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[placeholder*='Search Bing']", { timeout: 60_000 });
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(2500); const c = await page.evaluate(() => !!window.__sjController); if (c) break; }

  // direct video URL (Rick Astley - classic)
  await page.fill("input[placeholder*='Search Bing']", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.press("input[placeholder*='Search Bing']", "Enter");
  console.log("navigating to a video...");

  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(3000);
    const f = page.frames().find((fr) => fr.parentFrame() && /youtube/i.test(fr.url()));
    if (f) {
      try {
        const state = await f.evaluate(() => {
          const player = document.querySelector("video");
          const title = document.querySelector("h1 yt-formatted-string, h1")?.textContent?.trim() ?? "";
          return {
            hasPlayer: !!player,
            playerSrc: player?.currentSrc?.slice(0, 60) ?? null,
            paused: player?.paused ?? null,
            currentTime: player ? Math.round(player.currentTime * 10) / 10 : null,
            readyState: player?.readyState ?? null,
            title,
          };
        });
        if (i % 3 === 0) console.log(`t=${(i + 1) * 3}s`, JSON.stringify(state).slice(0, 220));
        if (state.hasPlayer && (state.currentTime > 0.5 || state.readyState >= 3)) {
          console.log("VIDEO PLAYBACK WORKS!");
          console.log("title:", state.title.slice(0, 70));
          console.log("currentTime:", state.currentTime, "s");
          await page.screenshot({ path: "/home/z/my-project/download/yt-play-final.png" });
          await browser.close();
          process.exit(0);
        }
      } catch (e) { /* frame not ready */ }
    }
  }
  await page.screenshot({ path: "/home/z/my-project/download/yt-play-final.png" });
  console.log("VIDEO DID NOT START");
  await browser.close();
  process.exit(1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
