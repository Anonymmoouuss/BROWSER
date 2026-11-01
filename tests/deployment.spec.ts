import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const frontend = process.env.E2E_FRONTEND_ORIGIN;
const backend = process.env.E2E_BACKEND_ORIGIN;
if (!frontend || !backend) {
  throw new Error("Set E2E_FRONTEND_ORIGIN and E2E_BACKEND_ORIGIN for the disposable split-host stack.");
}
test.setTimeout(120_000);

let sessionToken: string;
let sessionGrant: string;

test.beforeAll(async ({ request }) => {
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