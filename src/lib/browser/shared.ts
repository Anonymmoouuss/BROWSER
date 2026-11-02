/**
 * Shared browser helpers: proxy URL construction, omnibox input normalization,
 * tab/history/bookmark types and localStorage persistence keys.
 */

import { sjtQuery } from "./engine-token";

export const BACKEND_PORT = "3030";

export function serviceWebSocketUrl(path: string, pageOrigin = window.location.origin): string {
  const url = new URL(path, process.env.NEXT_PUBLIC_BACKEND_ORIGIN || pageOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export interface Tab {
  id: string;
  /** current real URL as shown in the omnibox (advances on in-frame navigation) */
  url: string | null;
  /** URL to load into the iframe; only changes on EXPLICIT navigations */
  navUrl: string | null;
  /** bumped on every explicit navigation so FrameView reloads the iframe */
  navSeq: number;
  title: string;
  loading: boolean;
  /** per-tab page zoom multiplier (1 = 100%) */
  zoom: number;
  /** per-tab back/forward stack of real URLs */
  history: string[];
  hIndex: number;
}

export interface HistoryEntry {
  url: string;
  title: string;
  ts: number;
}

export interface Bookmark {
  url: string;
  title: string;
}

export const SESSION_KEY = "cw.tabs.v1";
export const HISTORY_KEY = "cw.history.v1";
export const BOOKMARKS_KEY = "cw.bookmarks.v1";
export const CONSOLE_KEY = "cw.console.open";

export function proxyUrl(target: string): string {
  return `/api/proxy?XTransformPort=${BACKEND_PORT}${sjtQuery()}&url=${encodeURIComponent(target)}`;
}

/** Same-origin URL that streams the UNREWRITTEN upstream body (raw=1 on the
 *  backend): what view-source shows and save-page-as downloads. */
export function rawProxyUrl(target: string): string {
  return `/api/proxy?XTransformPort=${BACKEND_PORT}${sjtQuery()}&url=${encodeURIComponent(target)}&raw=1`;
}

/**
 * Convert a proxy iframe location back to the real page URL (folds any
 * extra query params that were appended by GET forms back into the target).
 */
export function realUrlFromProxy(href: string): string | null {
  try {
    const u = new URL(href, window.location.origin);
    if (u.pathname !== "/api/proxy") return null;
    const inner = u.searchParams.get("url");
    if (!inner) return null;
    const out = new URL(inner);
    for (const [k, v] of u.searchParams) {
      if (
        k === "url" ||
        k === "raw" ||
        k === "sjt" ||
        k.toLowerCase() === "xtransformport"
      )
        continue;
      out.searchParams.append(k, v);
    }
    return out.href;
  } catch {
    return null;
  }
}

export function isUrlLike(q: string): boolean {
  if (/^about:/i.test(q)) return true;
  if (/^https?:\/\//i.test(q)) return true;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(q)) return true;
  return /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(q.trim());
}

/** Internal app pages that render inside a tab instead of the proxy frame.
 *  view-source:<url> pages are internal too (they render our source viewer). */
export const INTERNAL_PAGES = ["about:history", "about:bookmarks", "about:downloads", "about:config", "about:extensions"] as const;

export const VIEW_SOURCE_PREFIX = "view-source:";

/** The real page URL behind a view-source:<url> tab URL (null if not one). */
export function realUrlFromViewSource(url: string | null): string | null {
  if (!url || !url.startsWith(VIEW_SOURCE_PREFIX)) return null;
  const inner = url.slice(VIEW_SOURCE_PREFIX.length);
  return /^https?:\/\//i.test(inner) ? inner : null;
}

/**
 * What the user right-clicked inside a proxied page (built by FrameView at
 * event time, consumed by the page context menu). Coordinates are already
 * translated to the top window so the fixed-position menu lands correctly;
 * `fetchHref` is the same-origin URL that streams the resource through the
 * active proxy engine.
 */
export interface PageMenuTarget {
  x: number;
  y: number;
  link: { url: string; fetchHref: string } | null;
  image: { url: string; fetchHref: string } | null;
  linkText: string;
}

export function isInternalUrl(url: string | null | undefined): boolean {
  return !!url && (url.startsWith("about:") || url.startsWith(VIEW_SOURCE_PREFIX));
}

/** Omnibox normalization: internal pages, view-source:, URL if it looks like
 *  one, Bing search otherwise. (Bing — not DuckDuckGo — because the sandbox
 *  network SNI-blocks *.duckduckgo.com; Bing is fully reachable and renders
 *  server-side HTML that works in both engines.) */
export function normalizeInput(input: string): string | null {
  const q = input.trim();
  if (!q) return null;
  if (/^about:history$/i.test(q)) return "about:history";
  if (/^about:bookmarks$/i.test(q)) return "about:bookmarks";
  if (/^about:downloads$/i.test(q)) return "about:downloads";
  if (/^about:(config|settings)$/i.test(q)) return "about:config";
  if (/^about:(extensions|addons)$/i.test(q)) return "about:extensions";
  // view-source:example.com/page -> view-source:https://example.com/page
  if (/^view-source:/i.test(q)) {
    const inner = q.slice("view-source:".length).trim();
    const normalized = normalizeInput(inner);
    return normalized && !isInternalUrl(normalized) ? `${VIEW_SOURCE_PREFIX}${normalized}` : null;
  }
  if (/^https?:\/\//i.test(q)) return q;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(q)) return `http://${q}`;
  if (/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(q)) return `https://${q}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/* -------------------- locale enrichment (en-AU) --------------------
 * The sandbox's egress IP is geo-located in Asia, so geo-IP-driven sites
 * (YouTube above all) serve a Chinese UI no matter what Accept-Language
 * the browser sends (verified live: YouTube returned hl=zh-Hant gl=HK).
 * The workspace is configured for an English/Australian audience, so
 * explicit navigations to these hosts carry hl/gl locale hints (only
 * when the URL doesn't already express its own preference). After the
 * first localized load the sites persist the choice in their own
 * cookies, so in-site link clicks keep working without re-enrichment. */
const LOCALE_HL = "en";
const LOCALE_GL = "AU";
const LOCALE_HOST_RE =
  /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|google\.com)$/i;

/** true when the host is a YouTube/Google property whose interface language
 *  should be pinned to English/Australia on explicit navigations. */
export function isLocalePinnedHost(host: string | null | undefined): boolean {
  return !!host && LOCALE_HOST_RE.test(host);
}

/** Append hl=en&gl=AU (when absent) to YouTube/Google explicit navigations.
 *  Returns the input unchanged for everything else. */
export function localeEnrichedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    if (!isLocalePinnedHost(u.hostname)) return url;
    if (!u.searchParams.has("hl")) u.searchParams.set("hl", LOCALE_HL);
    if (!u.searchParams.has("gl")) u.searchParams.set("gl", LOCALE_GL);
    return u.href;
  } catch {
    return url;
  }
}

/**
 * The search query behind a Bing SERP URL (https://www.bing.com/search?q=...),
 * or null when the URL is not a search results URL. Omnibox searches resolve
 * to this URL shape; the app renders its own results page for them.
 */
export function searchQueryFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== "www.bing.com" && u.hostname !== "bing.com") return null;
    if (u.pathname !== "/search") return null;
    const q = u.searchParams.get("q");
    return q && q.trim() ? q.trim() : null;
  } catch {
    return null;
  }
}

/**
 * URLs served through the legacy server-side proxy even when the Scramjet
 * engine is active — the Bing SERP (and homepage, whose search box posts to
 * /search). Reason: Bing's edge serves junk result pages to the engine's
 * libcurl TLS fingerprint for top-tier queries (verified live: "youtube"
 * returned three different unrelated SERPs while "wikipedia"/"minecraft"/
 * "weather" were correct), whereas the legacy curl-based proxy receives the
 * real SERP every time. Only the /search path and "/" route here — Bing's
 * /ck/a outbound redirector and every other site keep the full-fidelity
 * Scramjet path (FrameView re-dispatches SERP result clicks as explicit
 * app navigations, which land on the Scramjet engine).
 */
export function isLegacyRoutedUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const h = hostOf(url);
  if (h !== "bing.com" && h !== "www.bing.com") return false;
  try {
    const p = new URL(url).pathname;
    return p === "/" || p === "/search";
  } catch {
    return false;
  }
}

/**
 * Decode a real upstream URL out of a Scramjet-rewritten same-origin URL
 * (/~/sj/<boot>/<frame>/https%3A%2F%2Fhost%2Fpath...). Returns null when the
 * href is not a scrambled URL.
 */
export function realUrlFromScramjet(href: string): string | null {
  try {
    const u = new URL(href, window.location.origin);
    if (!u.pathname.startsWith("/~/sj/")) return null;
    const segs = u.pathname.slice("/~/sj/".length).split("/");
    const idx = segs.findIndex((s) => /^https?%3A/i.test(s));
    if (idx < 0) return null;
    const inner = decodeURIComponent(segs.slice(idx).join("/"));
    return new URL(inner).href;
  } catch {
    return null;
  }
}

/**
 * Extract the /~/sj/<boot>/<frame>/ interception prefix from a live frame's
 * location. Raw external URLs (anchors, images keep theirs in Scramjet
 * frames) can be streamed/rendered by prefixing this + encodeURIComponent(url).
 */
export function scramjetFramePrefix(frameLocationHref: string): string | null {
  const m = frameLocationHref.match(/^.*\/~\/sj\/[^/]+\/[^/]+\//);
  return m ? m[0] : null;
}

export function faviconUrl(host: string): string {
  // Google's s2 favicon mirror (reachable from the sandbox; DuckDuckGo's
  // icons.duckduckgo.com is SNI-blocked). Unknown hosts resolve to the
  // default globe icon, so the img never breaks hard.
  return proxyUrl(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`);
}

export function shortenPath(p: string): string {
  if (p === "/home/z") return "~";
  if (p.startsWith("/home/z/")) return `~${p.slice(7)}`;
  return p;
}

export function makeTabId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function newTab(): Tab {
  return { id: makeTabId(), url: null, navUrl: null, navSeq: 0, title: "New tab", loading: false, zoom: 1, history: [], hIndex: -1 };
}

/* ---------------- zoom (Chrome-style ladder) ---------------- */

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export function zoomIn(z: number): number {
  return ZOOM_STEPS.find((s) => s > z + 1e-9) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

export function zoomOut(z: number): number {
  const smaller = [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-9);
  return smaller ?? ZOOM_STEPS[0];
}

/* ---------------- storage helpers ---------------- */

export function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota — ignore */
  }
}
