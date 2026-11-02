import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";

const frontend = process.env.E2E_FRONTEND_ORIGIN;
const backend = process.env.E2E_BACKEND_ORIGIN;
if (!frontend || !backend) {
  throw new Error("Set E2E_FRONTEND_ORIGIN and E2E_BACKEND_ORIGIN for the disposable split-host stack.");
}
test.setTimeout(120_000);

let sessionToken: string;
let sessionGrant: string;

test.beforeAll(async ({ request }) => {
  if (process.env.E2E_PASSKEY_SESSION_FILE) {
    const session = JSON.parse(await readFile(process.env.E2E_PASSKEY_SESSION_FILE, "utf8"));
    const response = await request.get(`${frontend}/api/access`, { headers: { "x-sj-session": session.sessionToken } });
    expect((await response.json()).unlocked).toBe(true);
    sessionToken = session.sessionToken;
    sessionGrant = session.sessionGrant;
    return;
  }
  const image = (await readFile("e2e-assets/member-face.jpeg.b64", "utf8")).trim();
  const passwordResponse = await request.post(`${frontend}/api/access`, {
    data: { action: "password", password: "member-pass-12345" },
  });
  expect(passwordResponse.status()).toBe(200);
  const password = await passwordResponse.json();
  const headers = { "x-sj-preauth": password.preauthToken };
  const challengeResponse = await request.post(`${frontend}/api/access`, {
    headers, data: { action: "challenge", purpose: "login" },
  });
  expect(challengeResponse.status()).toBe(200);
  const challenge = await challengeResponse.json();
  const loginResponse = await request.post(`${frontend}/api/access`, {
    headers, data: { action: "login", challengeId: challenge.challengeId, images: [image] },
  });
  expect(loginResponse.status()).toBe(200);
  const login = await loginResponse.json();
  expect(login.unlocked).toBe(true);
  sessionToken = login.sessionToken;
  sessionGrant = login.sessionGrant;
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(({ token, grant }) => {
    sessionStorage.setItem("sj.session", token);
    sessionStorage.setItem("sj.grant", grant);
  }, { token: sessionToken, grant: sessionGrant });
});

test("split-host engine loads a real page and the console connects directly", async ({ page }) => {
  const sockets: string[] = [];
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    sockets.push(`${url.origin}${url.pathname}`);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(frontend);
  await page.waitForFunction(() => !!(window as Window & { __sjController?: unknown }).__sjController, undefined, { timeout: 75_000 });
  const websocketOrigin = new URL(backend);
  websocketOrigin.protocol = websocketOrigin.protocol === "https:" ? "wss:" : "ws:";
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("https://example.com");
  await address.press("Enter");
  await expect(page.frameLocator("iframe").locator("body")).toContainText("This domain", { timeout: 45_000 });
  await page.getByRole("button", { name: "Toggle console" }).click();
  await expect(page.locator('[title="Console connected"]')).toBeVisible({ timeout: 20_000 });
  expect(sockets).toContain(`${websocketOrigin.origin}/ws`);
  await page.screenshot({ path: ".runtime/split-desktop.png", fullPage: true });
});

