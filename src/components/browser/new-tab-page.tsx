"use client";

/**
 * NewTabPage — greeting, big search box, bookmarks + quick links grid,
 * recent history chips.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ArrowRight, Download, Globe, History, Search, Settings, SlidersHorizontal, Star, X } from "lucide-react";
import { faviconUrl, hostOf, isInternalUrl, type Bookmark, type HistoryEntry } from "@/lib/browser/shared";
import { useAppearance, wallpaperImage } from "@/lib/browser/appearance";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import AppearanceControls from "./appearance-controls";

const QUICK_LINKS: { name: string; url: string; icon?: "history" | "bookmarks" | "downloads" | "settings" }[] = [
  { name: "YouTube", url: "https://www.youtube.com/?hl=en&gl=AU" },
  { name: "YouTube Shorts", url: "https://www.youtube.com/shorts?hl=en&gl=AU" },
  { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page" },
  { name: "GitHub", url: "https://github.com" },
  { name: "ABC News", url: "https://www.abc.net.au/news" },
  { name: "Hacker News", url: "https://news.ycombinator.com" },
  { name: "History", url: "about:history", icon: "history" },
  { name: "Bookmarks", url: "about:bookmarks", icon: "bookmarks" },
  { name: "Downloads", url: "about:downloads", icon: "downloads" },
  { name: "Settings", url: "about:config", icon: "settings" },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Ticking wall clock — client-only (useSyncExternalStore server snapshot is
 *  empty so hydration never mismatches), re-rendered once per second. */
function useWallClock(): string {
  return useSyncExternalStore(
    (onStoreChange) => {
      const t = setInterval(onStoreChange, 1000);
      return () => clearInterval(t);
    },
    () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    () => "",
  );
}

function LinkTile({
  name,
  url,
  icon,
  onNavigate,
  onRemove,
}: {
  name: string;
  url: string;
  icon?: "history" | "bookmarks" | "downloads" | "settings";
  onNavigate: (input: string) => void;
  onRemove?: () => void;
}) {
  const host = hostOf(url);
  const internal = isInternalUrl(url);
  const [loadedHost, setLoadedHost] = useState<string | null>(null);
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onNavigate(url)}
        title={url}
        className="cw-quick-link flex min-h-24 w-full flex-col items-center justify-center gap-2.5 rounded-lg border border-transparent bg-transparent px-2 py-3 text-center transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
      >
        <span className="cw-shortcut-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-zinc-900/75">
        {icon === "history" ? (
          <History className="h-6 w-6 shrink-0 text-emerald-400" aria-hidden="true" />
        ) : icon === "bookmarks" ? (
          <Star className="h-6 w-6 shrink-0 text-amber-300" aria-hidden="true" />
        ) : icon === "downloads" ? (
          <Download className="h-6 w-6 shrink-0 text-emerald-400" aria-hidden="true" />
        ) : icon === "settings" ? (
          <Settings className="h-6 w-6 shrink-0 text-zinc-300" aria-hidden="true" />
        ) : host && !internal ? (
          <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
            <Globe className={`h-6 w-6 text-zinc-500 ${loadedHost === host ? "invisible" : ""}`} aria-hidden="true" />
            <img src={faviconUrl(host)} alt="" width={24} height={24} onLoad={() => setLoadedHost(host)} onError={() => setLoadedHost(null)} className={`absolute inset-0 h-6 w-6 rounded ${loadedHost === host ? "" : "opacity-0"}`} />
          </span>
        ) : (
          <Globe className="h-6 w-6 shrink-0 text-zinc-500" aria-hidden="true" />
        )}
        </span>
        <span className="block w-full min-w-0">
          <span className="block truncate text-xs font-medium text-zinc-200">{name}</span>
          <span className="sr-only">{host ?? (internal ? url : "")}</span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-opacity hover:text-zinc-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

interface NewTabPageProps {
  onNavigate: (input: string) => void;
  bookmarks: Bookmark[];
  onRemoveBookmark: (url: string) => void;
  history: HistoryEntry[];
}

