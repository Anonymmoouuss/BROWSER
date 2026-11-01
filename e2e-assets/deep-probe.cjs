const { chromium } = require("/home/z/.npm-global/lib/node_modules/playwright");
const fs = require("fs");
const BASE = "http://127.0.0.1:81";
const GRANT = fs.readFileSync("/tmp/test-session.txt", "utf8").trim();

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1380, height: 900 } });
  const page = await context.newPage();
  const errs = [];
  page.on("console", (m) => { const t = m.text(); if (m.type() === "error" || /scramjet|wisp|controller/i.test(t)) errs.push("[" + m.type() + "] " + t.slice(0, 250)); });
  page.on("pageerror", (e) => errs.push("[PAGEERROR] " + String(e).slice(0, 250)));

  await context.addCookies([{ name: "sj_access", value: GRANT, url: BASE }]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[placeholder*='Search Bing']", { timeout: 60_000 });
  await page.waitForTimeout(6000);

  const bootState = await page.evaluate(async () => {
    const c = window.__sjController;
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    return {
      controller: !!c,
      prefix: c?.prefix ?? null,
      frames: c?.frames?.length ?? 0,
      swRegs: regs.map((r) => ({ scope: r.scope, state: r.active?.state, scriptUrl: r.active?.scriptURL?.slice(0, 60) })),
      swControls: !!navigator.serviceWorker.controller,
    };
  });
  console.log("BOOT STATE:", JSON.stringify(bootState, null, 2));

  // try createFrame directly
  if (bootState.controller) {
    const nav = await page.evaluate(async () => {
      try {
        const c = window.__sjController;
        const el = document.createElement("iframe");
        el.id = "probe-frame";
        el.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px;z-index:99999;border:2px solid red;background:#fff";
        document.body.appendChild(el);
        const f = c.createFrame(el);
        await c.wait();
        f.go("https://www.youtube.com");
        return { created: true, frameId: f.id, prefix: f.element?.src?.slice(0, 80) ?? null };
      } catch (e) {
        return { created: false, error: String(e).slice(0, 300) };
      }
    });
    console.log("NAV RESULT:", JSON.stringify(nav, null, 2));

    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(5000);
      const st = await page.evaluate(() => {
        const el = document.getElementById("probe-frame");
        let txt = "";
        try { txt = el?.contentDocument?.body?.innerText?.slice(0, 200) ?? ""; } catch { txt = "(cross-origin)"; }
        return { src: el?.src?.slice(0, 90) ?? null, text: txt };
      });
      console.log(`t=${(i + 1) * 5}s`, JSON.stringify(st));
      if (st.text && st.text.length > 50) break;
    }
  }
  await page.screenshot({ path: "/home/z/my-project/download/deep-probe.png" });
  console.log("--- console/page events ---");
  errs.slice(0, 20).forEach((e) => console.log(e));
  await browser.close();
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
