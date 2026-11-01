const { chromium } = require("/home/z/.npm-global/lib/node_modules/playwright");
const fs = require("fs");
const BASE = "http://127.0.0.1:81";
const GRANT = fs.readFileSync("/tmp/test-session.txt", "utf8").trim();

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1380, height: 900 } });
  const page = await context.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error" || /scramjet/i.test(m.text())) errs.push("[" + m.type() + "] " + m.text().slice(0, 300)); });
  page.on("pageerror", (e) => errs.push("[PAGEERROR] " + String(e).slice(0, 300)));

  await context.addCookies([{ name: "sj_access", value: GRANT, url: BASE }]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[placeholder*='Search Bing']", { timeout: 60_000 });
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2500);
    const spin = await page.evaluate(() => document.body.innerText.includes("Starting the Scramjet proxy engine"));
    if (!spin) break;
  }

  const probe = await page.evaluate(async () => {
    const c = window.__sjController;
    if (!c) return { controller: false };
    const out = { controller: true, prefix: c.prefix, frames: c.frames.length };
    try {
      const el = document.createElement("iframe");
      el.style.cssText = "position:fixed;right:0;bottom:0;width:600px;height:400px;z-index:99999;border:2px solid red";
      document.body.appendChild(el);
      const frame = c.createFrame(el);
      out.created = true;
      out.frameId = frame.id;
      frame.go("https://www.youtube.com");
      out.went = true;
      out.framesAfter = c.frames.length;
    } catch (e) {
      out.createError = String(e).stack || String(e);
    }
    return out;
  });
  console.log("PROBE:", JSON.stringify(probe, null, 2));

  await page.waitForTimeout(15000);
  const after = await page.evaluate(() => {
    const c = window.__sjController;
    const ifr = document.querySelectorAll("iframe");
    let text = "";
    for (const f of ifr) {
      try { text = f.contentDocument?.body?.innerText?.slice(0, 300) || ""; } catch { text = "(cross-origin)"; }
      if (text) break;
    }
    return { frames: c ? c.frames.length : -1, iframeCount: ifr.length, sampleText: text.slice(0, 250) };
  });
  console.log("AFTER 15s:", JSON.stringify(after, null, 2));
  await page.screenshot({ path: "/home/z/my-project/download/ctrl-probe.png" });
  console.log("--- console/page errors ---");
  errs.slice(0, 15).forEach((e) => console.log(e));
  await browser.close();
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
