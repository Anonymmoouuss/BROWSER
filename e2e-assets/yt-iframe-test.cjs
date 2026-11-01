const { chromium } = require("/home/z/.npm-global/lib/node_modules/playwright");
const fs = require("fs");
const http = require("http");

const GATEWAY = "http://127.0.0.1:81";
const GRANT = fs.readFileSync("/tmp/test-session.txt", "utf8").trim();

// host page on :8811 (different origin from the app at 127.0.0.1:81 => cross-site)
const HOST_PORT = 8811;
const host = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0">
  <iframe id="app" src="${GATEWAY}/" style="width:1380px;height:900px;border:0"></iframe>
  </body></html>`);
});
host.listen(HOST_PORT);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--block-third-party-cookies"],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-AU", timezoneId: "Australia/Sydney" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  const consoleErrs = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text().slice(0, 130)); });
  page.on("pageerror", (e) => consoleErrs.push("PAGEERROR " + String(e).slice(0, 130)));

  await page.goto(`http://127.0.0.1:${HOST_PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const appFrame = page.frames().find((f) => f.url().includes("127.0.0.1:81"));
  if (!appFrame) { console.log("NO APP FRAME"); host.close(); process.exit(1); }
  console.log("app iframe loaded:", appFrame.url().slice(0, 50));

  // third-party cookies are BLOCKED: set the grant into the iframe's
  // sessionStorage (partitioned storage works) and reload
  const RAW = fs.readFileSync("/tmp/test-session-raw.txt", "utf8").trim();
  await appFrame.evaluate(({ grant, raw }) => {
    try {
      sessionStorage.setItem("sj.grant", grant);
      sessionStorage.setItem("sj.session", raw);
    } catch (e) {}
  }, { grant: GRANT, raw: RAW });
  await page.evaluate(() => { document.getElementById("app").src = document.getElementById("app").src; });
  await page.waitForTimeout(6000);

  const gate = await appFrame.evaluate(() => document.body.innerText.includes("Private access") ? "GATE" : "UNLOCKED");
  console.log("gate state inside blocked-cookie iframe:", gate);
  if (gate === "GATE") { host.close(); process.exit(1); }

  await appFrame.waitForSelector("input[placeholder*='Search Bing']", { timeout: 60_000 });
  let booted = false;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(2500);
    const c = await appFrame.evaluate(() => !!window.__sjController);
    if (c) { booted = true; console.log("engine booted at t=" + (i + 1) * 2.5 + "s"); break; }
  }
  console.log("ENGINE BOOTED IN IFRAME:", booted);

  await appFrame.fill("input[placeholder*='Search Bing']", "youtube.com");
  await appFrame.press("input[placeholder*='Search Bing']", "Enter");

  let innerText = "";
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(3000);
    for (const f of page.frames()) {
      if (!f.parentFrame()) continue;
      const u = f.url();
      if (u.includes("/~/sj/") && u.includes("youtube")) {
        try {
          const t = await f.locator("body").innerText({ timeout: 1200 }).catch(() => "");
          if (t.length > innerText.length) innerText = t;
        } catch {}
      }
    }
    if (i % 5 === 0) console.log(`t=${(i + 1) * 3}s textLen=${innerText.length}`);
    if (innerText.length > 300) break;
  }
  await page.screenshot({ path: "/home/z/my-project/download/yt-iframe-final.png" });
  console.log("IFRAME YOUTUBE TEXT first 350:", innerText.slice(0, 350).replace(/\n+/g, " | "));
  console.log("console errors:", consoleErrs.length);
  consoleErrs.slice(0, 6).forEach((e) => console.log("  -", e));
  host.close();
  await browser.close();
  process.exit(innerText.length > 200 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); host.close(); process.exit(1); });
