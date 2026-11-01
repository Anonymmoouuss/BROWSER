"use client";

/**
 * DownloadsShelf — Chrome-style floating shelf in the bottom-right corner of
 * the viewport: live cards for in-progress downloads (progress bar, bytes or
 * percent), recent results (done/failed), a "Show all" link to the
 * about:downloads manager, and a dismiss button. Auto-hides a few seconds
 * after the last item settles.
 */

import { useEffect, useState } from "react";
import { Ban, CheckCircle2, Download, Loader2, Play, X, XCircle } from "lucide-react";
import {
  formatBytes,
  shelfDismissedBefore,
  type DownloadItem,
} from "@/lib/browser/downloads";

const RECENT_MS = 9000;
const MAX_CARDS = 3;

interface ShelfProps {
  items: DownloadItem[];
  onShowAll: () => void;
  onDismiss: () => void;
  /** aborts an in-flight stream */
  onCancel: (id: string) => void;
  /** continues a canceled/failed download from its retained partial */
  onResume: (id: string) => void;
  /** ids whose partial payload is retained (Resume is offered for these) */
  resumableIds: string[];
}

function ShelfCard({
  item,
  onCancel,
  onResume,
  resumable,
}: {
  item: DownloadItem;
  onCancel: (id: string) => void;
  onResume: (id: string) => void;
  resumable: boolean;
}) {
  const pct =
    item.status === "active"
      ? item.total && item.total > 0
        ? Math.min(100, Math.round((item.received / item.total) * 100))
        : null
      : 100;

  return (
    <div className="cw-card-enter flex flex-col gap-1.5 rounded-xl border border-zinc-700/70 bg-zinc-900/95 p-3 shadow-2xl shadow-black/60 backdrop-blur">
      <div className="flex items-center gap-2.5">
        {item.status === "active" ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-400" aria-hidden="true" />
        ) : item.status === "done" ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
        ) : item.status === "canceled" ? (
          <Ban className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-zinc-100">{item.name}</span>
          <span className="block truncate text-[10px] text-zinc-500">
            {item.status === "failed"
              ? `Failed — ${item.error ?? "unknown error"}`
              : item.status === "canceled"
                ? "Canceled"
                : item.status === "active"
                  ? item.total
                    ? `${formatBytes(item.received)} of ${formatBytes(item.total)} · ${pct}%`
                    : `${formatBytes(item.received)}…`
                  : `${formatBytes(item.received)} — done`}
          </span>
        </span>
        {item.status === "active" && (
          <button
            type="button"
            onClick={() => onCancel(item.id)}
            aria-label={`Cancel ${item.name}`}
            title="Cancel download"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {item.status !== "active" && resumable && (
          <button
            type="button"
            onClick={() => onResume(item.id)}
            aria-label={`Resume ${item.name}`}
            title={`Resume from ${formatBytes(item.received)}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-emerald-400 transition-colors hover:bg-emerald-500/15 hover:text-emerald-300"
          >
            <Play className="h-3 w-3 fill-current" aria-hidden="true" />
          </button>
        )}
      </div>
      {item.status === "active" && (
        <div className="h-1 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${item.name}`}>
          <div
            className={pct === null ? "cw-progress h-full w-1/3 rounded-full bg-emerald-400/70" : "h-full rounded-full bg-emerald-400 transition-[width] duration-200"}
            style={pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
      )}
    </div>
  );
}

export default function DownloadsShelf({ items, onShowAll, onDismiss, onCancel, onResume, resumableIds }: ShelfProps) {
  const [, setTick] = useState(0);

  // Re-render once the "recently settled" window lapses so the shelf hides.
  useEffect(() => {
    if (items.some((i) => i.status === "active")) return;
    const soonest = Math.max(0, ...items.map((i) => i.ts + RECENT_MS - Date.now()));
    if (!soonest) return;
    const t = setTimeout(() => setTick((x) => x + 1), soonest + 50);
    return () => clearTimeout(t);
  }, [items]);

  const relevant = items.filter(
    (i) => i.status === "active" || (Date.now() - i.ts < RECENT_MS && !shelfDismissedBefore(i.ts)),
  );
  if (relevant.length === 0) return null;

  return (
    <div
      className="absolute bottom-4 right-4 z-40 flex w-72 flex-col gap-2"
      role="region"
      aria-label="Downloads"
    >
      {relevant.slice(0, MAX_CARDS).map((item) => (
        <ShelfCard
          key={item.id}
          item={item}
          onCancel={onCancel}
          onResume={onResume}
          resumable={resumableIds.includes(item.id)}
        />
      ))}
      <div className="flex items-center justify-between rounded-xl border border-zinc-700/70 bg-zinc-900/95 px-3 py-1.5 shadow-xl shadow-black/50 backdrop-blur">
        <button
          type="button"
          onClick={onShowAll}
          className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:text-emerald-300"
        >
          <Download className="h-3 w-3" aria-hidden="true" />
          Show all downloads
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close downloads shelf"
          className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        >
          <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
