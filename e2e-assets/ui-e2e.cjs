const { chromium } = require("/home/z/.npm-global/lib/node_modules/playwright");

const BASE = "http://127.0.0.1:81";
const USER_PW = "member-pass-12345";
const ADMIN_PW = "admin-pass-123456";
const SHOT = (n) => `/home/z/my-project/download/qa-face-${n}.png`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, detail); }
};

async function launchBrowser(camFile) {
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args: [
      `--use-fake-device-for-media-stream`,
      `--use-file-for-fake-video-capture=${camFile}`,
      `--no-sandbox`,
      `--disable-dev-shm-usage`,
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["camera"],
  });
  return { browser, context };
}

(async () => {
  /* ---------- PHASE A: first-run wizard + admin setup (admin camera) ---------- */
  console.log("--- PHASE A: first-run wizard + admin enrollment ---");
  const A = await launchBrowser("/home/z/my-project/e2e-assets/admin-cam.y4m");
  const page = await A.context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Set up this workspace", { timeout: 30_000 });
  check("wizard-shown", true);

  const pwInputs = page.locator("input[type=password]");
  await pwInputs.nth(0).fill(USER_PW);
  await pwInputs.nth(1).fill(USER_PW);
  await pwInputs.nth(2).fill(ADMIN_PW);
  await pwInputs.nth(3).fill(ADMIN_PW);
  await page.getByRole("button", { name: "Create workspace passwords" }).click();
  await page.waitForSelector("text=One-time setup secret", { timeout: 20_000 });
  const secret = await page.locator("textarea").first().inputValue();
  check("setup-secret-shown", secret.length >= 32, `len=${secret.length}`);
  await page.screenshot({ path: SHOT("1-setup-secret") });

  await page.getByRole("button", { name: "Continue to administrator setup" }).click();
  await page.waitForSelector("text=Private access", { timeout: 15_000 });
  await page.locator("input[type=password]").fill(ADMIN_PW);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await page.waitForSelector("text=Admin verification", { timeout: 15_000 });
  await page.getByRole("button", { name: "Enroll administrator face" }).click();
  await page.waitForSelector("text=Set up Admin Panel", { timeout: 15_000 });
  await page.locator("input[type=password]").fill(secret);
  await page.locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "Start face enrollment" }).click();
  await page.waitForSelector("text=Capturing clear photo", { timeout: 30_000 });
  console.log("  camera capturing 20 admin photos...");
  await page.waitForSelector("h1:has-text('Admin Panel')", { timeout: 120_000 });
  check("admin-panel-after-setup", true);
  await page.waitForSelector("text=Save your recovery codes", { timeout: 15_000 });
  check("recovery-codes-shown", true);
  await page.screenshot({ path: SHOT("2-admin-panel-setup") });
  await page.getByRole("button", { name: "I have saved these codes" }).click();

  // reload: session persists in this tab
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("h1:has-text('Admin Panel')", { timeout: 30_000 });
  check("admin-session-survives-reload", true);

  // lock the panel
  await page.getByRole("button", { name: "Lock Admin Panel" }).click();
  await page.waitForSelector("text=Private access", { timeout: 15_000 });
  check("admin-lock-returns-to-password", true);

  /* ---------- PHASE B: ADMIN FACE LOGIN (the user's broken path) ---------- */
  console.log("--- PHASE B: admin face login (user's reported broken path) ---");
  await page.locator("input[type=password]").fill(ADMIN_PW);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await page.waitForSelector("text=Admin verification", { timeout: 15_000 });
  await page.getByRole("button", { name: "Scan my face" }).click();
  await page.waitForSelector("text=a few quick photos", { timeout: 15_000 });
  console.log("  scanning admin face (3 frames)...");
  await page.waitForSelector("h1:has-text('Admin Panel')", { timeout: 60_000 });
  check("ADMIN-FACE-LOGIN-UI", true);
  await page.screenshot({ path: SHOT("3-admin-face-login") });
  await A.browser.close();

  /* ---------- PHASE C: member enrollment (member camera) ---------- */
  console.log("--- PHASE C: member enrollment ---");
  const C = await launchBrowser("/home/z/my-project/e2e-assets/member-cam.y4m");
  const mpage = await C.context.newPage();
  mpage.setDefaultTimeout(90_000);
  await mpage.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await mpage.waitForSelector("text=Private access", { timeout: 30_000 });
  await mpage.locator("input[type=password]").fill(USER_PW);
  await mpage.getByRole("button", { name: "Unlock workspace" }).click();
  await mpage.waitForSelector("text=Verify your face", { timeout: 15_000 });
  await mpage.getByRole("button", { name: "Enrol your face" }).click();
  await mpage.waitForSelector("text=Enrol your face", { timeout: 15_000 });
  await mpage.locator("input[type=text]").fill("Test Member");
  await mpage.locator("input[type=checkbox]").check();
  await mpage.getByRole("button", { name: "Start face enrollment" }).click();
  console.log("  camera capturing 20 member photos...");
  await mpage.waitForSelector("text=Awaiting approval", { timeout: 120_000 });
  check("member-enroll-pending-ui", true);
  await mpage.screenshot({ path: SHOT("4-member-pending") });
  await C.browser.close();

  /* ---------- PHASE D: admin approves + confirms payment (admin camera) ---------- */
  console.log("--- PHASE D: admin approval + payment ---");
  const D = await launchBrowser("/home/z/my-project/e2e-assets/admin-cam.y4m");
  const apage = await D.context.newPage();
  apage.setDefaultTimeout(90_000);
  await apage.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await apage.waitForSelector("text=Private access", { timeout: 30_000 });
  await apage.locator("input[type=password]").fill(ADMIN_PW);
  await apage.getByRole("button", { name: "Unlock workspace" }).click();
  await apage.waitForSelector("text=Admin verification", { timeout: 15_000 });
  await apage.getByRole("button", { name: "Scan my face" }).click();
  await apage.waitForSelector("h1:has-text('Admin Panel')", { timeout: 60_000 });
  await apage.getByRole("button", { name: "Enrollments" }).click();
  await apage.waitForSelector("text=Test Member", { timeout: 30_000 });
  check("admin-sees-pending-member", true);
  await apage.screenshot({ path: SHOT("5-admin-approvals") });
  await apage.getByRole("button", { name: "Approve" }).click();
  // observable outcome: the refetched list shows the member as approved
  await apage.waitForSelector("section:has-text('Test Member') >> text=approved", { timeout: 30_000 });
  check("member-approved", true);
  await apage.getByRole("button", { name: "Payments" }).click();
  await apage.waitForSelector("text=Confirm $5 received", { timeout: 30_000 });
  await apage.getByRole("button", { name: "Confirm $5 received" }).first().click();
  // observable outcome: the Paid badge replaces "Payment required"
  await apage.waitForSelector("section:has-text('Test Member') >> text=Paid", { timeout: 30_000 });
  check("payment-confirmed", true);
  await apage.screenshot({ path: SHOT("6-admin-payments") });
  await D.browser.close();

  /* ---------- PHASE E: member unlocks the browser (member camera) ---------- */
  console.log("--- PHASE E: member face login unlocks browser ---");
  const E = await launchBrowser("/home/z/my-project/e2e-assets/member-cam.y4m");
  const epage = await E.context.newPage();
  epage.setDefaultTimeout(90_000);
  await epage.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await epage.waitForSelector("text=Private access", { timeout: 30_000 });
  await epage.locator("input[type=password]").fill(USER_PW);
  await epage.getByRole("button", { name: "Unlock workspace" }).click();
  await epage.waitForSelector("text=Verify your face", { timeout: 15_000 });
  await epage.getByRole("button", { name: "Scan my face" }).click();
  console.log("  scanning member face (3 frames)...");
  await epage.waitForSelector("text=New Tab", { timeout: 90_000 });
  check("MEMBER-FACE-LOGIN-UNLOCKS-BROWSER", true);
  await epage.screenshot({ path: SHOT("7-member-unlocked") });

  // navigate to a real site through the Scramjet engine
  const omnibox = epage.locator("input[aria-label*='ddress'], input[aria-label*='earch'], input[placeholder*='Search or type']").first();
  if (await omnibox.count()) {
    await omnibox.fill("https://example.com");
    await omnibox.press("Enter");
    try {
      await epage.waitForSelector("text=Example Domain", { timeout: 60_000 });
      check("real-site-loads-through-engine", true);
      await epage.screenshot({ path: SHOT("8-example-com") });
    } catch {
      check("real-site-loads-through-engine", false, "example.com text not found");
    }
  } else {
    check("real-site-loads-through-engine", false, "omnibox not found");
  }
  await E.browser.close();

  console.log(`\n=== UI E2E: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
