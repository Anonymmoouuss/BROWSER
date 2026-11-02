import { afterEach, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runInNewContext } from "node:vm";
import FrameView from "../src/components/browser/frame-view";
import NewTabPage from "../src/components/browser/new-tab-page";
import { accessRequest, accessSession } from "../src/components/access/access-client";
import { normalizeInput, serviceWebSocketUrl } from "../src/lib/browser/shared";
import { bookmarkletSource, createBookmarklet, isBookmarklet, pageScriptError, runPageScript } from "../src/lib/browser/bookmarklets";
import { DEFAULT_APPEARANCE, normalizeAppearance, wallpaperImage } from "../src/lib/browser/appearance";
import { strToU8, zipSync } from "fflate";
import { extensionMatches, parseExtensionArchive, parseUserscript } from "../src/lib/browser/extensions";
import { proxyPageFailure } from "../src/lib/browser/page-failure";

test("known upstream engine failures become recoverable page errors, not normal website content", () => {
  expect(proxyPageFailure("Internal Service Worker Error: TypeError: Request failed with error code 7: Could not connect to server", "text/plain"))
    .toMatchObject({ code: 7, message: expect.stringContaining("could not connect") });
  expect(proxyPageFailure("Internal Service Worker Error: TypeError: Request failed with error code 6: Could not resolve host", "text/plain;charset=UTF-8")?.code).toBe(6);
  expect(proxyPageFailure("Internal Service Worker Error: Timeout", "text/html")).toBeNull();
  expect(proxyPageFailure("A page discussing Internal Service Worker Error", "text/plain")).toBeNull();
  expect(proxyPageFailure("Example Domain", "text/html")).toBeNull();
});

test("compatible extension archives load page scripts and styles without Chrome privileges", () => {
  const manifest = { manifest_version: 3, name: "Page marker", version: "1.0", content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"], css: ["page.css"] }] };
  const extension = parseExtensionArchive(zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "content.js": strToU8('document.body.dataset.extension = "installed";'), "page.css": strToU8("body { outline: 3px solid cyan; }") }));
  expect(extension.name).toBe("Page marker");
  expect(extension.rules[0].javascript).toContain("installed");
  expect(extension.rules[0].css).toContain("outline");
});

test("extension packages reject Chrome-only capabilities and unsafe archive paths", () => {
  const manifest = { manifest_version: 3, name: "Unsupported", version: "1.0", content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }] };
  for (const extra of [{ background: { service_worker: "background.js" } }, { permissions: ["cookies"] }, { action: { default_popup: "popup.html" } }]) {
    expect(() => parseExtensionArchive(zipSync({ "manifest.json": strToU8(JSON.stringify({ ...manifest, ...extra })), "content.js": strToU8("void 0;") }))).toThrow("Chrome");
  }
  expect(() => parseExtensionArchive(zipSync({ "../manifest.json": strToU8(JSON.stringify(manifest)) }))).toThrow("unsafe");
  expect(() => parseExtensionArchive(zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)) }))).toThrow("missing");
});

test("extension matching obeys schemes, host boundaries, and page paths", () => {
  expect(extensionMatches("https://*.example.com/*", "https://example.com/page")).toBe(true);
  expect(extensionMatches("https://*.example.com/*", "https://sub.example.com/page")).toBe(true);
  expect(extensionMatches("https://*.example.com/*", "https://example.com.evil.test/page")).toBe(false);
  expect(extensionMatches("https://example.com/news/*", "https://example.com/news/today")).toBe(true);
  expect(extensionMatches("https://example.com/news/*", "https://example.com/shop")).toBe(false);
  expect(extensionMatches("https://example.com/*", "http://example.com/")).toBe(false);
  expect(extensionMatches("<all_urls>", "javascript:alert(1)")).toBe(false);
  expect(extensionMatches("<all_urls>", "about:config")).toBe(false);
});

