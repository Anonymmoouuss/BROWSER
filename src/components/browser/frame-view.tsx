"use client";

/**
 * FrameView — the per-tab iframe, in two interchangeable modes:
 *
 *  - scramjet (primary): the iframe is driven by a scramjet Frame
 *    (service-worker interception + wisp transport). frame.go(url) loads a
 *    rewritten, same-origin copy of the real site; the UrlWatcher plugin
 *    reports every in-frame navigation back to the app; back/forward/reload
 *    use the iframe's REAL session history.
 *
 *  - legacy (fallback): the iframe src points at the server-side rewriting
 *    proxy on :3030 and an injected reporter script postMessages
 *    navigations. Used when the scramjet engine cannot boot (no SW support,
 *    service down...).
 *
 * Explicit navigations arrive as (navUrl, navSeq) pairs; in-frame link
 * clicks navigate the iframe itself and are reported through onNav.
 */

import { useEffect, useRef } from "react";
import { proxyUrl, realUrlFromProxy, realUrlFromScramjet, scramjetFramePrefix, type PageMenuTarget } from "@/lib/browser/shared";
import { buildFramePlugins, destroyScramjetFrame, getScramjetEngine, type SjFrame } from "@/lib/browser/scramjet";

interface FrameViewProps {
  tabId: string;
  navUrl: string;
  navSeq: number;
  title: string;
  /** page zoom multiplier (CSS zoom on the iframe, 1 = 100%) */
  zoom: number;
  /** true = use the legacy :3030 rewriting proxy instead of scramjet */
  legacy: boolean;
  /** true while this frame shows a legacy-routed search results page: plain
   *  left-clicks on outbound links (other hosts, or Bing's /ck/a redirector)
   *  are re-dispatched as explicit app navigations so the destination loads
   *  through the Scramjet engine with full fidelity — the legacy rewriter
   *  cannot carry JS-heavy sites like YouTube. */
  searchRouted?: boolean;
  /** explicit app navigation (omnibox-equivalent) — used by the search-routed
   *  click interception above. */
  onExplicitNavigate?: (input: string) => void;
  register: (el: HTMLIFrameElement | null) => void;
  onNav: (url: string, title: string) => void;
  onLoad: () => void;
  /** called when a click on an <a download> inside the frame is intercepted */
  onDownload?: (fetchHref: string, filename: string | null, displayUrl: string, sourceUrl: string) => void;
  /** called when the user right-clicks inside the frame (page context menu) */
  onPageMenu?: (target: PageMenuTarget) => void;
  /** middle-click / Ctrl+click on a link: open it as a new tab (background unless Shift) */
  onOpenTab?: (url: string, background: boolean) => void;
}

