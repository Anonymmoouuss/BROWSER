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
  const context = await browser.newContext({ viewport: { width: 1380, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);

  const netLog = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("bootstrap") || u.includes("sw.js") || u.includes("wisp") || u.includes("controller") || u.includes("scram") || u.includes("libcurl")) {
      netLog.push("REQ " + r.method() + " " + u.slice(0, 110));
    }
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("bootstrap") || u.includes("sw.js") || u.includes("wisp") || u.includes("controller") || u.includes("scram") || u.includes("libcurl")) {
      netLog.push("RES " + r.status() + " " + u.slice(0, 110));
    }
  });
  page.on("websocket", (ws) => {
    netLog.push("WS " + ws.url().slice(0, 110));
    ws.on("close", () => netLog.push("WS-CLOSE " + ws.url().slice(0, 80)));
  });
  page.on("console", (m) => {
    const t = m.text();
    if (/scramjet|engine|wisp|sw\b|service worker/i.test(t)) netLog.push("CONSOLE[" + m.type() + "] " + t.slice(0, 200));
  });
  page.on("pageerror", (e) => netLog.push("PAGEERROR " + String(e).slice(0, 200)));

  await context.addCookies([{ name: "sj_access", value: GRANT, url: BASE }]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[placeholder*='Search Bing']", { timeout: 60_000 });

  // wait 25s watching boot
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(5000);
    const st = await page.evaluate(() => {
      const spin = document.body.innerText.includes("Starting the Scramjet proxy engine");
      return { spinner: spin, sw: !!navigator.serviceWorker?.controller };
    });
    console.log(`t=${(i + 1) * 5}s`, JSON.stringify(st));
    if (!st.spinner) break;
  }

  const reg = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    return regs ? regs.map((r) => ({ scope: r.scope, active: !!r.active, state: r.active?.state })) : [];
  });
  console.log("SW registrations:", JSON.stringify(reg));

  console.log("--- network log ---");
  netLog.slice(0, 60).forEach((l) => console.log(l));
  await page.screenshot({ path: "/home/z/my-project/download/engine-diag.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
