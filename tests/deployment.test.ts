import { afterEach, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runInNewContext } from "node:vm";
import FrameView from "../src/components/browser/frame-view";
import NewTabPage from "../src/components/browser/new-tab-page";
import { accessRequest, accessSession } from "../src/components/access/access-client";
import { normalizeInput, serviceWebSocketUrl } from "../src/lib/browser/shared";
import { bookmarkletSource, createBookmarklet, isBookmarklet, pageScriptError, runPageScript } from "../src/lib/browser/bookmarklets";
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