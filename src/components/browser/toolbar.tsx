"use client";

/**
 * Toolbar — navigation controls + omnibox with suggestions dropdown
 * (history matches, raw URL, search fallback) + console/bookmark toggles.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Download,
  ExternalLink,
  FileSearch,
  Globe,
  History,
  House,
  Lock,
  MoreVertical,
  Plus,
  Printer,
  Puzzle,
  RotateCw,
  Search,
  Settings,
  Star,
  Terminal,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { hostOf, faviconUrl, isUrlLike, type Bookmark, type HistoryEntry } from "@/lib/browser/shared";

interface ToolbarProps {
  canBack: boolean;
  canFwd: boolean;
  loading: boolean;
  url: string | null;
  onBack: () => void;
  onFwd: () => void;
  onReload: () => void;
  onHome: () => void;
  onNavigate: (input: string) => void;
  onToggleConsole: () => void;
  consoleOpen: boolean;
  onToggleFind: () => void;
  findOpen: boolean;
  bookmarked: boolean;
  onToggleBookmark: () => void;
  history: HistoryEntry[];
  bookmarks: Bookmark[];
  /** opens the about:downloads manager (usually in a new tab) */
  onOpenDownloads: () => void;
  /** true while any download is streaming right now */
  downloadsActive: boolean;
  /* ---------- three-dot menu ---------- */
  onNewTab: () => void;
  canReopenTab: boolean;
  onReopenTab: () => void;
  onOpenHistory: () => void;
  onOpenBookmarks: () => void;
  onOpenSettings: () => void;
  onOpenExtensions: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  /** current page zoom (1 = 100%) */
  zoom: number;
  /** toggles reader mode on the active web page */
  onToggleReader: () => void;
  /** print the active page (web frame as rendered, reader article) */
  onPrint: () => void;
}

interface Suggestion {
  kind: "url" | "search" | "history" | "bookmark";
  label: string;
  sub: string;
  target: string;
}

function iconButtonClass(disabled: boolean): string {
  return `flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
    disabled ? "text-zinc-600" : "text-zinc-400 hover:bg-white/8 hover:text-zinc-100"
  }`;
}

/** shared row style for the three-dot menu entries */
const menuRowClass =
  "flex w-full items-center gap-2.5 px-3 py-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300";

/** Chrome-style leading omnibox icon: the site's favicon on real pages,
 * falling back to lock (secure) / globe (plain) / search (empty). */
function OmniboxLeadingIcon({ url, secure }: { url: string | null; secure: boolean }) {
  const [errHost, setErrHost] = useState<string | null>(null);
  const host = url && !url.startsWith("about:") ? hostOf(url) : null;
  if (!url) return <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />;
  if (host && errHost !== host) {
    return (
      <img
        src={faviconUrl(host)}
        alt=""
        width={14}
        height={14}
        className="h-3.5 w-3.5 shrink-0 rounded-sm"
        onError={() => setErrHost(host)}
      />
    );
  }
  if (secure) return <Lock className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />;
  return <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />;
}