export default function FrameView({ tabId, navUrl, navSeq, title, zoom, legacy, searchRouted, onExplicitNavigate, register, onNav, onLoad, onDownload, onPageMenu, onOpenTab }: FrameViewProps) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const frameRef = useRef<SjFrame | null>(null);
  const onNavRef = useRef(onNav);
  const onDownloadRef = useRef(onDownload);
  const onPageMenuRef = useRef(onPageMenu);
  const onOpenTabRef = useRef(onOpenTab);
  const onExplicitNavigateRef = useRef(onExplicitNavigate);
  const searchRoutedRef = useRef(!!searchRouted);
  const zoomRef = useRef(zoom);
  const detachInterceptorRef = useRef<(() => void) | null>(null);
  const lastUrlRef = useRef<string>("");

  // keep the latest callbacks for async hooks (assigned in effects, never
  // during render)
  useEffect(() => {
    onNavRef.current = onNav;
    onDownloadRef.current = onDownload;
    onPageMenuRef.current = onPageMenu;
    onOpenTabRef.current = onOpenTab;
    onExplicitNavigateRef.current = onExplicitNavigate;
    searchRoutedRef.current = !!searchRouted;
    zoomRef.current = zoom;
  }, [onNav, onDownload, onPageMenu, onOpenTab, onExplicitNavigate, searchRouted, zoom]);

  useEffect(() => {
    const el = ref.current;
    register(el);
    return () => register(null);
  }, [register]);

  /* ---------- navigation (explicit) ---------- */
  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    if (!el || !navUrl) return;

    if (legacy) {
      el.src = proxyUrl(navUrl);
      return;
    }

    (async () => {
      const controller = await getScramjetEngine();
      if (cancelled || !el) return;
      if (!controller) {
        // engine refused to boot here — last-ditch legacy load
        el.src = proxyUrl(navUrl);
        return;
      }
      let frame = frameRef.current;
      if (!frame) {
        frame = controller.createFrame(el, {
          plugins: buildFramePlugins((url) => {
            lastUrlRef.current = url;
            onNavRef.current(url, "");
          }),
        });
        frameRef.current = frame;
      }
      lastUrlRef.current = navUrl;
      frame.go(navUrl);
    })();

    return () => {
      cancelled = true;
    };
  }, [navSeq, navUrl, legacy]);

  /* ---------- title polling (SPAs change document.title dynamically) ---------- */
  useEffect(() => {
    if (legacy) return;
    const t = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      try {
        const docTitle = el.contentDocument?.title ?? "";
        if (docTitle && lastUrlRef.current) {
          onNavRef.current(lastUrlRef.current, docTitle);
        }
      } catch {
        /* about:blank or mid-navigation blip */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [legacy]);

  // detach the a[download] interceptor on unmount (reads the ref at cleanup
  // time — not at mount — so the latest document listener is removed)
  useEffect(() => {
    return () => {
      detachInterceptorRef.current?.();
      detachInterceptorRef.current = null;
    };
  }, []);

  // deregister the scramjet frame from the engine controller on unmount:
  // closed tabs (and tabs switching to internal pages) would otherwise leak
  // their SW fetch routes and transport references in controller.frames
  useEffect(() => {
    return () => {
      destroyScramjetFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  /*
   * Capture-phase click listener inside the same-origin frame document:
   * any <a download> click becomes a streamed download through the proxy
   * instead of navigating the iframe. Both engines produce same-origin
   * frames, so this works for scramjet and the legacy rewriter alike.
   */
  const attachInterceptor = () => {
    const el = ref.current;
    const doc = el?.contentDocument;
    if (!doc) return;
    detachInterceptorRef.current?.();

    /* Build the same-origin URL that streams `displayUrl` through the
     * engine the frame is currently served by. Scramjet keeps raw external
     * hrefs on anchors (the SW intercepts navigation, not the attribute), so
     * the raw href cannot be fetched from the top window — the live frame's
     * own /~/sj/<prefix>/ must be prefixed. Rewritten attrs (img src, legacy
     // hrefs) are already same-origin and work as-is. */
    const buildFetchHref = (rawHref: string, displayUrl: string): string => {
      if (rawHref !== displayUrl) return rawHref; // already same-origin
      try {
        const loc = el?.contentWindow?.location?.href ?? "";
        const prefix = scramjetFramePrefix(loc);
        if (prefix) return prefix + encodeURIComponent(displayUrl);
      } catch {
        /* fall back to the raw href */
      }
      return rawHref;
    };

    const handler = (ev: Event) => {
      const mouse = ev as MouseEvent;
      if (ev.defaultPrevented || mouse.button !== 0 || mouse.altKey) return;
      const target = ev.target as Element | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.href;
      if (!href || href.startsWith("javascript:") || href === "about:blank") return;
      const downloadAttr = a.getAttribute("download");
      // Ctrl/Cmd+click opens a new tab like Chrome: background, or foreground
      // when Shift is held too. Downloads keep their own path below.
      if (downloadAttr === null && (mouse.ctrlKey || mouse.metaKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        const displayUrl = realUrlFromScramjet(href) ?? realUrlFromProxy(href) ?? href;
        onOpenTabRef.current?.(displayUrl, !mouse.shiftKey);
        return;
      }
      // search-routed SERP: outbound links (other hosts, or Bing's /ck/a
      // redirector) become explicit app navigations so they load through the
      // Scramjet engine — the legacy rewriter cannot carry JS-heavy sites.
      // Bing's own /search links (pagination, related searches, the SERP
      // search box) stay in-frame on the legacy proxy, which serves them
      // correctly.
      if (
        searchRoutedRef.current &&
        downloadAttr === null &&
        mouse.button === 0 &&
        !mouse.ctrlKey &&
        !mouse.metaKey &&
        !mouse.shiftKey &&
        !mouse.altKey
      ) {
        // a.href is the rewritten same-origin proxy URL in legacy frames —
        // resolve the REAL destination first, then classify it
        const displayUrl = realUrlFromScramjet(href) ?? realUrlFromProxy(href) ?? href;
        try {
          const u = new URL(displayUrl);
          const bingHost = u.hostname === "www.bing.com" || u.hostname === "bing.com";
          const outbound = !bingHost || u.pathname.startsWith("/ck/");
          if (outbound) {
            ev.preventDefault();
            ev.stopPropagation();
            onExplicitNavigateRef.current?.(displayUrl);
            return;
          }
        } catch {
          /* not a resolvable URL — let the frame navigate natively */
        }
      }
      if (downloadAttr === null) return; // only <a download> links from here
      ev.preventDefault();
      ev.stopPropagation();
      const displayUrl = realUrlFromScramjet(href) ?? realUrlFromProxy(href) ?? href;
      const fetchHref = buildFetchHref(href, displayUrl);
      onDownloadRef.current?.(fetchHref, downloadAttr || null, displayUrl, lastUrlRef.current || navUrl);
    };

    // middle-click on a link: new background tab (Chrome behavior)
    const auxHandler = (ev: Event) => {
      const mouse = ev as MouseEvent;
      if (ev.defaultPrevented || mouse.button !== 1) return;
      const target = ev.target as Element | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !a.href || a.href.startsWith("javascript:") || a.getAttribute("href") === "#") return;
      ev.preventDefault();
      ev.stopPropagation();
      const displayUrl = realUrlFromScramjet(a.href) ?? realUrlFromProxy(a.href) ?? a.href;
      onOpenTabRef.current?.(displayUrl, true);
    };

    // right-click -> page context menu (always suppressed inside frames so
    // OUR menu replaces the browser default; coordinates are translated from
    // the iframe viewport to the top window, accounting for CSS page zoom)
    const ctxHandler = (ev: Event) => {
      const mouse = ev as MouseEvent;
      const target = ev.target as Element | null;
      if (!target) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = el?.getBoundingClientRect();
      const z = zoomRef.current || 1;
      const payload: PageMenuTarget = {
        x: rect ? rect.left + mouse.clientX * z : mouse.clientX,
        y: rect ? rect.top + mouse.clientY * z : mouse.clientY,
        link: null,
        image: null,
        linkText: "",
      };
      const a = target.closest?.("a[href]") as HTMLAnchorElement | null;
      if (a && a.href && !a.href.startsWith("javascript:") && a.getAttribute("href") !== "#") {
        const displayUrl = realUrlFromScramjet(a.href) ?? realUrlFromProxy(a.href) ?? a.href;
        payload.link = { url: displayUrl, fetchHref: buildFetchHref(a.href, displayUrl) };
        payload.linkText = (a.textContent || "").trim().slice(0, 80);
      }
      const img = target.closest?.("img") as HTMLImageElement | null;
      if (img && img.src && !img.src.startsWith("data:")) {
        const displayUrl = realUrlFromScramjet(img.src) ?? realUrlFromProxy(img.src) ?? img.src;
        payload.image = { url: displayUrl, fetchHref: buildFetchHref(img.src, displayUrl) };
      }
      onPageMenuRef.current?.(payload);
    };

    /*
     * Keyboard bridge: keydown events stay inside the iframe window when the
     * page content has focus, which would kill every app-level shortcut.
     * Reserved combos (Ctrl+T/W/L/J/H/D, zoom, Alt+arrows, F5, Ctrl+R,
     * Ctrl+Shift+O/A, Ctrl+Alt+R) are captured BEFORE the page sees them —
     * like Chrome, which never delivers those to the page. Ctrl+F/P follow
     * Chrome's "page first" rule: forwarded at bubble phase only when the
     * page itself did not claim them.
     */
    const RESERVED_CTRL_KEYS = ["t", "w", "l", "j", "h", "d", "r"];
    const isReservedCombo = (e: KeyboardEvent): boolean => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const alt = e.altKey;
      if (alt && !ctrl && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
      if (e.key === "F5") return true;
      if (!ctrl) return false;
      if (alt) return !e.shiftKey && key === "r"; // Ctrl+Alt+R: reader mode
      if (e.shiftKey) return key === "o" || key === "a" || key === "t";
      return RESERVED_CTRL_KEYS.includes(key) || key === "+" || key === "=" || key === "-" || key === "0";
    };
    const forwardKey = (e: KeyboardEvent) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
        }),
      );
    };
    const keyCapture = (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (!isReservedCombo(e)) return;
      ev.preventDefault();
      ev.stopPropagation();
      forwardKey(e);
    };
    const keyBubble = (ev: Event) => {
      const e = ev as KeyboardEvent;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!ctrl || e.altKey || e.shiftKey) return;
      if (key !== "f" && key !== "p") return;
      if (ev.defaultPrevented) return; // the page claimed it (page first)
      ev.preventDefault();
      forwardKey(e);
    };

    /*
     * Search-routed frames (the legacy Bing homepage): a search-box form
     * submission is converted into an explicit app navigation, which lands
     * on the app's own results page instead of Bing's bot-filtered HTML
     * SERP. Bing's homepage search posts to /search with a q input.
     */
    const submitHandler = (ev: Event) => {
      if (!searchRoutedRef.current || ev.defaultPrevented) return;
      const form = ev.target as HTMLFormElement | null;
      if (!form || typeof form.submit !== "function") return;
      try {
        const action = form.getAttribute("action") || "";
        const base = el?.contentWindow?.location?.href ?? undefined;
        const abs = new URL(action || "search", base);
        const real = realUrlFromProxy(abs.href) ?? abs.href;
        const u = new URL(real);
        const bingHost = u.hostname === "www.bing.com" || u.hostname === "bing.com";
        if (!bingHost || u.pathname !== "/search") return; // not the search form
        const q = String(new FormData(form).get("q") || "").trim();
        if (!q) return; // let the page handle it
        ev.preventDefault();
        ev.stopPropagation();
        const target = new URL("https://www.bing.com/search");
        target.searchParams.set("q", q);
        onExplicitNavigateRef.current?.(target.href);
      } catch {
        /* not resolvable — let the form submit natively */
      }
    };

    doc.addEventListener("click", handler, true);
    doc.addEventListener("auxclick", auxHandler, true);
    doc.addEventListener("contextmenu", ctxHandler, true);
    doc.addEventListener("keydown", keyCapture, true);
    doc.addEventListener("keydown", keyBubble, false);
    doc.addEventListener("submit", submitHandler, true);
    detachInterceptorRef.current = () => {
      doc.removeEventListener("click", handler, true);
      doc.removeEventListener("auxclick", auxHandler, true);
      doc.removeEventListener("contextmenu", ctxHandler, true);
      doc.removeEventListener("keydown", keyCapture, true);
      doc.removeEventListener("keydown", keyBubble, false);
      doc.removeEventListener("submit", submitHandler, true);
    };
  };

  const handleLoad = () => {
    onLoad();
    const el = ref.current;
    if (!el) return;
    attachInterceptor();
    if (legacy) {
      try {
        const w = el.contentWindow;
        if (!w) return;
        const real = realUrlFromProxy(w.location.href);
        if (!real) return;
        const docTitle = w.document?.title ?? "";
        onNavRef.current(real, docTitle);
      } catch {
        /* about:blank or cross-origin blip */
      }
    } else {
      try {
        const docTitle = el.contentDocument?.title ?? "";
        if (docTitle) {
          onNavRef.current(lastUrlRef.current || navUrl, docTitle);
        }
      } catch {
        /* mid-navigation blip */
      }
    }
  };

  // scramjet needs full same-origin capabilities (real history API, popups
  // via the catch-escaped-links redirect, downloads); the legacy proxy keeps
  // its tighter sandbox.
  const sandboxAttr = legacy
    ? { sandbox: "allow-same-origin allow-scripts allow-forms allow-downloads" }
    : {};

  return (
    <iframe
      ref={ref}
      title={title || tabId}
      onLoad={handleLoad}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      {...sandboxAttr}
      style={zoom !== 1 ? { zoom } : undefined}
      className="h-full w-full border-0 bg-white"
    />
  );
}