test("mobile browser controls fit the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(frontend);
  await expect(page.getByRole("textbox", { name: "Address and search bar" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await page.screenshot({ path: ".runtime/split-mobile.png", fullPage: true });
});

test("sign-in automatically recovers when its backend becomes available", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    let attempts = 0;
    await page.route("**/api/access", async (route) => {
      attempts++;
      if (attempts === 1) await route.fulfill({ status: 503, json: { error: "Temporary test outage" } });
      else await route.continue();
    });
    await page.goto(frontend);
    await expect(page.getByRole("heading", { name: "Sign-in unavailable", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Set up this workspace", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Private access", exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole("tab", { name: "Member", exact: true })).toBeVisible();
    expect(attempts).toBeGreaterThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test("administrator sign-in rejects the member passcode and continues to admin face verification", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(frontend);
    await page.getByRole("tab", { name: "Administrator", exact: true }).click();
    const passcode = page.getByLabel("Administrator passcode", { exact: true });
    await passcode.fill("member-pass-12345");
    await page.getByRole("button", { name: "Verify administrator", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("passcode");
    await passcode.fill("admin-pass-123456");
    await page.getByRole("button", { name: "Verify administrator", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Admin verification", exact: true })).toBeVisible();
    await page.screenshot({ path: ".runtime/admin-verification.png", fullPage: true });
  } finally {
    await context.close();
  }
});

test("address suggestions distinguish opening a site from searching and search reloads", async ({ page }) => {
  let searchCount = 0;
  await page.route("**/api/search?**", async (route) => {
    searchCount++;
    await route.fulfill({ json: { ok: true, results: [{ title: `Search result ${searchCount}`, url: "https://example.com", snippet: "Navigation regression fixture." }] } });
  });
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("example.com");
  await page.getByRole("option").filter({ hasText: "Open website" }).click();
  await expect(address).toHaveValue(/^https:\/\/example\.com\/?$/);
  await page.mouse.move(0, 0);
  await address.fill("example.com");
  await address.press("ArrowDown");
  await address.press("ArrowDown");
  await expect(page.getByRole("option", { selected: true })).toContainText("Search Bing");
  await address.press("Enter");
  await expect(address).toHaveValue("https://www.bing.com/search?q=example.com");
  await expect(page.getByRole("link", { name: /Search result 1/ })).toBeVisible();
  await page.getByRole("button", { name: "Reload page", exact: true }).click();
  await expect(page.getByRole("link", { name: /Search result 2/ })).toBeVisible();
});

test("closed tabs reopen with their original page and history", async ({ page }) => {
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("about:history");
  await address.press("Enter");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await address.fill("about:bookmarks");
  await address.press("Enter");
  await expect(address).toHaveValue("about:bookmarks");
  await page.getByRole("tab", { selected: true }).getByRole("button", { name: /^Close/ }).click();
  await expect(address).toHaveValue("about:history");
  await page.getByRole("button", { name: "Customize and control", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reopen closed tab", exact: true }).click();
  await expect(address).toHaveValue("about:bookmarks");
  await page.setViewportSize({ width: 320, height: 740 });
  for (let count = 0; count < 4; count++) {
    await page.getByRole("button", { name: "New tab", exact: true }).click();
  }
  const tabSearch = page.getByRole("button", { name: "Search tabs", exact: true });
  await expect(tabSearch).toBeVisible();
  const bounds = await tabSearch.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
});

test("YouTube Shorts remain a full proxied site, not a standalone video player", async ({ page }) => {
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("https://www.youtube.com/shorts");
  await address.press("Enter");
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("src", /\/~\/sj\/.*youtube.*shorts/, { timeout: 75_000 });
  await expect(frame).not.toHaveAttribute("src", /youtube-nocookie\.com\/embed/);
  await expect(frame).toHaveAttribute("allowfullscreen", "");
});

test("editable bookmarklets persist and inject code into the selected web page", async ({ page }) => {
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("about:bookmarks");
  await address.press("Enter");
  await page.getByRole("button", { name: "New bookmark", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New bookmark", exact: true });
  await editor.getByRole("radio", { name: "JavaScript", exact: true }).check();
  await editor.getByRole("textbox", { name: "Bookmark name", exact: true }).fill("Page accent");
  await editor.getByRole("textbox", { name: "JavaScript code", exact: true }).fill('document.body.dataset.bookmarklet = "applied"; "result";');
  await editor.getByRole("button", { name: "Save bookmarklet", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open all", exact: true })).toBeDisabled();
  await expect(page.getByRole("navigation", { name: "Bookmarks bar" }).getByRole("button", { name: "Run Page accent", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit Page accent", exact: true })).toBeVisible();
  await address.fill("https://example.com");
  await address.press("Enter");
  const body = page.frameLocator("iframe").locator("body");
  await expect(body).toContainText("This domain", { timeout: 45_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("navigation", { name: "Bookmarks bar" }).getByRole("button", { name: "Run Page accent", exact: true }).click();
  await expect(body).toHaveAttribute("data-bookmarklet", "applied");
  await expect(page.locator("body")).not.toHaveAttribute("data-bookmarklet");
  await expect(address).toHaveValue(/^https:\/\/example\.com\/?$/);
  await page.getByRole("button", { name: "Manage bookmarks", exact: true }).click();
  await page.getByRole("button", { name: "Edit Page accent", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit bookmark", exact: true });
  await expect(edit.getByRole("textbox", { name: "JavaScript code", exact: true })).toHaveValue('document.body.dataset.bookmarklet = "applied"; "result";');
  await edit.getByRole("textbox", { name: "JavaScript code", exact: true }).fill('(async () => { await Promise.resolve(); document.body.dataset.bookmarklet = "updated"; })();');
  await edit.getByRole("button", { name: "Save bookmarklet", exact: true }).click();
  await page.screenshot({ path: ".runtime/bookmarks-manager.png", fullPage: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("main", { name: "Browser viewport" }).getByRole("button", { name: "Run Page accent", exact: true }).click();
  await expect(body).toHaveAttribute("data-bookmarklet", "updated");
  await page.screenshot({ path: ".runtime/bookmarklet-desktop.png", fullPage: true });
});

test("bookmarklet cancellation and runtime errors do not navigate or alter the workspace", async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("cw.bookmarks.v1", JSON.stringify([
      { title: "Runtime error", url: `javascript:${encodeURIComponent('throw new Error("Bookmarklet test error")')}` },
      { title: "Async error", url: `javascript:${encodeURIComponent('(async () => { await Promise.resolve(); throw new Error("Async bookmarklet test error"); })();')}` },
    ]));
  });
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("https://example.com");
  await address.press("Enter");
  await expect(page.frameLocator("iframe").locator("body")).toContainText("This domain", { timeout: 45_000 });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Run Runtime error", exact: true }).click();
  await expect(page.getByText("Bookmarklet test error", { exact: true })).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Run Runtime error", exact: true }).click();
  await expect(page.getByText(/Bookmarklet test error/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Run Async error", exact: true }).click();
  await expect(page.getByText("Async bookmarklet test error", { exact: true })).toBeVisible();
  await expect(address).toHaveValue(/^https:\/\/example\.com\/?$/);
});

test("the JavaScript editor fits mobile viewports and original-site fallback stays external", async ({ page }) => {
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("about:bookmarks");
  await address.press("Enter");
  await page.getByRole("button", { name: "New bookmark", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New bookmark", exact: true });
  await editor.getByRole("radio", { name: "JavaScript", exact: true }).check();
  await editor.getByRole("textbox", { name: "Bookmark name", exact: true }).fill("Page accent");
  await editor.getByRole("textbox", { name: "JavaScript code", exact: true }).fill('document.body.style.outline = "3px solid #45c6b0";');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(editor).toHaveCSS("width", `${width - 32}px`);
    const bounds = await editor.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(12);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/bookmarklet-editor-${width}.png`, fullPage: true });
  }
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await address.fill("https://example.com");
  await address.press("Enter");
  await page.getByRole("button", { name: "Customize and control", exact: true }).click();
  const original = page.getByRole("menuitem", { name: "Open original website", exact: true });
  await expect(original).toHaveAttribute("href", /^https:\/\/example\.com\/?$/);
  await expect(original).toHaveAttribute("target", "_blank");
  await expect(original).toHaveAttribute("rel", "noopener noreferrer");
});

test("wallpapers, uploads, and appearance controls persist and fit mobile screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(frontend);
  const home = page.locator(".cw-home");
  await expect(home).toHaveCSS("background-image", /summit\.jpg/);
  await expect(home).toHaveCSS("background-size", "cover");
  await expect(home).toHaveCSS("background-repeat", "no-repeat");
  await page.evaluate(async () => {
    const image = new Image();
    image.src = "/wallpapers/summit.jpg";
    await image.decode();
    if (image.naturalWidth < 1500) throw new Error("Wallpaper image did not render.");
  });
  await page.screenshot({ path: ".runtime/wallpaper-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Customize new tab", exact: true }).click();
  await page.getByRole("radio", { name: "Ocean wallpaper", exact: true }).click();
  await expect(home).toHaveCSS("background-image", /ocean\.jpg/);
  await page.getByRole("checkbox", { name: "Clock", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Quick links", exact: true }).uncheck();
  await expect(page.getByLabel("Current time", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Quick links", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(home).toHaveCSS("background-image", /ocean\.jpg/);
  await expect(page.getByLabel("Current time", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Customize new tab", exact: true }).click();
  await page.getByLabel("Upload wallpaper image", { exact: true }).setInputFiles({
    name: "local-wallpaper.jpg", mimeType: "image/jpeg", buffer: await readFile("public/wallpapers/forest.jpg"),
  });
  await expect(home).toHaveCSS("background-image", /data:image\/webp;base64/);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const controls = page.getByRole("dialog");
    await expect(controls).toBeVisible();
    const bounds = await controls.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(8);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/wallpaper-mobile-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "Reset appearance", exact: true }).click();
  await expect(home).toHaveCSS("background-image", /summit\.jpg/);
});

test("compatible extensions install with consent, inject only into pages, and can be disabled or removed", async ({ page }) => {
  const manifest = { manifest_version: 3, name: "Page accent", version: "1.0", content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"], css: ["page.css"] }] };
  const archive = Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "content.js": strToU8('document.body.dataset.extensionInstall = "applied";'),
    "page.css": strToU8("body { border-top: 5px solid rgb(96, 218, 208) !important; }"),
  }));
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  const navigate = async (target: string) => { await address.fill(target); await address.press("Enter"); };
  await navigate("about:extensions");
  await page.getByLabel("Extension ZIP file", { exact: true }).setInputFiles({ name: "page-accent.zip", mimeType: "application/zip", buffer: archive });
  const review = page.getByRole("dialog", { name: "Install Page accent?", exact: true });
  await expect(review.getByRole("button", { name: "Install extension", exact: true })).toBeDisabled();
  await review.getByRole("checkbox", { name: /I trust this extension/ }).check();
  await review.getByRole("button", { name: "Install extension", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Enable Page accent", exact: true })).toBeChecked();
  await navigate("https://example.com");
  const body = page.frameLocator("iframe").locator("body");
  await expect(body).toHaveAttribute("data-extension-install", "applied", { timeout: 45_000 });
  await expect(body).toHaveCSS("border-top-width", "5px");
  await expect(page.locator("body")).not.toHaveAttribute("data-extension-install");
  await navigate("about:extensions");
  await page.getByRole("switch", { name: "Enable Page accent", exact: true }).uncheck();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Enable Page accent", exact: true })).not.toBeChecked();
  await navigate("https://example.com");
  await expect(body).toContainText("This domain", { timeout: 45_000 });
  await expect(body).not.toHaveAttribute("data-extension-install");
  await navigate("about:extensions");
  const unsupported = Buffer.from(zipSync({ "manifest.json": strToU8(JSON.stringify({ ...manifest, background: { service_worker: "background.js" } })), "content.js": strToU8("void 0;"), "page.css": strToU8("body {}") }));
  await page.getByLabel("Extension ZIP file", { exact: true }).setInputFiles({ name: "unsupported.zip", mimeType: "application/zip", buffer: unsupported });
  await expect(page.getByText("Chrome-only feature is not supported: background.", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enable Page accent", exact: true })).toHaveCount(1);
  await page.screenshot({ path: ".runtime/extensions-desktop.png", fullPage: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove Page accent", exact: true }).click();
  await expect(page.getByText("No extensions installed", { exact: true })).toBeVisible();
});

test("cross-site navigation replaces old engine frames without leaking routes", async ({ page }) => {
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  const frameUrls = new Set<string>();
  for (const target of ["https://example.com/?visit=1", "https://example.org/?visit=2", "https://example.net/?visit=3", "https://example.com/?visit=4"]) {
    await address.fill(target);
    await address.press("Enter");
    await page.waitForFunction((expected) => {
      try {
        const href = document.querySelector("iframe")?.contentWindow?.location.href ?? "";
        return decodeURIComponent(href).includes(expected);
      } catch { return false; }
    }, target, { timeout: 45_000 });
    const frame = page.locator("iframe");
    await expect(page.frameLocator("iframe").locator("body")).toContainText("This domain", { timeout: 45_000 });
    const source = await frame.getAttribute("src");
    expect(source).toBeTruthy();
    expect(frameUrls.has(source!)).toBe(false);
    frameUrls.add(source!);
    const registrations = await page.evaluate(() => (window as Window & { __sjController?: { frames: unknown[] } }).__sjController?.frames.length);
    expect(registrations).toBe(1);
  }
});

test("a refused destination has retry and compatibility controls without breaking later navigation", async ({ page }) => {
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("http://127.0.0.1:9/");
  await address.press("Enter");
  const failure = page.getByRole("alert", { name: "Page connection problem", exact: true });
  await expect(failure).toBeVisible({ timeout: 45_000 });
  await expect(failure).toContainText("This site could not be reached");
  await expect(failure.getByRole("link", { name: "Open original", exact: true })).toHaveAttribute("href", "http://127.0.0.1:9/");
  await page.getByRole("button", { name: "Retry page", exact: true }).click();
  await expect(failure).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Compatibility mode", exact: true }).click();
  await expect(page.getByText("Compatibility mode", { exact: true })).toBeVisible();
  await address.fill("https://example.com");
  await address.press("Enter");
  await expect(failure).toHaveCount(0);
  await expect(page.frameLocator("iframe").locator("body")).toContainText("This domain", { timeout: 45_000 });
  await page.getByRole("button", { name: "Use browser engine", exact: true }).click();
  await expect(address).toHaveValue(/^https:\/\/example\.com\/?$/);
  await expect(page.locator("iframe")).toHaveAttribute("src", /\/~\/sj\/.*example\.com/, { timeout: 45_000 });
  await expect(page.frameLocator("iframe").locator("body")).toContainText("This domain", { timeout: 45_000 });
});

test("the owner reviews passkey approval and IP context without exposing credential keys", async ({ browser }) => {
  test.skip(!process.env.E2E_PASSKEY_SESSION_FILE, "Requires the isolated owner session from the WebAuthn fixture.");
  const owner = JSON.parse(await readFile(".runtime/passkey-test-admin-session.json", "utf8"));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript((token) => sessionStorage.setItem("sj.session", token), owner.sessionToken);
    const page = await context.newPage();
    await page.goto(frontend);
    await expect(page.getByRole("heading", { name: "Admin Panel", exact: true })).toBeVisible();
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/admin") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Devices", exact: true }).click();
    const data = await (await responsePromise).json();
    expect(data.devices.length).toBeGreaterThanOrEqual(2);
    expect(data.devices.some((device: Record<string, unknown>) => Object.hasOwn(device, "publicKey"))).toBe(false);
    await expect(page.getByRole("heading", { name: "Device access", exact: true })).toBeVisible();
    await expect(page.getByText("Observed IP", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "WebAuthn Test Member", exact: true })).toBeVisible();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Revoke passkey", exact: true }).click();
    await expect(page.getByRole("button", { name: "Revoke passkey", exact: true })).toBeVisible();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.runtime/device-access-${width}.png`, fullPage: true });
    }
  } finally { await context.close(); }
});

test("trusted userscripts import as add-ons and modify only their matching page", async ({ page }) => {
  await page.goto(frontend);
  const address = page.getByRole("textbox", { name: "Address and search bar" });
  await address.fill("about:extensions");
  await address.press("Enter");
  const source = '// ==UserScript==\n// @name User script marker\n// @version 1.0\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\ndocument.body.dataset.userscriptInstalled = "yes";';
  await page.getByLabel("Extension ZIP file", { exact: true }).setInputFiles({ name: "marker.user.js", mimeType: "text/javascript", buffer: Buffer.from(source) });
  const dialog = page.getByRole("dialog", { name: "Install User script marker?", exact: true });
  await expect(dialog.getByRole("button", { name: "Install extension", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I trust this extension/ }).check();
  await dialog.getByRole("button", { name: "Install extension", exact: true }).click();
  await address.fill("https://example.com");
  await address.press("Enter");
  await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute("data-userscript-installed", "yes", { timeout: 45_000 });
  await expect(page.locator("body")).not.toHaveAttribute("data-userscript-installed");
});
