"use client";

/**
 * StatusBar — bottom bar: engine badge, current URL, page zoom, downloads
 * chip, console connection state, shortcuts.
 */

import { Download, Lock, ZoomIn } from "lucide-react";
import type { EngineState } from "@/lib/browser/scramjet";

interface StatusBarProps {
  url: string | null;
  consoleOpen: boolean;
  connected: boolean;
  running: boolean;
  engine: EngineState;
  zoom: number;
  onZoomReset: () => void;
  /** number of in-progress downloads */
  downloadsActive: number;
  /** opens the about:downloads manager */
  onOpenDownloads: () => void;
  /** locks the workspace back to the access gate */
  onLock?: () => void;
}

export default function StatusBar({ url, consoleOpen, connected, running, engine, zoom, onZoomReset, downloadsActive, onOpenDownloads, onLock }: StatusBarProps) {
  const state = !consoleOpen
    ? { label: "console closed", dot: "bg-zinc-600" }
    : running
      ? { label: "command running", dot: "bg-amber-400 cw-pulse" }
      : connected
        ? { label: "console connected", dot: "bg-emerald-400" }
        : { label: "console offline", dot: "bg-red-400 cw-pulse" };

  const engineBadge =
    engine === "scramjet"
      ? { label: "Browser ready", dot: "bg-emerald-400", title: "Scramjet engine connected" }
      : engine === "legacy"
        ? { label: "Limited mode", dot: "bg-zinc-500", title: "Compatibility proxy active" }
        : { label: "Connecting", dot: "bg-amber-400 cw-pulse", title: "Connecting to the browser engine" };

  return (
    <footer className="flex h-8 min-w-0 shrink-0 items-center justify-between gap-2 border-t border-zinc-800 bg-zinc-900/80 px-3 text-[11px] text-zinc-500">
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex shrink-0 items-center gap-1.5" role="status" title={engineBadge.title}>
          <span className={`h-1.5 w-1.5 rounded-full ${engineBadge.dot}`} aria-hidden="true" />
          {engineBadge.label}
        </span>
        <span className="min-w-0 truncate" title={url ?? undefined}>
          {url ?? "New tab page"}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {downloadsActive > 0 && (
          <button
            type="button"
            onClick={onOpenDownloads}
            title="Show downloads (Ctrl+J)"
            className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 tabular-nums transition-colors hover:bg-emerald-500/20"
          >
            <Download className="h-3 w-3 animate-pulse text-emerald-300" aria-hidden="true" />
            {downloadsActive === 1 ? "1 download" : `${downloadsActive} downloads`}
          </button>
        )}
        {zoom !== 1 && (
          <button
            type="button"
            onClick={onZoomReset}
            title="Reset zoom to 100% (Ctrl+0) — Ctrl+plus/minus or Ctrl+scroll to change"
            className="flex shrink-0 items-center gap-1 rounded-full border border-zinc-700/80 bg-zinc-800/60 px-2 py-0.5 tabular-nums transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
          >
            <ZoomIn className="h-3 w-3" aria-hidden="true" />
            {Math.round(zoom * 100)}%
          </button>
        )}
        {onLock && (
          <button
            type="button"
            onClick={onLock}
            title="Lock workspace"
            aria-label="Lock workspace"
            className="flex h-6 shrink-0 items-center justify-center gap-1.5 rounded border border-zinc-700/80 bg-zinc-800/60 px-2 transition-colors hover:border-amber-500/60 hover:text-amber-300"
          >
            <Lock className="h-3 w-3" aria-hidden="true" />
            <span className="hidden sm:inline">Lock workspace</span>
          </button>
        )}
        {consoleOpen && (
          <span className="hidden items-center gap-1.5 sm:flex" role="status">
            <span className={`h-1.5 w-1.5 rounded-full ${state.dot}`} aria-hidden="true" />
            {state.label}
          </span>
        )}
      </span>
    </footer>
  );
}
