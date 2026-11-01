"use client";

/**
 * ConfigPage — the about:config internal page: engine diagnostics (which
 * proxy serves the pages, service-worker state), live session stats, and
 * browsing-data management (per-store clear + reset session), all client-side
 * data that lives in this browser's localStorage.
 */

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Database,
  Globe,
  History,
  Loader2,
  RotateCcw,
  Settings,
  Star,
  Download,
  Trash2,
  TriangleAlert,
  X,
  ZoomIn,
} from "lucide-react";
import { toast } from "sonner";
import type { EngineState } from "@/lib/browser/scramjet";
import { clearSiteZooms, removeSiteZoom, useSiteZooms } from "@/lib/browser/site-zoom";

interface ConfigPageProps {
  engine: EngineState;
  tabsCount: number;
  historyCount: number;
  bookmarksCount: number;
  downloadsCount: number;
  onClearHistory: () => void;
  onClearBookmarks: () => void;
  onClearDownloads: () => void;
  onResetSession: () => void;
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Globe; children: React.ReactNode }) {
  return (
    <section className="mt-8" aria-label={title}>
      <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        <Icon className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-zinc-800/80">{children}</div>
    </section>
  );
}

function Row({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 bg-zinc-900/50 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-zinc-300">{label}</p>
        {sub && <p className="mt-0.5 truncate text-xs text-zinc-600" title={sub}>{sub}</p>}
      </div>
      <div className="shrink-0 text-right text-sm text-zinc-400">{value}</div>
    </div>
  );
}

