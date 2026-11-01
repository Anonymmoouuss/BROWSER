"use client";

/**
 * DownloadsPage — the about:downloads internal page: searchable list of
 * downloads (in-progress and history), per-entry re-download / open source /
 * delete, two-step clear-all, grouped by day like the history page.
 */

import { useMemo, useState } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { Ban, Download, ExternalLink, FileDown, Play, RotateCw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { extColorClass, formatBytes, type DownloadItem } from "@/lib/browser/downloads";
import { hostOf } from "@/lib/browser/shared";

interface DownloadsPageProps {
  items: DownloadItem[];
  onRequeue: (item: DownloadItem) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onNavigate: (input: string) => void;
  /** aborts an in-flight stream */
  onCancel: (id: string) => void;
  /** continues a canceled/failed download from its retained partial */
  onResume: (id: string) => void;
  /** ids whose partial payload is retained (Resume is offered for these) */
  resumableIds: string[];
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "d MMM yyyy");
}

function ItemIcon({ item }: { item: DownloadItem }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
      {item.status === "failed" ? (
        <X className="h-4 w-4 text-red-400" aria-hidden="true" />
      ) : item.status === "canceled" ? (
        <Ban className="h-4 w-4 text-zinc-500" aria-hidden="true" />
      ) : (
        <FileDown className={`h-4 w-4 ${extColorClass(item.name)}`} aria-hidden="true" />
      )}
    </span>
  );
}

export default function DownloadsPage({ items, onRequeue, onDelete, onClear, onNavigate, onCancel, onResume, resumableIds }: DownloadsPageProps) {
  const [q, setQ] = useState("");
  const [confirming, setConfirming] = useState(false);

  const entries = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (d) =>
        needle === "" ||
        d.name.toLowerCase().includes(needle) ||
        d.url.toLowerCase().includes(needle) ||
        d.sourceUrl.toLowerCase().includes(needle),
    );
  }, [items, q]);

  const groups = useMemo(() => {
    const out: { label: string; items: DownloadItem[] }[] = [];
    for (const d of entries) {
      const label = dayLabel(d.ts);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(d);
      else out.push({ label, items: [d] });
    }
    return out;
  }, [entries]);

  const hasHistory = items.some((d) => d.status !== "active");

  const requestClear = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3500);
      return;
    }
    onClear();
    setConfirming(false);
    toast.success("Download list cleared");
  };

  return (
    <div className="cw-scroll cw-backdrop h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 py-10 sm:py-14">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2.5 text-xl font-semibold text-zinc-100">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-400/30 bg-zinc-900">
              <Download className="h-4.5 w-4.5 text-emerald-400" aria-hidden="true" />
            </span>
            Downloads
          </h1>
          <button
            type="button"
            onClick={requestClear}
            disabled={!hasHistory}
            className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors ${
              confirming
                ? "border-red-400/60 bg-red-500/15 text-red-300 hover:bg-red-500/25"
                : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {confirming ? "Click again to clear all" : "Clear list"}
          </button>
        </div>

        <div className="mt-5 flex h-10 items-center gap-3 rounded-full border border-zinc-700 bg-zinc-900/70 pl-4 pr-2 transition-colors focus-within:border-emerald-500/60 focus-within:ring-2 focus-within:ring-emerald-500/20">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search downloads"
            aria-label="Search downloads"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <span className="shrink-0 pr-1 text-xs tabular-nums text-zinc-600">{entries.length}</span>
        </div>

        {groups.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/60">
              <Download className="h-5 w-5 text-zinc-600" aria-hidden="true" />
            </span>
            <p className="text-sm text-zinc-400">{q ? "No downloads match your search" : "No downloads yet"}</p>
            <p className="max-w-xs text-xs text-zinc-600">
              Click a download link on any site — files are streamed through the interception proxy and saved by your browser
            </p>
          </div>
        ) : (
          <div className="mt-7 flex flex-col gap-8 pb-8">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{g.label}</h2>
                <ul className="overflow-hidden rounded-xl border border-zinc-800/80">
                  {g.items.map((d, i) => {
                    const srcHost = hostOf(d.sourceUrl);
                    const pct = d.status === "active" && d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : null;
                    return (
                      <li
                        key={d.id}
                        className={`group flex items-center gap-3 bg-zinc-900/50 px-3 py-2.5 transition-colors hover:bg-zinc-900 ${
                          i > 0 ? "border-t border-zinc-800/60" : ""
                        }`}
                      >
                        <ItemIcon item={d} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-zinc-200 group-hover:text-zinc-50" title={d.name}>
                            {d.name}
                          </p>
                          <p className="truncate text-xs text-zinc-500">
                            {d.status === "active"
                              ? `Downloading — ${formatBytes(d.received)}${d.total ? ` of ${formatBytes(d.total)} (${pct}%)` : ""}`
                              : d.status === "failed"
                                ? `Failed — ${d.error ?? "unknown error"}`
                                : d.status === "canceled"
                                  ? `Canceled — ${formatBytes(d.received)} received`
                                  : `${formatBytes(d.received)} · ${format(new Date(d.ts), "HH:mm")}`}
                            {srcHost ? ` · from ${srcHost}` : ""}
                          </p>
                          {d.status === "active" && (
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-800">
                              <div
                                className={pct === null ? "cw-progress h-full w-1/3 rounded-full bg-emerald-400/70" : "h-full rounded-full bg-emerald-400 transition-[width] duration-200"}
                                style={pct !== null ? { width: `${pct}%` } : undefined}
                              />
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          {d.status === "active" ? (
                            <button
                              type="button"
                              onClick={() => {
                                onCancel(d.id);
                                toast.info(`Canceling ${d.name}`);
                              }}
                              aria-label={`Cancel ${d.name}`}
                              title="Cancel download"
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-300"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          ) : (
                            <>
                              {resumableIds.includes(d.id) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    onResume(d.id);
                                  }}
                                  aria-label={`Resume ${d.name} from ${formatBytes(d.received)}`}
                                  title={`Resume from ${formatBytes(d.received)} (Range request)`}
                                  className="flex h-7 w-7 items-center justify-center rounded-lg text-emerald-400 transition-colors hover:bg-emerald-500/15 hover:text-emerald-300"
                                >
                                  <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  onRequeue(d);
                                  toast.info(`Re-downloading ${d.name}`);
                                }}
                                aria-label={`Download ${d.name} again`}
                                title={resumableIds.includes(d.id) ? "Download again from the start" : "Download again"}
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-emerald-300"
                              >
                                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </>
                          )}
                          {srcHost && (
                            <button
                              type="button"
                              onClick={() => onNavigate(d.sourceUrl)}
                              aria-label={`Open source page ${srcHost}`}
                              title="Open the page this came from"
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                            >
                              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onDelete(d.id)}
                            aria-label={`Remove ${d.name} from the list`}
                            title="Remove from list"
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
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