export default function NewTabPage({ onNavigate, bookmarks, onRemoveBookmark, history }: NewTabPageProps) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const appearance = useAppearance();
  const image = wallpaperImage(appearance);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Time-of-day greeting depends on the client clock, so it can only be
  // computed AFTER hydration (rendering it during SSR causes a hydration
  // mismatch when server and client timezones disagree). The
  // use-sync-external-store server/client snapshot split is the sanctioned
  // way to express this without a set-state-in-effect.
  const greetingText = useSyncExternalStore(
    () => () => {},
    () => greeting(),
    () => "",
  );
  const clockText = useWallClock();

  const recent = history.filter((entry) => !isInternalUrl(entry.url)).slice(0, 6);

  return (
    <div className="cw-scroll cw-backdrop cw-home relative isolate h-full overflow-y-auto bg-cover bg-center" data-wallpaper={Boolean(image)} style={image ? { backgroundImage: `url("${image}")` } : undefined}>
      {image && <div aria-hidden="true" className="cw-home-scrim pointer-events-none absolute inset-0 -z-10" style={{ "--wallpaper-dim": appearance.dim / 100 } as CSSProperties} />}
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-5 py-6 sm:px-10 sm:py-9">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/logo.svg" alt="" width={36} height={36} className="h-9 w-9 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs text-zinc-500">{greetingText || "Welcome back"}</p>
              <h1 className="mt-0.5 text-base font-semibold text-zinc-100">New tab</h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            {appearance.showClock && <p className="min-w-[5ch] text-right text-lg font-medium tabular-nums text-zinc-300" aria-label="Current time">{clockText || "--:--"}</p>}
            <Popover>
              <PopoverTrigger asChild><button type="button" aria-label="Customize new tab" title="Customize new tab" className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-zinc-950/45 text-zinc-300 backdrop-blur-md transition-colors hover:bg-zinc-800"><SlidersHorizontal className="h-4 w-4" aria-hidden="true" /></button></PopoverTrigger>
              <PopoverContent align="end" className="cw-scroll max-h-[75dvh] w-80 max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border-zinc-700 bg-zinc-950 p-4 text-zinc-100 shadow-2xl">
                <h2 className="mb-4 text-sm font-semibold">Appearance</h2>
                <AppearanceControls />
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <form
          className="mx-auto mt-10 w-full max-w-2xl sm:mt-16"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) {
              onNavigate(q);
              setQ("");
            }
          }}
        >
          <div className="cw-field flex h-14 items-center gap-3 rounded-full border border-white/20 bg-zinc-950/75 pl-5 pr-2 shadow-lg shadow-black/10 backdrop-blur-xl transition-colors focus-within:border-emerald-400/70 focus-within:ring-2 focus-within:ring-emerald-400/10">
            <Search className="h-4.5 w-4.5 shrink-0 text-zinc-500" aria-hidden="true" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search the web or type a URL"
              aria-label="Search or enter address"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            <button
              type="submit"
              disabled={!q.trim()}
              aria-label="Search or open website"
              title="Search or open website"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-400 text-emerald-950 transition-colors hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </form>

        {bookmarks.length > 0 && (
          <section className="mx-auto mt-8 w-full max-w-2xl" aria-label="Bookmarks">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-zinc-300">
                <Star className="h-3 w-3 text-amber-300" aria-hidden="true" /> Bookmarks
              </h2>
              <button
                type="button"
                onClick={() => onNavigate("about:bookmarks")}
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-emerald-300"
              >
                Manage <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-6 sm:gap-2">
              {bookmarks.slice(0, 6).map((b) => (
                <LinkTile key={b.url} name={b.title} url={b.url} onNavigate={onNavigate} onRemove={() => onRemoveBookmark(b.url)} />
              ))}
            </div>
          </section>
        )}

        {appearance.showShortcuts && <section className="mx-auto mt-7 w-full max-w-2xl" aria-label="Quick links">
          <h2 className="sr-only">Quick links</h2>
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-6 sm:gap-2">
            {QUICK_LINKS.filter((link) => !link.icon).map((l) => (
              <LinkTile key={l.url} name={l.name} url={l.url} icon={l.icon} onNavigate={onNavigate} />
            ))}
          </div>
        </section>}

        {recent.length > 0 && (
          <section className="mx-auto mt-9 w-full max-w-2xl" aria-label="Recently visited">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-zinc-300">Recently visited</h2>
              <button type="button" onClick={() => onNavigate("about:history")} className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-emerald-300">
                History <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
            <div className="grid gap-x-6 sm:grid-cols-2">
              {recent.map((h) => (
                <button
                  key={h.url}
                  type="button"
                  onClick={() => onNavigate(h.url)}
                  title={h.url}
                  className="flex min-h-14 min-w-0 items-center gap-3 border-b border-zinc-800/70 py-3 text-left transition-colors hover:text-emerald-300"
                >
                  <History className="h-4 w-4 shrink-0 text-zinc-600" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-300">{h.title || h.url}</span>
                    <span className="mt-0.5 block truncate text-xs text-zinc-600">{hostOf(h.url)}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        <nav aria-label="Browser pages" className="mx-auto mt-auto flex w-full max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-3 pt-10 text-xs text-zinc-400">
          {QUICK_LINKS.filter((link) => link.icon).map((link) => {
            const Icon = link.icon === "history" ? History : link.icon === "bookmarks" ? Star : link.icon === "downloads" ? Download : Settings;
            return <button key={link.url} type="button" onClick={() => onNavigate(link.url)} className="inline-flex min-h-9 items-center gap-2 transition-colors hover:text-zinc-100"><Icon className="h-3.5 w-3.5" aria-hidden="true" /> {link.name}</button>;
          })}
        </nav>
      </div>
    </div>
  );
}