function ClearRow({
  icon: Icon,
  label,
  count,
  onClear,
}: {
  icon: typeof History;
  label: string;
  count: number;
  onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3500);
    return () => clearTimeout(t);
  }, [confirming]);
  return (
    <div className="flex items-center justify-between gap-4 bg-zinc-900/50 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm text-zinc-300">{label}</p>
          <p className="text-xs text-zinc-600">{count === 1 ? "1 entry" : `${count} entries`}</p>
        </div>
      </div>
      <button
        type="button"
        disabled={count === 0}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          onClear();
          setConfirming(false);
          toast.success(`${label} cleared`);
        }}
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
          confirming
            ? "border-red-400/60 bg-red-500/15 text-red-300 hover:bg-red-500/25"
            : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
        }`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        {confirming ? "Confirm" : "Clear"}
      </button>
    </div>
  );
}

export default function ConfigPage(props: ConfigPageProps) {
  const { engine, tabsCount, historyCount, bookmarksCount, downloadsCount, onClearHistory, onClearBookmarks, onClearDownloads, onResetSession } = props;
  const [swUrl, setSwUrl] = useState<string | null>(null);
  const [swState, setSwState] = useState<"checking" | "active" | "none">("checking");
  const [resetting, setResetting] = useState(false);
  const [zoomClearing, setZoomClearing] = useState(false);
  const siteZooms = useSiteZooms();
  const zoomEntries = Object.entries(siteZooms).sort((a, b) => a[0].localeCompare(b[0]));

  useEffect(() => {
    let alive = true;
    navigator.serviceWorker
      ?.getRegistration()
      .then((reg) => {
        if (!alive) return;
        const active = reg?.active ?? null;
        setSwUrl(active?.scriptURL ?? null);
        setSwState(active ? "active" : "none");
      })
      .catch(() => {
        if (alive) setSwState("none");
      });
    return () => {
      alive = false;
    };
  }, []);

  const engineInfo =
    engine === "scramjet"
      ? { label: "Scramjet engine", desc: "Service-worker interception proxy (Mercury Workshop Scramjet) over the wisp tunnel — search result pages route through the server-side proxy", tone: "text-emerald-300", icon: CheckCircle2 }
      : engine === "legacy"
        ? { label: "Legacy proxy", desc: "Server-side rewriting proxy fallback on port 3030", tone: "text-zinc-300", icon: TriangleAlert }
        : { label: "Engine starting", desc: "Booting the Scramjet proxy engine", tone: "text-amber-300", icon: Loader2 };

  return (
    <div className="cw-scroll cw-backdrop h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 py-10 pb-16 sm:py-14">
        <h1 className="flex items-center gap-2.5 text-xl font-semibold text-zinc-100">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900">
            <Settings className="h-4.5 w-4.5 text-zinc-300" aria-hidden="true" />
          </span>
          Settings
        </h1>
        <p className="mt-1.5 text-xs text-zinc-600">about:config — engine diagnostics and local browsing data</p>

        <Section title="Proxy engine" icon={Cpu}>
          <div className="flex items-center justify-between gap-4 bg-zinc-900/50 px-4 py-3">
            <div className="min-w-0">
              <p className={`flex items-center gap-2 text-sm font-medium ${engineInfo.tone}`}>
                <engineInfo.icon className={`h-4 w-4 ${engine === "booting" ? "animate-spin" : ""}`} aria-hidden="true" />
                {engineInfo.label}
              </p>
              <p className="mt-0.5 text-xs text-zinc-600">{engineInfo.desc}</p>
            </div>
          </div>
          <div className="border-t border-zinc-800/60">
            <Row
              label="Service worker"
              value={
                swState === "checking" ? (
                  <span className="flex items-center gap-1.5 text-zinc-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> checking
                  </span>
                ) : swState === "active" ? (
                  <span className="flex items-center gap-1.5 text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> active
                  </span>
                ) : (
                  <span className="text-zinc-500">not registered</span>
                )
              }
              sub={swUrl ?? undefined}
            />
          </div>
          <div className="border-t border-zinc-800/60">
            <Row label="Console backend" value="sandbox shell" sub="real commands run as a non-root user over the websocket on port 3030" />
          </div>
        </Section>

        <Section title="This session" icon={Globe}>
          <Row label="Open tabs" value={<span className="tabular-nums">{tabsCount}</span>} />
          <div className="border-t border-zinc-800/60">
            <Row label="Browsing engine" value={engineInfo.label} />
          </div>
        </Section>

        <Section title="Zoom levels" icon={ZoomIn}>
          <div className="flex items-center justify-between gap-4 bg-zinc-900/50 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm text-zinc-300">Per-site zoom memory</p>
              <p className="mt-0.5 text-xs text-zinc-600">
                {zoomEntries.length === 0
                  ? "Every site renders at 100% — zoom a page (Ctrl+plus/minus or Ctrl+scroll) to remember a level"
                  : zoomEntries.length === 1
                    ? "1 site renders at a remembered zoom level"
                    : `${zoomEntries.length} sites render at remembered zoom levels`}
              </p>
            </div>
            {zoomEntries.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (!zoomClearing) {
                    setZoomClearing(true);
                    return;
                  }
                  clearSiteZooms();
                  setZoomClearing(false);
                  toast.success("Zoom levels cleared — every site back to 100%");
                }}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                  zoomClearing
                    ? "border-red-400/60 bg-red-500/15 text-red-300 hover:bg-red-500/25"
                    : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                }`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {zoomClearing ? "Confirm" : "Reset all"}
              </button>
            )}
          </div>
          {zoomEntries.map(([host, zoom], i) => (
            <div key={host} className={i === 0 ? "" : "border-t border-zinc-800/60"}>
              <div className="flex items-center justify-between gap-4 bg-zinc-900/50 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <ZoomIn className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-300" title={host}>{host}</p>
                    <p className="text-xs text-zinc-600">applied to every tab on this site</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded-full border border-zinc-700/80 bg-zinc-800/60 px-2 py-0.5 text-xs font-medium tabular-nums text-zinc-300">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => removeSiteZoom(host)}
                    aria-label={`Reset zoom for ${host}`}
                    title="Reset to 100%"
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </Section>

        <Section title="Browsing data on this device" icon={Database}>
          <ClearRow icon={History} label="History" count={historyCount} onClear={onClearHistory} />
          <div className="border-t border-zinc-800/60">
            <ClearRow icon={Star} label="Bookmarks" count={bookmarksCount} onClear={onClearBookmarks} />
          </div>
          <div className="border-t border-zinc-800/60">
            <ClearRow icon={Download} label="Downloads list" count={downloadsCount} onClear={onClearDownloads} />
          </div>
          <div className="border-t border-zinc-800/60">
            <div className="flex items-center justify-between gap-4 bg-zinc-900/50 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <RotateCcw className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                <div>
                  <p className="text-sm text-zinc-300">Restore session</p>
                  <p className="text-xs text-zinc-600">Close every tab and start from a single new tab</p>
                </div>
              </div>
              <button
                type="button"
                disabled={resetting}
                onClick={() => {
                  if (!resetting) {
                    setResetting(true);
                    return;
                  }
                  onResetSession();
                  setResetting(false);
                  toast.success("Session restored to a single new tab");
                }}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                  resetting
                    ? "border-red-400/60 bg-red-500/15 text-red-300 hover:bg-red-500/25"
                    : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                }`}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {resetting ? "Confirm" : "Reset"}
              </button>
            </div>
          </div>
        </Section>

        <p className="mt-8 text-xs text-zinc-600">
          All data above lives in this browser's localStorage — nothing is sent anywhere. Clearing data is immediate and cannot be undone.
        </p>
      </div>
    </div>
  );
}
