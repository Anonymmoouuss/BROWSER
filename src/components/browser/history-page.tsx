"use client";

/**
 * HistoryPage — the about:history internal page (Chrome-style browsing
 * history manager): searchable, grouped by day, one-click delete per entry
 * and a two-step clear-all.
 */

import { useMemo, useState } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { Clock, History, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { faviconUrl, hostOf, type HistoryEntry } from "@/lib/browser/shared";

interface HistoryPageProps {
  history: HistoryEntry[];
  onNavigate: (input: string) => void;
  onDelete: (url: string) => void;
  onClear: () => void;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "d MMM yyyy");
}

export default function HistoryPage({ history, onNavigate, onDelete, onClear }: HistoryPageProps) {
  const [q, setQ] = useState("");
  const [confirming, setConfirming] = useState(false);

  const entries = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return history.filter(
      (h) =>
        !h.url.startsWith("about:") &&
        (needle === "" || h.url.toLowerCase().includes(needle) || (h.title ?? "").toLowerCase().includes(needle)),
    );
  }, [history, q]);

  const groups = useMemo(() => {
    const out: { label: string; items: HistoryEntry[] }[] = [];
    for (const h of entries) {
      const label = dayLabel(h.ts);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(h);
      else out.push({ label, items: [h] });
    }
    return out;
  }, [entries]);

  const requestClear = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3500);
      return;
    }
    onClear();
    setConfirming(false);
    toast.success("Browsing history cleared");
  };

  return (
    <div className="cw-scroll cw-backdrop h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 py-10 sm:py-14">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2.5 text-xl font-semibold text-zinc-100">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-400/30 bg-zinc-900">
              <History className="h-4.5 w-4.5 text-emerald-400" aria-hidden="true" />
            </span>
            Browsing history
          </h1>
          <button
            type="button"
            onClick={requestClear}
            disabled={history.filter((h) => !h.url.startsWith("about:")).length === 0}
            className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors ${
              confirming
                ? "border-red-400/60 bg-red-500/15 text-red-300 hover:bg-red-500/25"
                : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {confirming ? "Click again to clear all" : "Clear history"}
          </button>
        </div>

        <div className="mt-5 flex h-10 items-center gap-3 rounded-full border border-zinc-700 bg-zinc-900/70 pl-4 pr-2 transition-colors focus-within:border-emerald-500/60 focus-within:ring-2 focus-within:ring-emerald-500/20">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search history"
            aria-label="Search history"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <span className="shrink-0 pr-1 text-xs tabular-nums text-zinc-600">{entries.length}</span>
        </div>

        {groups.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/60">
              <Clock className="h-5 w-5 text-zinc-600" aria-hidden="true" />
            </span>
            <p className="text-sm text-zinc-400">{q ? "No history entries match your search" : "No browsing history yet"}</p>
            <p className="max-w-xs text-xs text-zinc-600">
              Pages you visit in any tab are listed here, grouped by day, and stay on this device only
            </p>
          </div>
        ) : (
          <div className="mt-7 flex flex-col gap-8 pb-8">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{g.label}</h2>
                <ul className="overflow-hidden rounded-xl border border-zinc-800/80">
                  {g.items.map((h, i) => {
                    const host = hostOf(h.url);
                    return (
                      <li
                        key={h.url}
                        className={`group flex items-center gap-3 bg-zinc-900/50 px-3 py-2.5 transition-colors hover:bg-zinc-900 ${
                          i > 0 ? "border-t border-zinc-800/60" : ""
                        }`}
                      >
                        <span className="w-11 shrink-0 text-xs tabular-nums text-zinc-600">{format(new Date(h.ts), "HH:mm")}</span>
                        {host ? (
                          <img src={faviconUrl(host)} alt="" width={16} height={16} className="h-4 w-4 shrink-0 rounded-sm" />
                        ) : (
                          <Search className="h-4 w-4 shrink-0 text-zinc-600" aria-hidden="true" />
                        )}
                        <button
                          type="button"
                          onClick={() => onNavigate(h.url)}
                          className="min-w-0 flex-1 text-left"
                          title={h.url}
                        >
                          <span className="block truncate text-sm text-zinc-200 group-hover:text-zinc-50">{h.title || h.url}</span>
                          <span className="block truncate text-xs text-zinc-500">{h.url}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(h.url)}
                          aria-label={`Remove ${h.title || h.url} from history`}
                          title="Remove from history"
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-600 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