export default function Toolbar(props: ToolbarProps) {
  const {
    canBack, canFwd, loading, url, onBack, onFwd, onReload, onHome,
    onNavigate, onToggleConsole, consoleOpen, onToggleFind, findOpen, bookmarked, onToggleBookmark, history, bookmarks,
    onOpenDownloads, downloadsActive, onNewTab, canReopenTab, onReopenTab, onOpenHistory, onOpenBookmarks, onOpenSettings, onOpenExtensions,
    onZoomIn, onZoomOut, onZoomReset, zoom, onToggleReader, onPrint,
  } = props;
  const [draft, setDraft] = useState<string | null>(null); // non-null while editing
  const [focused, setFocused] = useState(false);
  const [sugIndex, setSugIndex] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusedRef = useRef(false);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const value = draft ?? url ?? "";

  // Ctrl+L focuses the omnibox
  useEffect(() => {
    const onFocus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("cw-focus-omnibox", onFocus);
    return () => window.removeEventListener("cw-focus-omnibox", onFocus);
  }, []);

  // three-dot menu: outside click / Escape closes; stays inside the viewport
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) && !menuBtnRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);
  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      menuRef.current.style.maxHeight = `${Math.max(200, window.innerHeight - 16)}px`;
      menuRef.current.style.overflowY = "auto";
    }
  }, [menuOpen]);

  const q = value.trim();
  const suggestions: Suggestion[] = [];
  if (q) {
    if (isUrlLike(q)) suggestions.push({ kind: "url", label: q, sub: "Open website", target: q });
    suggestions.push({ kind: "search", label: q, sub: `Search Bing for "${q}"`, target: `https://www.bing.com/search?q=${encodeURIComponent(q)}` });
    const lower = q.toLowerCase();
    for (const b of bookmarks) {
      if (suggestions.length >= 7) break;
      if (b.url.toLowerCase().includes(lower) || (b.title && b.title.toLowerCase().includes(lower))) {
        suggestions.push({ kind: "bookmark", label: b.title || b.url, sub: b.url, target: b.url });
      }
    }
    for (const h of history) {
      if (suggestions.length >= 7) break;
      if (h.url.toLowerCase().includes(lower) || (h.title && h.title.toLowerCase().includes(lower))) {
        if (bookmarks.some((b) => b.url === h.url)) continue; // bookmark already suggested
        suggestions.push({ kind: "history", label: h.title || h.url, sub: h.url, target: h.url });
      }
    }
  }
  const showDrop = focused && q.length > 0 && suggestions.length > 0;

  const commit = (input: string) => {
    const target = input.trim();
    if (!target) return;
    setDraft(null);
    setSugIndex(-1);
    inputRef.current?.blur();
    onNavigate(target);
  };

  const secure = url ? url.startsWith("https://") || url.startsWith("http://localhost") : false;

  return (
    <header className="z-20 flex h-13 shrink-0 items-center gap-0.5 border-b border-[var(--browser-border)] bg-[var(--browser-toolbar)] px-2 sm:gap-1 sm:px-3">
      <button type="button" onClick={onBack} disabled={!canBack} aria-label="Go back" title="Back (Alt+Left)" className={iconButtonClass(!canBack)}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" onClick={onFwd} disabled={!canFwd} aria-label="Go forward" title="Forward (Alt+Right)" className={iconButtonClass(!canFwd)}>
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" onClick={onReload} disabled={!url} aria-label="Reload page" title="Reload" className={iconButtonClass(!url)}>
        <RotateCw className={`h-4 w-4 ${loading ? "animate-spin text-emerald-400" : ""}`} aria-hidden="true" />
      </button>
      <button type="button" onClick={onHome} aria-label="Home (new tab page)" title="Home" className={`${iconButtonClass(false)} hidden sm:flex`}>
        <House className="h-4 w-4" aria-hidden="true" />
      </button>

      {/* omnibox */}
      <div className="relative mx-1 min-w-0 flex-1">
        <div
          className={`cw-field flex h-10 items-center gap-2 rounded-lg border px-3 transition-colors ${
            focused ? "border-emerald-400/70 bg-[var(--browser-field)] ring-2 ring-emerald-400/10" : "border-white/8 bg-[var(--browser-field)] hover:border-white/20"
          }`}
        >
          <OmniboxLeadingIcon url={url} secure={secure} />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setDraft(e.target.value);
              setSugIndex(-1);
            }}
            onFocus={(e) => {
              focusedRef.current = true;
              setFocused(true);
              e.target.select();
            }}
            onBlur={() => {
              focusedRef.current = false;
              setFocused(false);
              setSugIndex(-1);
              setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (showDrop && sugIndex >= 0 && suggestions[sugIndex]) commit(suggestions[sugIndex].target);
                else commit(value);
              } else if (e.key === "ArrowDown" && showDrop) {
                e.preventDefault();
                setSugIndex((i) => Math.min(i + 1, suggestions.length - 1));
              } else if (e.key === "ArrowUp" && showDrop) {
                e.preventDefault();
                setSugIndex((i) => Math.max(i - 1, -1));
              } else if (e.key === "Escape") {
                inputRef.current?.blur();
              }
            }}
            spellCheck={false}
            autoComplete="off"
            aria-label="Address and search bar"
            placeholder="Search or enter an address"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {zoom !== 1 && (
            <button
              type="button"
              onClick={onZoomReset}
              aria-label={`Zoomed to ${Math.round(zoom * 100)} percent, click to reset`}
              title={`Zoomed to ${Math.round(zoom * 100)}% — click to reset (Ctrl+0)`}
              className="flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium tabular-nums text-emerald-300 transition-colors hover:bg-emerald-500/15"
            >
              <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
              {Math.round(zoom * 100)}%
            </button>
          )}
          {url && (
            <button
              type="button"
              onClick={onToggleBookmark}
              aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"}
              title={bookmarked ? "Remove bookmark" : "Bookmark this page"}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${
                bookmarked ? "text-amber-300 hover:bg-zinc-700/60" : "text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200"
              }`}
            >
              <Star className={`h-3.5 w-3.5 ${bookmarked ? "fill-amber-300" : ""}`} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* suggestions dropdown */}
        {showDrop && (
          <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-lg border border-[var(--browser-border)] bg-[var(--popover)] shadow-2xl shadow-black/50" role="listbox" aria-label="Address bar suggestions">
            {suggestions.map((s, i) => (
              <button
                key={`${s.kind}-${i}`}
                type="button"
                role="option"
                aria-selected={i === sugIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(s.target);
                }}
                onMouseEnter={() => setSugIndex(i)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                  i === sugIndex ? "bg-zinc-800" : "hover:bg-zinc-800/60"
                }`}
              >
                {s.kind === "search" ? (
                  <Search className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : s.kind === "history" ? (
                  <History className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                ) : s.kind === "bookmark" ? (
                  <Star className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                ) : (
                  <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{s.label}</span>
                  <span className="block truncate text-xs text-zinc-500">{s.sub}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* find in page */}
      <button
        type="button"
        onClick={onToggleFind}
        disabled={!url || url.startsWith("about:")}
        aria-label="Find in page"
        aria-pressed={findOpen}
        title="Find in page (Ctrl+F)"
        className={`hidden h-9 w-9 items-center justify-center rounded-lg transition-colors sm:flex ${
          findOpen
            ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40"
            : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        } disabled:opacity-30`}
      >
        <FileSearch className="h-4 w-4" aria-hidden="true" />
      </button>

      {/* downloads — hidden on mobile (kept in the three-dot menu) so the
          omnibox keeps its width, like Chrome Android's toolbar */}
      <button
        type="button"
        onClick={onOpenDownloads}
        aria-label="Downloads"
        title="Downloads (Ctrl+J)"
        className="relative hidden h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 sm:flex"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {downloadsActive && (
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400 cw-pulse" aria-hidden="true" />
        )}
      </button>

      {/* console toggle — icon-only on narrow screens, full label from sm */}
      <button
        type="button"
        onClick={onToggleConsole}
        aria-label="Toggle console"
        aria-pressed={consoleOpen}
        title="Console (`)"
        className={`flex h-9 items-center gap-2 rounded-lg px-2.5 transition-colors sm:px-3 ${
          consoleOpen
            ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40"
            : "text-zinc-400 hover:bg-zinc-800 hover:text-emerald-300"
        }`}
      >
        <Terminal className="h-4 w-4" aria-hidden="true" />
        <span className="hidden text-xs font-medium sm:inline">Console</span>
      </button>

      {/* three-dot menu */}
      <button type="button" onClick={onOpenExtensions} aria-label="Extensions" title="Extensions" className={`${iconButtonClass(false)} hidden md:flex`}><Puzzle className="h-4 w-4" aria-hidden="true" /></button>
      <div className="relative">
        <button
          ref={menuBtnRef}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Customize and control"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Customize and control"
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
            menuOpen ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          }`}
        >
          <MoreVertical className="h-4 w-4" aria-hidden="true" />
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="Browser menu"
            className="cw-menu-enter absolute right-0 top-full z-40 mt-2 w-60 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1.5 text-xs shadow-2xl shadow-black/60"
          >
            <button type="button" role="menuitem" className={menuRowClass} onClick={() => { setMenuOpen(false); onNewTab(); }}>
              <Plus className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">New tab</span>
              <span className="text-[10px] text-zinc-600">Ctrl+T</span>
            </button>
            <button type="button" role="menuitem" className={menuRowClass} disabled={!canReopenTab} title="Reopen closed tab (Ctrl+Shift+T)" onClick={() => { setMenuOpen(false); onReopenTab(); }}>
              <Undo2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">Reopen closed tab</span>
            </button>
            {url && /^https?:\/\//i.test(url) && <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" role="menuitem" className={menuRowClass} onClick={() => setMenuOpen(false)}>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">Open original website</span>
            </a>}
            <div className="my-1 h-px bg-zinc-800" aria-hidden="true" />
            <button type="button" role="menuitem" className={menuRowClass} onClick={() => { setMenuOpen(false); onOpenBookmarks(); }}>
              <Star className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
              <span className="flex-1 text-left">Bookmarks</span>
              <span className="text-[10px] text-zinc-600">Ctrl+Shift+O</span>
            </button>
            <button type="button" role="menuitem" className={menuRowClass} onClick={() => { setMenuOpen(false); onOpenHistory(); }}>
              <History className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">History</span>
              <span className="text-[10px] text-zinc-600">Ctrl+H</span>
            </button>
            <button type="button" role="menuitem" className={menuRowClass} onClick={() => { setMenuOpen(false); onOpenDownloads(); }}>
              <Download className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">Downloads</span>
              <span className="text-[10px] text-zinc-600">Ctrl+J</span>
            </button>
            <button type="button" role="menuitem" className={menuRowClass} onClick={() => { setMenuOpen(false); onOpenExtensions(); }}>
              <Puzzle className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">Extensions</span>
            </button>
            <button type="button" role="menuitem" className={menuRowClass} onClick={() => { setMenuOpen(false); onOpenSettings(); }}>
              <Settings className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">Settings</span>
              <span className="text-[10px] text-zinc-600">about:config</span>
            </button>
            <div className="my-1 h-px bg-zinc-800" aria-hidden="true" />
            <div className="flex items-center gap-1 px-2 py-1" role="group" aria-label="Page zoom">
              <button
                type="button"
                onClick={onZoomOut}
                aria-label="Zoom out"
                title="Zoom out (Ctrl+-)"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onZoomReset}
                aria-label={`Reset zoom to 100 percent, currently ${Math.round(zoom * 100)} percent`}
                title="Reset zoom (Ctrl+0)"
                className="h-8 flex-1 rounded-lg text-[11px] font-medium tabular-nums text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={onZoomIn}
                aria-label="Zoom in"
                title="Zoom in (Ctrl++)"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="my-1 h-px bg-zinc-800" aria-hidden="true" />
            <button type="button" role="menuitem" className={menuRowClass} onClick={() => { setMenuOpen(false); onPrint(); }}>
              <Printer className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">Print...</span>
              <span className="text-[10px] text-zinc-600">Ctrl+P</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={menuRowClass}
              onClick={() => { setMenuOpen(false); onToggleReader(); }}
              disabled={!url || url.startsWith("about:")}
            >
              <BookOpen className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">Reader mode</span>
              <span className="text-[10px] text-zinc-600">Ctrl+Alt+R</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={menuRowClass}
              onClick={() => { setMenuOpen(false); onToggleFind(); }}
              disabled={!url || url.startsWith("about:")}
            >
              <FileSearch className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="flex-1 text-left">Find in page</span>
              <span className="text-[10px] text-zinc-600">Ctrl+F</span>
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={consoleOpen}
              className={menuRowClass}
              onClick={() => { setMenuOpen(false); onToggleConsole(); }}
            >
              <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
              <span className="flex-1 text-left">{consoleOpen ? "Hide console" : "Show console"}</span>
              <span className="text-[10px] text-zinc-600">`</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
