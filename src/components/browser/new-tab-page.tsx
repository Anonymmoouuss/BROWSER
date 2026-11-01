"use client";

/**
 * NewTabPage — greeting, big search box, bookmarks + quick links grid,
 * recent history chips.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, Download, Globe, History, Search, Settings, Star, X } from "lucide-react";
import { faviconUrl, hostOf, isInternalUrl, type Bookmark, type HistoryEntry } from "@/lib/browser/shared";

const QUICK_LINKS: { name: string; url: string; icon?: "history" | "bookmarks" | "downloads" | "settings" }[] = [
  { name: "YouTube", url: "https://www.youtube.com/?hl=en&gl=AU" },
  { name: "YouTube Shorts", url: "https://www.youtube.com/shorts?hl=en&gl=AU" },
  { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page" },
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
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onNavigate(url)}
        title={url}
        className="flex min-h-20 w-full items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/45 px-4 py-3 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-800/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
      >
        {icon === "history" ? (
          <History className="h-6 w-6 shrink-0 text-emerald-400" aria-hidden="true" />
        ) : icon === "bookmarks" ? (
          <Star className="h-6 w-6 shrink-0 text-amber-300" aria-hidden="true" />
        ) : icon === "downloads" ? (
          <Download className="h-6 w-6 shrink-0 text-emerald-400" aria-hidden="true" />
        ) : icon === "settings" ? (
          <Settings className="h-6 w-6 shrink-0 text-zinc-300" aria-hidden="true" />
        ) : host && !internal ? (
          <img src={faviconUrl(host)} alt="" width={24} height={24} className="h-6 w-6 shrink-0 rounded" />
        ) : (
          <Globe className="h-6 w-6 shrink-0 text-zinc-500" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-200">{name}</span>
          <span className="block truncate text-xs text-zinc-500">{host ?? (internal ? url : "")}</span>
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
    <div className="cw-scroll cw-backdrop h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-400/10">
              <Globe className="h-5 w-5 text-emerald-300" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-zinc-500">{greetingText || "Welcome back"}</p>
              <h1 className="mt-0.5 text-xl font-semibold text-zinc-100">New tab</h1>
            </div>
          </div>
          <p className="min-w-[8ch] text-right text-lg font-medium tabular-nums text-zinc-400" aria-label="Current time">
            {clockText || "--:--"}
          </p>
        </div>
        <form
          className="mt-8 w-full"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) {
              onNavigate(q);
              setQ("");
            }
          }}
        >
          <div className="flex h-14 items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/80 pl-4 pr-1.5 transition-colors focus-within:border-emerald-400/70 focus-within:ring-2 focus-within:ring-emerald-400/10">
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
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-emerald-400 text-emerald-950 transition-colors hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </form>

        {bookmarks.length > 0 && (
          <section className="mt-10 w-full" aria-label="Bookmarks">
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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
              {bookmarks.slice(0, 6).map((b) => (
                <LinkTile key={b.url} name={b.title} url={b.url} onNavigate={onNavigate} onRemove={() => onRemoveBookmark(b.url)} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-10 w-full" aria-label="Quick links">
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Quick links</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
            {QUICK_LINKS.map((l) => (
              <LinkTile key={l.url} name={l.name} url={l.url} icon={l.icon} onNavigate={onNavigate} />
            ))}
          </div>
        </section>

        {recent.length > 0 && (
          <section className="mt-10 w-full" aria-label="Recently visited">
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

      </div>
    </div>
  );
}
