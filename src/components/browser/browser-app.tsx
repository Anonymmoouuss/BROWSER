"use client";

/**
 * BrowserApp — top-level orchestrator for the Chrome-style browser.
 *
 * Owns the tab state machine (with per-tab back/forward stacks), session
 * restore, history/bookmarks persistence, the frame registry (tabId ->
 * iframe element, used for same-origin history control and page-JS eval),
 * and the navigation message bridge (injected reporter scripts postMessage
 * {__cwNav, url, title} -> matched back to the owning tab).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Code2, FolderOpen, Loader2, Star } from "lucide-react";
import TabStrip from "./tab-strip";
import Toolbar from "./toolbar";
import FrameView from "./frame-view";
import NewTabPage from "./new-tab-page";
import HistoryPage from "./history-page";
import BookmarksPage from "./bookmarks-page";
import DownloadsPage from "./downloads-page";
import DownloadsShelf from "./downloads-shelf";
import ConfigPage from "./config-page";
import ExtensionsPage from "./extensions-page";
import SearchResultsPage from "./search-results-page";
import PageContextMenu from "./page-context-menu";
import FindBar from "./find-bar";
import ReaderView from "./reader-view";
import TabSearch from "./tab-search";
import ConsolePanel from "./console-panel";
import StatusBar from "./status-bar";
import { useConsoleWs } from "@/hooks/use-console-ws";
import { getScramjetEngine, type EngineState } from "@/lib/browser/scramjet";
import { getSiteZoom, setSiteZoom } from "@/lib/browser/site-zoom";
import { isBookmarklet, pageScriptError, runPageScript } from "@/lib/browser/bookmarklets";
import {
  cancelDownload,
  clearDownloads,
  dismissShelf,
  removeDownload,
  resumeDownload,
  startDownload,
  useDownloads,
  type DownloadItem,
} from "@/lib/browser/downloads";
import { printFrameWindow } from "@/lib/browser/print";
import {
  BOOKMARKS_KEY,
  CONSOLE_KEY,
  HISTORY_KEY,
  SESSION_KEY,
  hostOf,
  isInternalUrl,
  isLegacyRoutedUrl,
  loadJson,
  localeEnrichedUrl,
  newTab,
  normalizeInput,
  proxyUrl,
  saveJson,
  searchQueryFromUrl,
  zoomIn,
  zoomOut,
  type Bookmark,
  type HistoryEntry,
  type PageMenuTarget,
  type Tab,
} from "@/lib/browser/shared";

export default function BrowserApp({ onLock }: { onLock?: () => void }) {
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
  const closedTabs = useRef<Tab[]>([]);
  const [canReopenTab, setCanReopenTab] = useState(false);
  const [activeId, setActiveId] = useState<string>("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [pageMenu, setPageMenu] = useState<PageMenuTarget | null>(null);
  const [tabSearchOpen, setTabSearchOpen] = useState(false);
  const [flashIds, setFlashIds] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [engine, setEngine] = useState<EngineState>("booting");
  /**
   * Frame-history alignment per tab: the live iframe only holds session
   * entries created AFTER it booted. `boot` = app-stack index the frame
   * booted on, `max` = highest index the frame has reached. Back below the
   * boot point (restored / duplicated tabs) and forward beyond the max walk
   * the APP stack with an explicit navigation instead of history.back().
   */
  const frameAlign = useRef(new Map<string, { boot: number; max: number }>());

  const iframesRef = useRef(new Map<string, HTMLIFrameElement>());
  // mirror of the tabs state for same-tick mutations (e.g. scripted/test
  // closures of several tabs at once) — kept in sync after every render and
  // eagerly on write so closeTab never computes from a stale snapshot
  const tabsRef = useRef<Tab[]>(tabs);
  const activeIdRef = useRef("");
  useEffect(() => {
    tabsRef.current = tabs;
  });
  const consoleApi = useConsoleWs(consoleOpen);
  const downloads = useDownloads();

  /* ---------- engine boot (scramjet with legacy fallback) ---------- */
  useEffect(() => {
    let alive = true;
    getScramjetEngine().then((controller) => {
      if (!alive) return;
      setEngine(controller ? "scramjet" : "legacy");
    });
    return () => {
      alive = false;
    };
  }, []);

  /* ---------- hydrate persisted state (after mount, once) ---------- */
  useEffect(() => {
    const t = setTimeout(() => {
      const session = loadJson<{ tabs: Tab[]; activeId: string } | null>(SESSION_KEY, null);
      if (session && Array.isArray(session.tabs) && session.tabs.length) {
        const restored = session.tabs.map((t2) => ({
          ...t2,
          loading: false,
          history: Array.isArray(t2.history) ? t2.history : [],
          hIndex: typeof t2.hIndex === "number" ? t2.hIndex : -1,
          navSeq: typeof t2.navSeq === "number" ? t2.navSeq : t2.url ? 1 : 0,
          navUrl: t2.navUrl ?? t2.url,
          zoom: typeof t2.zoom === "number" && t2.zoom > 0 ? t2.zoom : 1,
        }));
        setTabs(restored);
        setActiveId(restored.some((x) => x.id === session.activeId) ? session.activeId : restored[0].id);
        // restored frames boot fresh: their session history only has the
        // current entry, so anything below the restored hIndex needs the
        // explicit stack walk
        for (const r of restored) frameAlign.current.set(r.id, { boot: r.hIndex, max: r.hIndex });
      }
      setBookmarks(loadJson<Bookmark[]>(BOOKMARKS_KEY, []));
      setHistoryList(loadJson<HistoryEntry[]>(HISTORY_KEY, []));
      setConsoleOpen(loadJson<boolean>(CONSOLE_KEY, false));
      setHydrated(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // derived: the effective active tab id (falls back to the first tab)
  const effectiveActiveId = tabs.some((t) => t.id === activeId) ? activeId : (tabs[0]?.id ?? "");

  // keep the alignment tracker's max in sync as tabs navigate (in-frame navs
  // and explicit pushes grow hIndex; cuts never re-enable forward, so max
  // only ever grows within a frame lifecycle)
  useEffect(() => {
    for (const t of tabs) {
      const a = frameAlign.current.get(t.id);
      if (a && t.hIndex > a.max) a.max = t.hIndex;
    }
  }, [tabs]);
  useEffect(() => {
    activeIdRef.current = effectiveActiveId;
  });
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === effectiveActiveId) ?? tabs[0],
    [tabs, effectiveActiveId],
  );

  /* ---------- session persistence (debounced, post-hydration only) ---------- */
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => saveJson(SESSION_KEY, { tabs, activeId: effectiveActiveId }), 400);
    return () => clearTimeout(t);
  }, [tabs, effectiveActiveId, hydrated]);

  /* ---------- history / bookmarks ---------- */
  const addHistory = useCallback((url: string, title?: string) => {
    if (url.startsWith("about:")) return; // internal pages never enter browsing history
    // canonical key ignores a trailing slash: the omnibox stores "https://x"
    // while the frame later reports "https://x/" — same page, one entry.
    const key = (u: string) => u.replace(/\/+$/, "");
    setHistoryList((prev) => {
      const trimmed = title?.trim();
      if (prev[0] && key(prev[0].url) === key(url)) {
        // Same page revisited (or its title arriving late from the frame
        // reporter / title poll): keep the entry in place, backfill a real
        // title over the URL fallback and prefer the fuller URL form.
        const p0 = prev[0];
        const titleIsFallback = !p0.title || key(p0.title) === key(p0.url);
        const nextTitle = trimmed && titleIsFallback ? trimmed : p0.title;
        const nextUrl = url.length > p0.url.length ? url : p0.url;
        if (nextTitle === p0.title && nextUrl === p0.url) return prev;
        const next = [{ ...p0, url: nextUrl, title: nextTitle }, ...prev.slice(1)];
        saveJson(HISTORY_KEY, next);
        return next;
      }
      const next = [{ url, title: title || url, ts: Date.now() }, ...prev.filter((h) => key(h.url) !== key(url))].slice(0, 200);
      saveJson(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const deleteHistoryEntry = useCallback((url: string) => {
    setHistoryList((prev) => {
      const next = prev.filter((h) => h.url !== url);
      saveJson(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistoryList([]);
    saveJson(HISTORY_KEY, []);
  }, []);

  const toggleBookmark = useCallback(() => {
    const url = activeTab?.url;
    if (!url) return;
    setBookmarks((prev) => {
      const exists = prev.some((b) => b.url === url);
      const next = exists
        ? prev.filter((b) => b.url !== url)
        : [{ url, title: activeTab.title || url }, ...prev].slice(0, 40);
      saveJson(BOOKMARKS_KEY, next);
      toast[exists ? "info" : "success"](exists ? "Bookmark removed" : "Bookmark added");
      return next;
    });
  }, [activeTab]);

  const removeBookmark = useCallback((url: string) => {
    setBookmarks((prev) => {
      const next = prev.filter((b) => b.url !== url);
      saveJson(BOOKMARKS_KEY, next);
      return next;
    });
  }, []);

  const saveBookmark = useCallback((originalUrl: string | null, bookmark: Bookmark) => {
    setBookmarks((prev) => {
      const next = [bookmark, ...prev.filter((entry) => entry.url !== originalUrl && entry.url !== bookmark.url)].slice(0, 40);
      saveJson(BOOKMARKS_KEY, next);
      return next;
    });
  }, []);

  const runBookmarklet = useCallback(async (bookmark: Bookmark, targetId: string) => {
    const target = tabsRef.current.find((tab) => tab.id === targetId);
    const frame = iframesRef.current.get(targetId);
    if (!target || !frame || !target.url || isInternalUrl(target.url) || searchQueryFromUrl(target.url)) {
      toast.error("Open a web page before running a bookmarklet");
      return;
    }
    if (!window.confirm(`Run “${bookmark.title}” on ${target.title}?\n\nOnly run JavaScript you trust. It can read or change this page.`)) return;
    try {
      setActiveId(targetId);
      await runPageScript(frame, bookmark.url);
      toast.success(`Ran ${bookmark.title}`);
    } catch (error) {
      toast.error(pageScriptError(error));
    }
  }, []);

  const clearBookmarks = useCallback(() => {
    setBookmarks([]);
    saveJson(BOOKMARKS_KEY, []);
  }, []);

  /** about:config: close everything and start from a clean new tab. */
  const resetSession = useCallback(() => {
    iframesRef.current.clear();
    frameAlign.current.clear();
    const t = newTab();
    setTabs([t]);
    setActiveId(t.id);
    setFindOpen(false);
    setPageMenu(null);
  }, []);

  /* ---------- navigation ---------- */

  /** Explicit navigation from omnibox / quick links / home. */
  const navigate = useCallback(
    (tabId: string, input: string) => {
      const url = localeEnrichedUrl(normalizeInput(input) ?? "");
      if (!url) return;
      const internal = isInternalUrl(url);
      const searchQ = searchQueryFromUrl(url);
      if (internal || searchQ) setReaderOpen(false);
      const siteZ = internal ? null : getSiteZoom(hostOf(url));
      setTabs((ts) =>
        ts.map((t) => {
          if (t.id !== tabId) return t;
          const history = [...t.history.slice(0, t.hIndex + 1), url];
          return {
            ...t,
            url,
            navUrl: url,
            navSeq: t.navSeq + 1,
            title: internal
              ? url
              : searchQ
                ? `${searchQ} - Bing`
                : t.title === "New tab"
                  ? url.replace(/^https?:\/\//, "").split("/")[0]
                  : t.title,
            // search results pages are internal components that manage
            // their own loading state — no tab spinner for them
            loading: !internal && !searchQ,
            zoom: internal ? t.zoom : siteZ ?? 1,
            history,
            hIndex: history.length - 1,
          };
        }),
      );
      // explicit navigations re-baseline the frame-history alignment (the
      // frame gets one fresh entry for this URL; earlier entries are dead)
      const cur = tabsRef.current.find((t) => t.id === tabId);
      if (cur) frameAlign.current.set(tabId, { boot: cur.hIndex + 1, max: cur.hIndex + 1 });
      addHistory(url);
    },
    [addHistory],
  );

  /** In-frame navigation report (link clicks, redirects, pushState). */
  const handleFrameNav = useCallback(
    (tabId: string, url: string, title: string) => {
      if (!url) return;
      setTabs((ts) =>
        ts.map((t) => {
          if (t.id !== tabId) return t;
          if (url === t.url) {
            return t.title !== title && title ? { ...t, title } : t;
          }
          // Chrome-style per-site zoom: a navigation that lands on a new host
          // adopts that host's remembered level (or 100%)
          const nextHost = hostOf(url);
          const prevHost = t.url ? hostOf(t.url) : null;
          const zoom = nextHost && nextHost !== prevHost ? getSiteZoom(nextHost) ?? 1 : t.zoom;
          const hist = t.history;
          let hIndex = t.hIndex;
          if (hIndex > 0 && hist[hIndex - 1] === url) hIndex -= 1;
          else if (hIndex < hist.length - 1 && hist[hIndex + 1] === url) hIndex += 1;
          else {
            const cut = [...hist.slice(0, hIndex + 1), url];
            return { ...t, url, title: title || t.title, zoom, history: cut, hIndex: cut.length - 1, loading: false };
          }
          return { ...t, url, title: title || t.title, zoom, hIndex, loading: false };
        }),
      );
      addHistory(url, title || undefined);
    },
    [addHistory],
  );

  const handleFrameLoad = useCallback((tabId: string) => {
    setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, loading: false } : t)));
  }, []);

  /* ---------- navigation watchdog ----------
   * A site the sandbox network silently drops (SYN-filtered hosts) can leave
   * the Scramjet transport waiting on TCP for minutes — the tab spinner and
   * the reload button would spin the whole time. Chrome gives up after ~30s;
   * we stop the spinner after 25s so the UI stays truthful (the frame keeps
   * loading in the background and reports normally if it ever completes). */
  const loadingIds = tabs.filter((t) => t.loading).map((t) => t.id).join(",");
  useEffect(() => {
    if (!loadingIds) return;
    const t = setTimeout(() => {
      setTabs((ts) => ts.map((x) => (x.loading ? { ...x, loading: false } : x)));
    }, 25_000);
    return () => clearTimeout(t);
  }, [loadingIds]);

  /* ---------- popup escape + handoff (this window IS the popup) ---------- */
  // When a proxied page opens a popup, the engine serves the proxied site in
  // the popup directly (like a real "open in new window"). Two defensive
  // paths below make sure this app never ends up nested inside its own proxy
  // and that a /?taburl=<real url> landing (from the escape path or future
  // integrations) becomes a tab in the opener window.
  const bootPopupHandoff = useRef(false);

  /* ---------- tab management ---------- */
  const openNewTab = useCallback(() => {
    const t = newTab();
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
  }, []);

  /** Drag-to-reorder: move `fromId` before/after `toId` (tab strip DnD). */
  const reorderTab = useCallback((fromId: string, toId: string, side: "left" | "right") => {
    setTabs((ts) => {
      const from = ts.findIndex((t) => t.id === fromId);
      const to = ts.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return ts;
      const next = [...ts];
      const [moved] = next.splice(from, 1);
      const insertAt = next.findIndex((t) => t.id === toId) + (side === "right" ? 1 : 0);
      next.splice(insertAt, 0, moved);
      return next;
    });
  }, []);

  /** Open a URL in a brand-new tab (quick links, popups, target=_blank,
   *  middle-click / Ctrl+click). `background` keeps the current tab active,
   *  exactly like Chrome's middle-click and context-menu behavior. */
  const openUrlTab = useCallback(
    (url: string, opts?: { background?: boolean }) => {
      const target = localeEnrichedUrl(normalizeInput(url) ?? "");
      if (!target) return;
      const searchQ = searchQueryFromUrl(target);
      if (isInternalUrl(target) || searchQ) setReaderOpen(false);
      const t = newTab();
      setTabs((ts) => [
        ...ts,
        {
          ...t,
          url: target,
          navUrl: target,
          navSeq: 1,
          title: searchQ
            ? `${searchQ} - Bing`
            : target.startsWith("about:")
              ? target
              : target.replace(/^https?:\/\//, "").split("/")[0],
          loading: !searchQ && !isInternalUrl(target),
          zoom: getSiteZoom(hostOf(target)) ?? 1,
          history: [target],
          hIndex: 0,
        },
      ]);
      frameAlign.current.set(t.id, { boot: 0, max: 0 });
      if (!opts?.background) setActiveId(t.id);
      else {
        // Chrome-style affordance: the new tab's title flashes in the strip
        // so the user notices it without focus being stolen
        setFlashIds((f) => [...f, t.id]);
        setTimeout(() => setFlashIds((f) => f.filter((id) => id !== t.id)), 3600);
      }
      addHistory(target);
    },
    [addHistory],
  );

  // popup escape/handoff runs once, after openUrlTab exists (see the comment
  // block above for the full story)
  useEffect(() => {
    if (bootPopupHandoff.current) return;
    bootPopupHandoff.current = true;

    // 1) Nested-instance escape: if a proxied page ever navigates a window to
    //    this app *through* the engine itself (real pathname under the /~/sj/
    //    frame prefix), a nested app cannot browse (inner frame prefixes
    //    would not match the outer path). Escape: recover the intended URL
    //    from the encoded path, hand it to the opener's tab strip, and close;
    //    otherwise restart this window as a clean top-level browser.
    if (window.location.pathname.startsWith("/~/sj/")) {
      let handoffUrl: string | null = null;
      try {
        const m = window.location.pathname.match(/^\/~\/sj\/[^/]+\/(.*)$/);
        if (m) {
          const inner = new URL(decodeURIComponent(m[1]), window.location.origin);
          handoffUrl = inner.searchParams.get("taburl");
        }
      } catch {
        handoffUrl = null;
      }
      let target: Window | null = null;
      try {
        const opener = window.opener as Window | null;
        target = opener?.top ?? opener ?? null;
      } catch {
        target = null;
      }
      if (handoffUrl && target) {
        try {
          target.postMessage({ __sjPopup: 1, url: handoffUrl }, window.location.origin);
          setTimeout(() => {
            if (!window.closed) window.location.replace("/");
          }, 400);
          window.close();
          return;
        } catch {
          /* fall through to a clean restart */
        }
      }
      window.location.replace(handoffUrl ? `/?taburl=${encodeURIComponent(handoffUrl)}` : "/");
      return;
    }

    // 2) Direct taburl handoff: a popup that lands on /?taburl=<real url>
    //    forwards the URL to the opener's tab strip and closes; when closing
    //    is blocked (user-opened tab), the URL opens here instead so nothing
    //    is ever lost.
    const params = new URLSearchParams(window.location.search);
    const taburl = params.get("taburl");
    if (!taburl) return;
    window.history.replaceState(null, "", "/");
    let target: Window | null = null;
    try {
      const opener = window.opener as Window | null;
      target = opener?.top ?? opener ?? null;
    } catch {
      target = null;
    }
    if (target) {
      try {
        target.postMessage({ __sjPopup: 1, url: taburl }, window.location.origin);
      } catch {
        target = null;
      }
    }
    if (target) {
      setTimeout(() => {
        if (!window.closed) openUrlTab(taburl);
      }, 400);
      window.close();
    } else {
      // no reachable opener: keep browsing in this window (deferred a task so
      // the tab is created after paint, not synchronously inside the effect)
      setTimeout(() => openUrlTab(taburl), 0);
    }
  }, [openUrlTab]);

  /* ---------- navigation message bridge ---------- */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { __cwNav?: number; __sjPopup?: number; url?: string; title?: string } | null;
      if (!data || typeof data !== "object") return;
      // legacy-proxy reporter script: in-frame navigation of an existing tab
      if (data.__cwNav === 1) {
        for (const [id, el] of iframesRef.current) {
          if (el.contentWindow === e.source) {
            handleFrameNav(id, data.url ?? "", data.title ?? "");
            return;
          }
        }
        return;
      }
      // scramjet catch-escaped-links popup: a proxied page opened a popup
      // (window.open / target=_blank) which got 302'd to /?taburl=...; that
      // popup instance of the app hands the URL back to the main window.
      if (data.__sjPopup === 1 && data.url) {
        openUrlTab(data.url);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleFrameNav, openUrlTab]);

  const rememberClosedTabs = useCallback((closing: Tab[]) => {
    closedTabs.current = [...closing].reverse().concat(closedTabs.current).slice(0, 20);
    setCanReopenTab(closedTabs.current.length > 0);
  }, []);

  const reopenClosedTab = useCallback(() => {
    const closed = closedTabs.current.shift();
    setCanReopenTab(closedTabs.current.length > 0);
    if (!closed) return;
    const restored: Tab = {
      ...closed,
      id: newTab().id,
      navUrl: closed.url,
      navSeq: closed.url ? 1 : 0,
      loading: !!closed.url && !isInternalUrl(closed.url) && !searchQueryFromUrl(closed.url),
      history: [...closed.history],
    };
    const next = [...tabsRef.current, restored];
    tabsRef.current = next;
    setTabs(next);
    activeIdRef.current = restored.id;
    setActiveId(restored.id);
    frameAlign.current.set(restored.id, { boot: restored.hIndex, max: restored.hIndex });
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      iframesRef.current.delete(tabId);
      frameAlign.current.delete(tabId);
      const ts = tabsRef.current;
      const idx = ts.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      rememberClosedTabs([ts[idx]]);
      const next = ts.filter((t) => t.id !== tabId);
      if (!next.length) {
        const t = newTab();
        tabsRef.current = [t];
        setTabs([t]);
        setActiveId(t.id);
        return;
      }
      tabsRef.current = next;
      setTabs(next);
      const active = activeIdRef.current;
      if (tabId === active || !next.some((t) => t.id === active)) {
        const na = next[Math.min(idx, next.length - 1)].id;
        activeIdRef.current = na;
        setActiveId(na);
      }
    },
    [rememberClosedTabs],
  );

  /* ---------- history controls (real iframe history, same-origin) ---------- */
  const goBack = useCallback(() => {
    const t = activeTab;
    if (!t || t.hIndex <= 0) return;
    const frame = iframesRef.current.get(t.id);
    const align = frameAlign.current.get(t.id);
    const target = t.hIndex - 1;
    // no live iframe (internal page, engine booting), or the target sits
    // below the frame's boot point (restored / duplicated tabs — their
    // session history only contains entries created after the frame booted):
    // walk the tab's own stack with an explicit navigation, like Chrome does
    // a full load after a restart
    if (!frame || isInternalUrl(t.url) || (align && target < align.boot)) {
      const prev = t.history[target];
      if (!prev) return;
      frameAlign.current.set(t.id, { boot: target, max: target });
      setTabs((ts) =>
        ts.map((x) =>
          x.id === t.id
            ? {
                ...x,
                url: prev,
                navUrl: prev,
                navSeq: x.navSeq + 1,
                title: isInternalUrl(prev) ? prev : x.title === "New tab" ? prev.replace(/^https?:\/\//, "").split("/")[0] : x.title,
                loading: !isInternalUrl(prev),
                zoom: isInternalUrl(prev) ? x.zoom : getSiteZoom(hostOf(prev)) ?? 1,
                hIndex: target,
              }
            : x,
        ),
      );
      if (!isInternalUrl(prev)) addHistory(prev);
      return;
    }
    try {
      frame.contentWindow?.history.back();
    } catch {
      /* cross-origin blip */
    }
  }, [activeTab, addHistory]);

  const goForward = useCallback(() => {
    const t = activeTab;
    if (!t || t.hIndex >= t.history.length - 1) return;
    const frame = iframesRef.current.get(t.id);
    const align = frameAlign.current.get(t.id);
    const target = t.hIndex + 1;
    // mirror of goBack: forward beyond the frame's reach (restored tabs, or
    // re-forwarding after an explicit stack walk) reloads the entry
    if (!frame || isInternalUrl(t.url) || (align && target > align.max)) {
      const next = t.history[target];
      if (!next) return;
      frameAlign.current.set(t.id, { boot: target, max: target });
      setTabs((ts) =>
        ts.map((x) =>
          x.id === t.id
            ? {
                ...x,
                url: next,
                navUrl: next,
                navSeq: x.navSeq + 1,
                title: isInternalUrl(next) ? next : x.title === "New tab" ? next.replace(/^https?:\/\//, "").split("/")[0] : x.title,
                loading: !isInternalUrl(next),
                zoom: isInternalUrl(next) ? x.zoom : getSiteZoom(hostOf(next)) ?? 1,
                hIndex: target,
              }
            : x,
        ),
      );
      if (!isInternalUrl(next)) addHistory(next);
      return;
    }
    try {
      frame.contentWindow?.history.forward();
    } catch {
      /* cross-origin blip */
    }
  }, [activeTab, addHistory]);

  const reload = useCallback(() => {
    const t = activeTab;
    if (!t || !t.url) return;
    // internal pages (about:history...) have no iframe — just re-render them
    if (isInternalUrl(t.url) || searchQueryFromUrl(t.url)) {
      setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, navSeq: x.navSeq + 1, loading: false } : x)));
      return;
    }
    setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, loading: true } : x)));
    const frame = iframesRef.current.get(t.id);
    if (!frame?.contentWindow) {
      setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, navSeq: x.navSeq + 1 } : x)));
      return;
    }
    try {
      frame.contentWindow.location.reload();
    } catch {
      setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, navSeq: x.navSeq + 1 } : x)));
    }
  }, [activeTab]);

  const goHome = useCallback(() => {
    const t = activeTab;
    if (!t) return;
    setReaderOpen(false);
    setTabs((ts) =>
      ts.map((x) =>
        x.id === t.id
          ? { ...x, url: null, navUrl: null, navSeq: x.navSeq + 1, title: "New tab", loading: false, history: [], hIndex: -1 }
          : x,
      ),
    );
  }, [activeTab]);

  /* ---------- zoom (Chrome-style ladder, remembered per site) ---------- */
  const setZoom = useCallback((tabId: string, next: number) => {
    setTabs((ts) => ts.map((x) => (x.id === tabId ? { ...x, zoom: next } : x)));
  }, []);

  const zoomActive = useCallback(
    (dir: "in" | "out" | "reset") => {
      const t = activeTab;
      if (!t) return;
      const next = dir === "reset" ? 1 : dir === "in" ? zoomIn(t.zoom) : zoomOut(t.zoom);
      if (next === t.zoom) return;
      // real page: remember the level for the whole host and propagate it to
      // every open tab on that host (Chrome behavior). Reset also clears the
      // remembered level.
      const host = t.url && !isInternalUrl(t.url) ? hostOf(t.url) : null;
      if (host) {
        setSiteZoom(host, next);
        setTabs((ts) =>
          ts.map((x) =>
            x.url && !isInternalUrl(x.url) && hostOf(x.url) === host ? { ...x, zoom: next } : x,
          ),
        );
        return;
      }
      setZoom(t.id, next); // internal / new-tab page: this tab only
    },
    [activeTab, setZoom],
  );

  /* ---------- tab context menu actions ---------- */
  const duplicateTab = useCallback(
    (tabId: string) => {
      const src = tabs.find((t) => t.id === tabId);
      if (!src) return;
      const idx = tabs.findIndex((t) => t.id === tabId);
      const copy: Tab = {
        ...newTab(),
        url: src.url,
        navUrl: src.navUrl,
        navSeq: src.navUrl ? 1 : 0,
        title: src.title,
        loading: !!src.url && !isInternalUrl(src.url),
        zoom: src.zoom,
        history: src.url ? [...src.history] : [],
        hIndex: src.url ? src.hIndex : -1,
      };
      setTabs((ts) => [...ts.slice(0, idx + 1), copy, ...ts.slice(idx + 1)]);
      setActiveId(copy.id);
      // the duplicate boots a fresh frame at the current position: earlier
      // stack entries are beyond the frame session history
      frameAlign.current.set(copy.id, { boot: copy.hIndex, max: copy.hIndex });
    },
    [tabs],
  );

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      const keep = tabs.find((t) => t.id === tabId);
      if (!keep) return;
      rememberClosedTabs(tabs.filter((tab) => tab.id !== tabId));
      for (const t of tabs) if (t.id !== tabId) {
        iframesRef.current.delete(t.id);
        frameAlign.current.delete(t.id);
      }
      setTabs([keep]);
      setActiveId(keep.id);
    },
    [tabs, rememberClosedTabs],
  );

  const closeTabsToRight = useCallback(
    (tabId: string) => {
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      rememberClosedTabs(tabs.slice(idx + 1));
      for (const t of tabs.slice(idx + 1)) {
        iframesRef.current.delete(t.id);
        frameAlign.current.delete(t.id);
      }
      const next = tabs.slice(0, idx + 1);
      setTabs(next);
      if (!next.some((t) => t.id === effectiveActiveId)) setActiveId(next[next.length - 1].id);
    },
    [tabs, effectiveActiveId, rememberClosedTabs],
  );

  const reloadTab = useCallback((tabId: string) => {
    if (effectiveActiveId === tabId) {
      reload();
      return;
    }
    // background tab: bump navSeq so its FrameView reloads when it mounts
    setTabs((ts) => ts.map((x) => (x.id === tabId ? { ...x, navSeq: x.navSeq + 1, loading: !!x.url && !isInternalUrl(x.url) } : x)));
  }, [effectiveActiveId, reload]);

  /* ---------- console ---------- */
  const toggleConsole = useCallback(() => {
    setConsoleOpen((v) => {
      saveJson(CONSOLE_KEY, !v);
      return !v;
    });
  }, []);

  /* ---------- find in page ---------- */
  const toggleFind = useCallback(() => {
    setFindOpen((v) => !v);
  }, []);

  /* ---------- reader mode ---------- */
  const toggleReader = useCallback(() => {
    setReaderOpen((v) => !v);
  }, []);

  // the reader only exists for real web pages: its visibility is derived, and
  // the flag itself is cleared on any action that leaves web-page territory
  const readerVisible = readerOpen && !!activeTab?.url && !isInternalUrl(activeTab.url);

  /* ---------- page context menu ---------- */
  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Copied to clipboard", { description: text.slice(0, 80) }))
      .catch(() => toast.error("Copy failed", { description: "The clipboard is unavailable in this context" }));
  }, []);

  const getActiveFrameDoc = useCallback((): Document | null => {
    const id = effectiveActiveId;
    if (!id) return null;
    try {
      return iframesRef.current.get(id)?.contentDocument ?? null;
    } catch {
      return null;
    }
  }, [effectiveActiveId]);

  const getFrameWindow = useCallback(
    () =>
      (effectiveActiveId ? iframesRef.current.get(effectiveActiveId)?.contentWindow ?? null : null) as
        | (Window & typeof globalThis)
        | null,
    [effectiveActiveId],
  );

  /* ---------- keyboard shortcuts ---------- */

  // Print the active page: the reader prints its clean article, web frames
  // print as rendered, everything else explains why it cannot print.
  const printActive = useCallback(() => {
    if (readerOpen) {
      window.dispatchEvent(new CustomEvent("cw-print-reader"));
      return;
    }
    if (!activeTab?.url || isInternalUrl(activeTab.url)) {
      toast.info("Only web pages can be printed");
      return;
    }
    const ok = printFrameWindow(getFrameWindow());
    if (!ok) toast.error("Printing is not available for this page");
  }, [readerOpen, activeTab, getFrameWindow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const inEditable =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "l") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("cw-focus-omnibox"));
      } else if (e.altKey && (e.key.toLowerCase() === "d" || e.key === "F6")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("cw-focus-omnibox"));
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setTabSearchOpen((v) => !v);
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        reopenClosedTab();
      } else if (ctrl && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (activeTab?.url && !isInternalUrl(activeTab.url)) setFindOpen(true);
      } else if (ctrl && e.key.toLowerCase() === "p") {
        e.preventDefault();
        printActive();
      } else if (e.key === "Escape" && tabSearchOpen) {
        setTabSearchOpen(false);
      } else if (e.key === "Escape" && findOpen) {
        setFindOpen(false);
      } else if (ctrl && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        zoomActive("in");
      } else if (ctrl && e.key === "-") {
        e.preventDefault();
        zoomActive("out");
      } else if (ctrl && e.key === "0") {
        e.preventDefault();
        zoomActive("reset");
      } else if (ctrl && e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (activeTab?.url && !isInternalUrl(activeTab.url)) setReaderOpen((v) => !v);
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openUrlTab("about:bookmarks");
      } else if (ctrl && e.key.toLowerCase() === "h") {
        e.preventDefault();
        openUrlTab("about:history");
      } else if (ctrl && e.key.toLowerCase() === "j") {
        e.preventDefault();
        openUrlTab("about:downloads");
      } else if (ctrl && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (activeTab?.url && !isInternalUrl(activeTab.url)) toggleBookmark();
      } else if (!inEditable && e.key === "`") {
        e.preventDefault();
        toggleConsole();
      } else if (!inEditable && e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      } else if (!inEditable && e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
      } else if (!inEditable && ctrl && e.key.toLowerCase() === "t") {
        e.preventDefault();
        openNewTab();
      } else if (!inEditable && ctrl && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeTab) closeTab(activeTab.id);
      } else if (!inEditable && e.key === "F5") {
        e.preventDefault();
        reload();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleConsole, goBack, goForward, findOpen, tabSearchOpen, printActive, activeTab, openNewTab, closeTab, reopenClosedTab, reload, zoomActive, openUrlTab, toggleBookmark]);

  /* ---------- render ---------- */

  // Ctrl+wheel zoom over the viewport (needs a non-passive native listener,
  // React's onWheel is passive)
  const viewportRef = useRef<HTMLElement | null>(null);
  const zoomActiveRef = useRef(zoomActive);
  useEffect(() => {
    zoomActiveRef.current = zoomActive;
  }, [zoomActive]);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomActiveRef.current(e.deltaY < 0 ? "in" : "out");
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (!activeTab) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" role="status" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      <TabStrip
        tabs={tabs}
        activeId={activeTab.id}
        flashIds={flashIds}
        onSelect={setActiveId}
        onClose={closeTab}
        onNew={openNewTab}
        onReload={reloadTab}
        onDuplicate={duplicateTab}
        onCloseOthers={closeOtherTabs}
        onCloseRight={closeTabsToRight}
        onReorder={reorderTab}
        onSearchTabs={() => setTabSearchOpen(true)}
      />

      <Toolbar
        canBack={activeTab.hIndex > 0}
        canFwd={activeTab.hIndex < activeTab.history.length - 1}
        loading={activeTab.loading}
        url={activeTab.url}
        onBack={goBack}
        onFwd={goForward}
        onReload={reload}
        onHome={goHome}
        onNavigate={(input) => navigate(activeTab.id, input)}
        onToggleConsole={toggleConsole}
        consoleOpen={consoleOpen}
        onToggleFind={toggleFind}
        findOpen={findOpen}
        bookmarked={!!activeTab.url && bookmarks.some((b) => b.url === activeTab.url)}
        onToggleBookmark={toggleBookmark}
        history={historyList}
        bookmarks={bookmarks.filter((bookmark) => !isBookmarklet(bookmark.url))}
        onOpenDownloads={() => openUrlTab("about:downloads")}
        downloadsActive={downloads.anyActive}
        onNewTab={openNewTab}
        canReopenTab={canReopenTab}
        onReopenTab={reopenClosedTab}
        onOpenHistory={() => openUrlTab("about:history")}
        onOpenBookmarks={() => openUrlTab("about:bookmarks")}
        onOpenSettings={() => openUrlTab("about:config")}
        onOpenExtensions={() => openUrlTab("about:extensions")}
        onZoomIn={() => zoomActive("in")}
        onZoomOut={() => zoomActive("out")}
        onZoomReset={() => zoomActive("reset")}
        zoom={activeTab.zoom}
        onToggleReader={toggleReader}
        onPrint={printActive}
      />

      {bookmarks.length > 0 && <nav aria-label="Bookmarks bar" className="cw-scroll flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--browser-border)] bg-[var(--browser-toolbar)] px-3">
        <button type="button" onClick={() => openUrlTab("about:bookmarks")} aria-label="Manage bookmarks" title="Manage bookmarks" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"><FolderOpen className="h-3.5 w-3.5" aria-hidden="true" /></button>
        <span className="mx-1 h-4 w-px shrink-0 bg-zinc-800" aria-hidden="true" />
        {bookmarks.map((bookmark) => {
          const script = isBookmarklet(bookmark.url);
          const unavailable = script && (!activeTab.url || isInternalUrl(activeTab.url) || !!searchQueryFromUrl(activeTab.url));
          return <button key={bookmark.url} type="button" disabled={unavailable} onClick={() => script ? void runBookmarklet(bookmark, activeTab.id) : navigate(activeTab.id, bookmark.url)} aria-label={script ? `Run ${bookmark.title}` : `Open ${bookmark.title}`} title={script ? `Run ${bookmark.title}` : bookmark.url} className="inline-flex h-7 max-w-40 shrink-0 items-center gap-2 rounded-md px-2 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-35">
            {script ? <Code2 className="h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden="true" /> : <Star className="h-3 w-3 shrink-0 text-amber-300" aria-hidden="true" />}
            <span className="truncate">{bookmark.title}</span>
          </button>;
        })}
      </nav>}

      {/* loading progress bar */}
      <div className="relative h-0.5 shrink-0 bg-zinc-900/70" aria-hidden="true">
        {activeTab.loading && (
          <div className="cw-progress absolute inset-y-0 left-0 w-2/5 bg-[var(--browser-accent)]" />
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <main ref={viewportRef} className="relative min-h-0 flex-1" aria-label="Browser viewport">
          {findOpen && activeTab.url && !isInternalUrl(activeTab.url) && (
            <FindBar tabId={activeTab.id} onClose={() => setFindOpen(false)} getFrameDoc={getActiveFrameDoc} />
          )}
          {tabs.map((tab) => (
            <div key={tab.id} className={tab.id === activeTab.id ? "absolute inset-0" : "absolute inset-0 hidden"}>
              {tab.url && tab.navUrl ? (
                tab.navUrl === "about:history" ? (
                  <div className="h-full" style={tab.zoom !== 1 ? { zoom: tab.zoom } : undefined}>
                    <HistoryPage
                      history={historyList}
                      onNavigate={(input) => navigate(tab.id, input)}
                      onDelete={deleteHistoryEntry}
                      onClear={clearHistory}
                    />
                  </div>
                ) : tab.navUrl === "about:bookmarks" ? (
                  <div className="h-full" style={tab.zoom !== 1 ? { zoom: tab.zoom } : undefined}>
                    <BookmarksPage
                      bookmarks={bookmarks}
                      onNavigate={(input) => navigate(tab.id, input)}
                      onOpenAll={(urls) => {
                        for (const u of urls) openUrlTab(u);
                      }}
                      onSave={saveBookmark}
                      targets={tabs.filter((target) => target.url && !isInternalUrl(target.url) && !searchQueryFromUrl(target.url)).map((target) => ({ id: target.id, title: target.title, url: target.url! }))}
                      onRun={(bookmark, targetId) => void runBookmarklet(bookmark, targetId)}
                      onDelete={removeBookmark}
                      onClear={clearBookmarks}
                    />
                  </div>
                ) : tab.navUrl === "about:downloads" ? (
                  <div className="h-full" style={tab.zoom !== 1 ? { zoom: tab.zoom } : undefined}>
                    <DownloadsPage
                      items={downloads.items}
                      onRequeue={(item: DownloadItem) =>
                        startDownload(proxyUrl(item.url), item.url, item.name, item.sourceUrl)
                      }
                      onDelete={removeDownload}
                      onClear={clearDownloads}
                      onNavigate={(input) => navigate(tab.id, input)}
                      onCancel={cancelDownload}
                      onResume={(id) => {
                        const item = downloads.items.find((d) => d.id === id);
                        if (item) resumeDownload(id, proxyUrl(item.url));
                      }}
                      resumableIds={downloads.resumable}
                    />
                  </div>
                ) : tab.navUrl === "about:extensions" ? (
                  <ExtensionsPage />
                ) : tab.navUrl === "about:config" ? (
                  <div className="h-full" style={tab.zoom !== 1 ? { zoom: tab.zoom } : undefined}>
                    <ConfigPage
                      engine={engine}
                      tabsCount={tabs.length}
                      historyCount={historyList.length}
                      bookmarksCount={bookmarks.length}
                      downloadsCount={downloads.items.filter((d) => d.status !== "active").length}
                      onClearHistory={clearHistory}
                      onClearBookmarks={clearBookmarks}
                      onClearDownloads={clearDownloads}
                      onResetSession={resetSession}
                    />
                  </div>
                ) : searchQueryFromUrl(tab.navUrl) ? (
                  <div className="h-full" style={tab.zoom !== 1 ? { zoom: tab.zoom } : undefined}>
                    <SearchResultsPage
                      key={`${tab.id}-${tab.navSeq}`}
                      query={searchQueryFromUrl(tab.navUrl) ?? ""}
                      onNavigate={(input) => navigate(tab.id, input)}
                      onOpenTab={(url, background) => openUrlTab(url, { background })}
                    />
                  </div>
                ) : engine === "booting" ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-zinc-950">
                    <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
                    <p className="text-sm text-zinc-500">Starting the Scramjet proxy engine...</p>
                    <p className="max-w-sm text-center text-xs text-zinc-600">
                      Registering the interception service worker and opening the transport tunnel
                    </p>
                  </div>
                ) : (
                  <FrameView
                    tabId={tab.id}
                    navUrl={tab.navUrl}
                    navSeq={tab.navSeq}
                    title={tab.title}
                    zoom={tab.zoom}
                    legacy={engine === "legacy" || isLegacyRoutedUrl(tab.navUrl)}
                    searchRouted={engine !== "legacy" && isLegacyRoutedUrl(tab.navUrl)}
                    onExplicitNavigate={(input) => navigate(tab.id, input)}
                    register={(el) => {
                      if (el) iframesRef.current.set(tab.id, el);
                      else iframesRef.current.delete(tab.id);
                    }}
                    onNav={(url, title) => handleFrameNav(tab.id, url, title)}
                    onLoad={() => handleFrameLoad(tab.id)}
                    onDownload={(fetchHref, filename, displayUrl, sourceUrl) =>
                      startDownload(fetchHref, displayUrl, filename, sourceUrl)
                    }
                    onPageMenu={setPageMenu}
                    onOpenTab={(url, background) => openUrlTab(url, { background })}
                  />
                )
              ) : (
                <div className="h-full" style={tab.zoom !== 1 ? { zoom: tab.zoom } : undefined}>
                  <NewTabPage
                    onNavigate={(input) => navigate(tab.id, input)}
                    bookmarks={bookmarks.filter((bookmark) => !isBookmarklet(bookmark.url))}
                    onRemoveBookmark={removeBookmark}
                    history={historyList}
                  />
                </div>
              )}
            </div>
          ))}
          <DownloadsShelf
            items={downloads.items}
            onShowAll={() => openUrlTab("about:downloads")}
            onDismiss={dismissShelf}
            onCancel={cancelDownload}
            onResume={(id) => {
              const item = downloads.items.find((d) => d.id === id);
              if (item) resumeDownload(id, proxyUrl(item.url));
            }}
            resumableIds={downloads.resumable}
          />
          {readerVisible && (
            <ReaderView
              tabId={activeTab.id}
              navSeq={activeTab.navSeq}
              tabLoading={activeTab.loading}
              url={activeTab.url}
              getFrameDoc={getActiveFrameDoc}
              onClose={() => setReaderOpen(false)}
              onNavigate={(input) => navigate(activeTab.id, input)}
            />
          )}
        </main>

        {consoleOpen && (
          <ConsolePanel
            lines={consoleApi.lines}
            connected={consoleApi.connected}
            running={consoleApi.running}
            cwd={consoleApi.cwd}
            onExec={consoleApi.exec}
            onSignal={consoleApi.signal}
            onClear={consoleApi.clear}
            onAppend={consoleApi.appendLocal}
            onClose={toggleConsole}
            getFrameWindow={getFrameWindow}
            targetTitle={activeTab.url ? activeTab.title : "New tab page"}
          />
        )}
      </div>

      <StatusBar
        url={activeTab.url}
        consoleOpen={consoleOpen}
        connected={consoleApi.connected}
        running={consoleApi.running}
        engine={engine}
        zoom={activeTab.zoom}
        onZoomReset={() => zoomActive("reset")}
        downloadsActive={downloads.activeCount}
        onOpenDownloads={() => openUrlTab("about:downloads")}
        onLock={onLock}
      />

      {tabSearchOpen && (
        <TabSearch
          tabs={tabs}
          activeId={activeTab.id}
          onSelect={setActiveId}
          onClose={() => setTabSearchOpen(false)}
        />
      )}

      {pageMenu && activeTab && (
        <PageContextMenu
          target={pageMenu}
          canBack={activeTab.hIndex > 0}
          canFwd={activeTab.hIndex < activeTab.history.length - 1}
          onClose={() => setPageMenu(null)}
          onOpenTab={(url, background) => openUrlTab(url, { background })}
          onDownload={(fetchHref, displayUrl, filename, sourceUrl) =>
            startDownload(fetchHref, displayUrl, filename, sourceUrl || activeTab.url || "")
          }
          onCopy={copyToClipboard}
          onBack={goBack}
          onForward={goForward}
          onReload={reload}
        />
      )}
    </div>
  );
}