test("userscripts import only bounded page-context code with explicit site matches", () => {
  const source = '// ==UserScript==\n// @name Page marker\n// @version 1.0\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\ndocument.body.dataset.userscript = "ok";';
  const script = parseUserscript(source);
  expect(script.name).toBe("Page marker");
  expect(script.rules[0].matches).toEqual(["https://example.com/*"]);
  expect(script.rules[0].javascript).toContain('dataset.userscript = "ok"');
  expect(() => parseUserscript(source.replace("@grant none", "@grant GM_xmlhttpRequest"))).toThrow("Manager APIs");
  expect(() => parseUserscript(source.replace("@grant none", "@require https://example.com/code.js"))).toThrow("dependencies");
  expect(() => parseUserscript(source.replace("https://example.com/*", "file:///*"))).toThrow("HTTP");
  expect(() => parseUserscript("document.body.remove()")).toThrow("metadata");
});

test("appearance settings validate local wallpaper choices and clamp dimming", () => {
  expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  expect(normalizeAppearance({ wallpaper: "ocean", dim: 100, showClock: false })).toMatchObject({ wallpaper: "ocean", dim: 75, showClock: false });
  expect(normalizeAppearance({ wallpaper: "javascript:alert(1)", customImage: "https://untrusted.example/image.jpg", dim: NaN })).toEqual(DEFAULT_APPEARANCE);
  expect(wallpaperImage(normalizeAppearance({ wallpaper: "forest" }))).toBe("/wallpapers/forest.jpg");
  expect(wallpaperImage(normalizeAppearance({ wallpaper: "none" }))).toBe("");
});

test("custom wallpaper accepts bounded raster data, never active image markup", () => {
  const image = "data:image/webp;base64,AAAA";
  expect(wallpaperImage(normalizeAppearance({ wallpaper: "custom", customImage: image }))).toBe(image);
  expect(normalizeAppearance({ wallpaper: "custom", customImage: "data:image/svg+xml,<svg onload='alert(1)'/>" }).wallpaper).toBe("summit");
  expect(normalizeAppearance({ wallpaper: "custom", customImage: "data:image/png;base64," + "A".repeat(1_500_000) }).customImage).toBe("");
});
test("page script errors survive iframe wrappers and failed proxy property checks", () => {
  const wrapped = new Proxy(new Error("Bookmarklet test error"), { has: () => false });
  expect(pageScriptError(wrapped)).toBe("Bookmarklet test error");
  expect(pageScriptError("Script rejected")).toBe("Script rejected");
  expect(pageScriptError(null)).toBe("The page rejected this bookmarklet.");
  const inaccessible = new Proxy({}, { get: () => { throw new Error("Opaque proxy"); } });
  expect(pageScriptError(inaccessible)).toBe("The page rejected this bookmarklet.");
});

const originalBackend = process.env.BACKEND_ORIGIN;
const originalVercel = process.env.VERCEL;
const originalPublicBackend = process.env.NEXT_PUBLIC_BACKEND_ORIGIN;

afterEach(() => {
  if (originalBackend === undefined) delete process.env.BACKEND_ORIGIN;
  else process.env.BACKEND_ORIGIN = originalBackend;
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
  if (originalPublicBackend === undefined) delete process.env.NEXT_PUBLIC_BACKEND_ORIGIN;
  else process.env.NEXT_PUBLIC_BACKEND_ORIGIN = originalPublicBackend;
});

async function loadConfig(backend?: string, vercel = false) {
  if (backend === undefined) delete process.env.BACKEND_ORIGIN;
  else process.env.BACKEND_ORIGIN = backend;
  if (vercel) process.env.VERCEL = "1";
  else delete process.env.VERCEL;
  return (await import(`../next.config.ts?test=${crypto.randomUUID()}`)).default;
}

test("local deployment keeps the engine on localhost and APIs local", async () => {
  const config = await loadConfig();
  const routes = await config.rewrites();
  expect(config.output).toBe("standalone");
  expect(config.env.NEXT_PUBLIC_BACKEND_ORIGIN).toBe("");
  expect(routes.beforeFiles.find((route: { source: string }) => route.source === "/sw.js")?.destination)
    .toBe("http://127.0.0.1:3031/sw.js");
  expect(routes.beforeFiles.some((route: { source: string }) => route.source === "/api/:path*")).toBe(false);
});

test("Vercel forwards APIs and service-worker assets to the HTTPS backend", async () => {
  const config = await loadConfig("https://backend.example.com/", true);
  const routes = await config.rewrites();
  expect(config.output).toBeUndefined();
  expect(config.env.NEXT_PUBLIC_BACKEND_ORIGIN).toBe("https://backend.example.com");
  expect(routes.beforeFiles).toContainEqual({
    source: "/api/:path*", destination: "https://backend.example.com/api/:path*",
  });
  expect(routes.beforeFiles).toContainEqual({
    source: "/sw.js", destination: "https://backend.example.com/sw.js",
  });
  const queryRoute = routes.beforeFiles.find((route: { has?: unknown }) => route.has);
  expect(queryRoute.has[0].value).toBe("(?:3030|3031)");
  expect(queryRoute.destination).toBe("https://backend.example.com/:path*");
});

test("Vercel requires a backend instead of silently pointing at localhost", async () => {
  await expect(loadConfig(undefined, true)).rejects.toThrow("Set BACKEND_ORIGIN");
  await expect(loadConfig("http://backend.example.com", true)).rejects.toThrow("HTTPS");
});

test("backend origins reject credentials, non-HTTP protocols, and extra URL parts", async () => {
  for (const backend of [
    "ftp://backend.example.com", "https://user:password@backend.example.com",
    "https://backend.example.com/path", "https://backend.example.com?key=value",
    "https://backend.example.com#fragment",
  ]) {
    await expect(loadConfig(backend)).rejects.toThrow("BACKEND_ORIGIN");
  }
});

test("WebSockets use the backend directly, retaining the signed token and wisp suffix", () => {
  process.env.NEXT_PUBLIC_BACKEND_ORIGIN = "https://backend.example.com";
  expect(serviceWebSocketUrl("/wisp/?XTransformPort=3031&sjt=signed-token&x=/", "https://app.vercel.app"))
    .toBe("wss://backend.example.com/wisp/?XTransformPort=3031&sjt=signed-token&x=/");
  expect(serviceWebSocketUrl("/ws?XTransformPort=3030&sjt=signed-token", "https://app.vercel.app"))
    .toBe("wss://backend.example.com/ws?XTransformPort=3030&sjt=signed-token");
});

test("local WebSockets retain the page origin and port", () => {
  delete process.env.NEXT_PUBLIC_BACKEND_ORIGIN;
  expect(serviceWebSocketUrl("/ws?XTransformPort=3030", "http://localhost:81"))
    .toBe("ws://localhost:81/ws?XTransformPort=3030");
});

test("YouTube watch and Shorts URLs retain the full site instead of becoming embeds", () => {
  for (const target of [
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
    "https://www.youtube.com/results?search_query=music",
  ]) {
    expect(normalizeInput(target)).toBe(target);
    const markup = renderToStaticMarkup(createElement(FrameView, {
      tabId: "youtube-test", navUrl: target, navSeq: 1,
      title: "YouTube", zoom: 1, legacy: false,
      register: () => {}, onNav: () => {}, onLoad: () => {},
    }));
    expect(markup).toContain('title="YouTube"');
    expect(markup).toContain('allowFullScreen=""');
    expect(markup).toContain("picture-in-picture");
    expect(markup).not.toContain("youtube-nocookie.com/embed");
    expect(markup).not.toContain("YouTube video player");
  }
});

test("the new-tab Shorts shortcut opens the feed rather than a single-video embed", () => {
  const markup = renderToStaticMarkup(createElement(NewTabPage, {
    onNavigate: () => {}, bookmarks: [], onRemoveBookmark: () => {}, history: [],
  }));
  expect(markup).toContain("YouTube Shorts");
  expect(markup).toContain('title="https://www.youtube.com/shorts?hl=en&amp;gl=AU"');
  expect(markup).not.toContain("youtube-nocookie.com/embed");
});

test("an unavailable login API is never mistaken for a pristine workspace", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  try {
    for (const response of [
      new Response("Not found", { status: 404 }),
      Response.json({ error: "Unavailable" }, { status: 503 }),
      Response.json({}),
    ]) {
      fetchMock.mockResolvedValue(response);
      await expect(accessSession()).rejects.toThrow("temporarily unavailable");
    }
    fetchMock.mockResolvedValue(Response.json({ initialized: false, unlocked: false, adminEnrolled: false }));
    expect((await accessSession()).initialized).toBe(false);
  } finally {
    fetchMock.mockRestore();
  }
});

test("sign-in status checks have a bounded request and retain authentication validation", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ initialized: true, unlocked: false, role: null, adminEnrolled: true }));
  try {
    const session = await accessSession();
    expect(session.initialized).toBe(true);
    expect(session.unlocked).toBe(false);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.cache).toBe("no-store");
    expect(options.credentials).toBe("same-origin");
  } finally {
    fetchMock.mockRestore();
  }
});

test("face verification timeouts retain their specific retry message", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Verification timed out.", "TimeoutError"));
  try {
    await expect(accessRequest("login")).rejects.toMatchObject({ name: "TimeoutError", message: "Verification timed out." });
  } finally {
    fetchMock.mockRestore();
  }
});

test("bookmarklets preserve editable JavaScript and existing encoded URLs", () => {
  const source = 'document.body.dataset.test = "100% ready";';
  const bookmark = createBookmarklet("  Page marker  ", source);
  expect(bookmark.title).toBe("Page marker");
  expect(isBookmarklet(bookmark.url)).toBe(true);
  expect(bookmarkletSource(bookmark.url)).toBe(source);
  expect(bookmarkletSource(" JAVASCRIPT:alert('hello') ")).toBe("alert('hello')");
  expect(bookmarkletSource("javascript:void(0);/* 100% */")).toBe("void(0);/* 100% */");
  expect(() => createBookmarklet("", source)).toThrow("name");
  expect(() => createBookmarklet("Empty", "javascript:")).toThrow("JavaScript");
});

test("page scripts run through the target iframe without navigating the workspace", () => {
  const calls: string[] = [];
  const frame = {
    src: "https://workspace.example/~/sj/boot/frame/https%3A%2F%2Fexample.com",
    contentWindow: { eval(source: string) { calls.push(source); return "page result"; } },
  } as unknown as HTMLIFrameElement;
  expect(runPageScript(frame, "javascript:document.title")).toBe("page result");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(JSON.stringify("document.title"));
  expect(() => runPageScript(null, "alert(1)")).toThrow("Open a web page");
  for (const src of ["about:blank", "https://workspace.example/", "https://workspace.example/api/access"]) {
    expect(() => runPageScript({ ...frame, src } as HTMLIFrameElement, "alert(1)")).toThrow("workspace interface");
  }
  expect(calls).toHaveLength(1);
});

test("page scripts normalize synchronous and asynchronous errors before crossing iframe realms", async () => {
  const document = { title: "Target page" };
  const frame = {
    src: "https://workspace.example/~/sj/boot/frame/https%3A%2F%2Fexample.com",
    contentWindow: { eval(source: string) { return runInNewContext(source, { document }); } },
  } as unknown as HTMLIFrameElement;
  expect(runPageScript(frame, 'document.title = "Updated"; document.title;')).toBe("Updated");
  expect(document.title).toBe("Updated");
  let synchronousError: unknown;
  try {
    runPageScript(frame, 'throw new Error("Synchronous page failure");');
  } catch (error) {
    synchronousError = error;
  }
  expect(synchronousError).toBe("Synchronous page failure");
  await expect(Promise.resolve(runPageScript(frame, 'Promise.reject(new Error("Asynchronous page failure"));')))
    .rejects.toBe("Asynchronous page failure");
  await expect(Promise.resolve(runPageScript(frame, '(async () => { await Promise.resolve(); return 42; })();')))
    .resolves.toBe(42);
});