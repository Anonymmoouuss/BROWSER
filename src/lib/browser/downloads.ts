"use client";

/**
 * Downloads — a small in-memory + localStorage download manager.
 *
 * The Scramjet frames are same-origin, so `a[download]` clicks inside any
 * proxied page are intercepted by FrameView and handed to startDownload():
 * the resource is stream-fetched through the same interception service
 * worker (so the bytes come from the real upstream site), progress is
 * tracked per chunk, and the finished blob is handed to the browser as a
 * real file save. Completed/failed downloads are kept (capped) as history
 * for the about:downloads manager page and the downloads shelf.
 */

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { loadJson, makeTabId, saveJson } from "@/lib/browser/shared";

export interface DownloadItem {
  id: string;
  /** filename the browser saves as */
  name: string;
  /** real upstream URL (decoded, for display) */
  url: string;
  /** the page the download was started from */
  sourceUrl: string;
  status: "active" | "done" | "failed" | "canceled";
  /** bytes received so far (== total when done) */
  received: number;
  /** content-length when the upstream sent it, else null */
  total: number | null;
  mime: string;
  ts: number;
  error?: string;
}

export const DOWNLOADS_KEY = "cw.downloads.v1";

/* ---------------- store (subscribe + snapshot) ---------------- */

const EMPTY: DownloadItem[] = [];

let activeItems: DownloadItem[] = [];
let doneItems: DownloadItem[] = typeof window === "undefined" ? [] : loadJson<DownloadItem[]>(DOWNLOADS_KEY, []);
let snapshot: DownloadItem[] = typeof window === "undefined" ? [] : [...activeItems, ...doneItems];
let shelfDismissedAt = 0;

/** AbortControllers for in-flight streams (download cancellation). */
const controllers = new Map<string, AbortController>();

/**
 * Partial payloads retained when a stream is canceled or fails mid-flight,
 * so it can be RESUMED later with an HTTP Range request. OPFS-capable
 * browsers keep the partial on DISK (constant memory, no size cap);
 * otherwise chunks are retained in memory (capped, lost on reload).
 */
type PartialData =
  | { kind: "mem"; chunks: BlobPart[]; mime: string }
  | { kind: "opfs"; handle: FileHandleLike; id: string; mime: string };
const partials = new Map<string, PartialData>();

/** In-memory partials above this size are dropped on cancel (memory safety). */
const PARTIAL_BYTE_CAP = 256 * 1024 * 1024;

/*
 * OPFS (origin-private file system): large downloads stream to disk instead
 * of buffering in memory — a multi-hundred-MB blob would freeze or OOM the
 * tab. The finished disk-backed File feeds the same native save flow, and
 * retained partials are disk-backed too. Everything falls back to the
 * in-memory path when OPFS is unavailable.
 */
interface DirHandleLike {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
}
interface FileHandleLike {
  name?: string;
  getFile(): Promise<File>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<WritableLike>;
}
interface WritableLike {
  write(chunk: { type?: string; position?: number; data: unknown }): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

const DL_DIR = "cw-downloads";
const DL_PREFIX = "dl-";

async function getDlDir(): Promise<DirHandleLike | null> {
  try {
    const storage = navigator.storage as unknown as {
      getDirectory?: () => Promise<DirHandleLike & { getDirectoryHandle?: (name: string, o?: { create?: boolean }) => Promise<DirHandleLike> }>;
    };
    if (!storage.getDirectory) return null;
    const root = await storage.getDirectory();
    if (!root.getDirectoryHandle) return null;
    return await root.getDirectoryHandle(DL_DIR, { create: true });
  } catch {
    return null;
  }
}

// Purge leftover download files from previous page loads (no cross-reload
// resume). Gated by sessionStorage so dev-server hot reloads never race a
// download that is still streaming.
function purgeDlDir() {
  try {
    if (typeof window === "undefined" || !navigator.storage) return;
    if (sessionStorage.getItem("cw.dlpurge") === "1") return;
    sessionStorage.setItem("cw.dlpurge", "1");
    void (async () => {
      const dir = await getDlDir();
      if (!dir) return;
      // the directory's async iterator yields [name, handle] pairs
      for await (const [name] of dir as unknown as AsyncIterable<[string, unknown]>) {
        if (String(name).startsWith(DL_PREFIX)) await dir.removeEntry(String(name)).catch(() => undefined);
      }
    })();
  } catch {
    /* OPFS unavailable — nothing to purge */
  }
}
purgeDlDir();

const listeners = new Set<() => void>();

function publish() {
  snapshot = [...activeItems, ...doneItems].slice(0, 150);
  for (const l of listeners) l();
}

function persist() {
  saveJson(DOWNLOADS_KEY, doneItems.slice(0, 100));
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function getSnapshot(): DownloadItem[] {
  return snapshot;
}

function getServerSnapshot(): DownloadItem[] {
  return EMPTY;
}

/* ---------------- helpers ---------------- */

/** Derive a sensible filename from the real URL path. */
export function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (!last) return null;
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/json": "json",
  "text/plain": "txt",
  "text/html": "html",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "font/woff2": "woff2",
};

/** Make sure the filename has an extension when the mime type knows one. */
function ensureExtension(name: string, mime: string): string {
  if (mime.startsWith("text/html") || mime.startsWith("image/svg")) return name;
  if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
  const ext = MIME_EXT[mime.split(";")[0].trim().toLowerCase()];
  return ext ? `${name}.${ext}` : name;
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* ---------------- core ---------------- */

/**
 * Stream `fetchHref` into `item` (already in activeItems), save the bytes
 * through the browser's native download and settle the store entry.
 *
 * With `resume` set, the request carries `Range: bytes=<received>-` to
 * continue where the partial payload left off. If the server ignores the
 * range (200 instead of 206) the transfer restarts from zero — the same
 * entry is reused, so the user still gets one history row.
 */
function runDownloadStream(item: DownloadItem, fetchHref: string, resume: PartialData | null): void {
  const id = item.id;
  const ctrl = new AbortController();
  controllers.set(id, ctrl);

  // storage for this run: OPFS (disk-backed) when available, memory otherwise
  let opfsFile: FileHandleLike | null = null;
  let writable: WritableLike | null = null;
  let chunks: BlobPart[] = resume?.kind === "mem" ? resume.chunks : [];
  let mime = resume?.mime ?? "";
  let total: number | null = item.total;

  /** byte position within the backing file/payload (closure-mutated) */
  let pos = item.received;
  /** Persist one received chunk; resolves once it is safely stored. */
  const storeChunk = async (value: Uint8Array): Promise<void> => {
    if (writable) {
      await writable.write({ type: "write", position: pos, data: value });
    } else {
      chunks.push(value as unknown as BlobPart);
    }
  };

  /** Flush the backing store into a saved file (native browser download). */
  const settleFile = async (): Promise<{ objectUrl: string; blobType: string }> => {
    if (writable) {
      await writable.close();
      writable = null;
      const file = await opfsFile!.getFile();
      const objectUrl = URL.createObjectURL(file);
      // the disk file is no longer needed once the save consumed it
      setTimeout(() => {
        void getDlDir().then((d) => d?.removeEntry(DL_PREFIX + id).catch(() => undefined));
      }, 60_000);
      return { objectUrl, blobType: file.type || mime || "application/octet-stream" };
    }
    const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
    return { objectUrl: URL.createObjectURL(blob), blobType: blob.type };
  };

  /** Keep the partial for a later Resume (disk-backed when possible). */
  const keepPartial = async (receivedSoFar: number): Promise<void> => {
    if (receivedSoFar <= 0) {
      partials.delete(id);
      return;
    }
    if (opfsFile) {
      try {
        if (writable) {
          await writable.close();
          writable = null;
        }
        partials.set(id, { kind: "opfs", handle: opfsFile, id, mime });
        return;
      } catch {
        // writable broken — release the lock, then drop the partial
        if (writable?.abort) void writable.abort().catch(() => undefined);
      }
    } else if (chunks.length && receivedSoFar < PARTIAL_BYTE_CAP) {
      partials.set(id, { kind: "mem", chunks, mime });
      return;
    }
    partials.delete(id);
  };

  void (async () => {
    try {
      // open the disk-backed sink first (constant-memory streaming)
      const dir = await getDlDir();
      if (dir) {
        opfsFile = await dir.getFileHandle(DL_PREFIX + id, { create: true });
        const keep = !!resume && item.received > 0;
        writable = await opfsFile.createWritable({ keepExistingData: keep });
        chunks = [];
      } else if (resume?.kind === "opfs") {
        // OPFS vanished between cancel and resume — cannot continue the disk
        // partial; restart cleanly from scratch
        resume = null;
        item = { ...item, received: 0 };
        pos = 0;
        activeItems = activeItems.map((a) => (a.id === id ? item : a));
        publish();
      }

      const headers: Record<string, string> = {};
      if (resume && item.received > 0) headers.Range = `bytes=${item.received}-`;
      const res = await fetch(fetchHref, { credentials: "include", signal: ctrl.signal, headers });
      const rangeHonored = res.status === 206;
      if (!res.ok && !rangeHonored) throw new Error(`HTTP ${res.status}`);

      // range not honored -> full restart with a clean payload
      if (resume && !rangeHonored) {
        if (writable) {
          await writable.close();
          writable = await opfsFile!.createWritable({ keepExistingData: false });
        } else {
          chunks = [];
        }
        item = { ...item, received: 0 };
        activeItems = activeItems.map((a) => (a.id === id ? item : a));
        publish();
      }

      if (rangeHonored) {
        const cr = res.headers.get("content-range");
        const m = cr?.match(/\/(\d+)\s*$/);
        total = m ? parseInt(m[1], 10) : item.total;
      } else {
        const cl = res.headers.get("content-length");
        total = cl && /^\d+$/.test(cl) ? parseInt(cl, 10) : null;
      }

      const headerMime = res.headers.get("content-type") ?? "";
      // keep the recorded mime when the range response falls back to a
      // generic stream type
      mime = headerMime && !(rangeHonored && headerMime.includes("octet-stream") && resume?.mime) ? headerMime : resume?.mime || headerMime;

      let received = item.received;
      let lastPublish = 0;
      const cur = (): DownloadItem => ({ ...item, received, total: total ?? item.total });

      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            await storeChunk(value);
            pos += value.byteLength;
            received = pos;
          }
          const now = Date.now();
          if (now - lastPublish > 120) {
            lastPublish = now;
            activeItems = activeItems.map((a) => (a.id === id ? (received === a.received ? a : cur()) : a));
            publish();
          }
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        await storeChunk(buf);
        pos += buf.byteLength;
        received = pos;
      }

      const finalName = ensureExtension(item.name, mime || "application/octet-stream");
      const { objectUrl, blobType } = await settleFile();
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = finalName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

      partials.delete(id);
      controllers.delete(id);
      activeItems = activeItems.filter((a) => a.id !== id);
      const finished: DownloadItem = {
        ...item,
        name: finalName,
        status: "done",
        received,
        total: received,
        mime: mime || blobType,
        ts: Date.now(),
      };
      doneItems = [finished, ...doneItems].slice(0, 100);
      persist();
      publish();
      toast.success(`Downloaded ${finalName}`, { description: formatBytes(received) });
    } catch (err) {
      controllers.delete(id);
      const aborted = err instanceof DOMException && err.name === "AbortError";
      const receivedSoFar = activeItems.find((a) => a.id === id)?.received ?? item.received;
      // settle the partial FIRST (its close is async) so the settle publish
      // below already renders the Resume affordance
      try {
        await keepPartial(receivedSoFar);
      } catch {
        partials.delete(id);
      }
      activeItems = activeItems.filter((a) => a.id !== id);
      const settled: DownloadItem = aborted
        ? { ...item, received: receivedSoFar, status: "canceled", ts: Date.now() }
        : { ...item, received: receivedSoFar, status: "failed", error: err instanceof Error ? err.message : String(err), ts: Date.now() };
      doneItems = [settled, ...doneItems].slice(0, 100);
      persist();
      publish();
      if (aborted) {
        const resumable = partials.has(id) && receivedSoFar > 0;
        toast.info(`Download canceled`, {
          description: resumable ? `${item.name} — resumable from the downloads list` : item.name,
        });
      }
      else toast.error(`Download failed: ${item.name}`, { description: settled.error });
    }
  })();
}


/**
 * Fetch `fetchHref` (the same-origin rewritten URL) with progress, save it
 * through the browser's native download, and record it in the store.
 * `displayUrl` is the decoded real upstream URL for the history list.
 */
export function startDownload(fetchHref: string, displayUrl: string, filename: string | null, sourceUrl: string): void {
  const rawName = filename?.split(/[/\\]/).filter(Boolean).pop() || filenameFromUrl(displayUrl) || "download";
  const item: DownloadItem = {
    id: makeTabId(),
    name: rawName,
    url: displayUrl,
    sourceUrl,
    status: "active",
    received: 0,
    total: null,
    mime: "",
    ts: Date.now(),
  };
  shelfDismissedAt = 0;
  activeItems = [...activeItems, item];
  publish();
  runDownloadStream(item, fetchHref, null);
}

/**
 * Resume a canceled/failed download from its retained partial payload using
 * an HTTP Range request. The settled entry becomes active again (same id,
 * one history row); a server that ignores Range restarts the transfer.
 */
export function resumeDownload(id: string, fetchHref: string): void {
  const partial = partials.get(id);
  const item = doneItems.find((d) => d.id === id);
  if (!partial || !item) return;
  if (item.status !== "canceled" && item.status !== "failed") return;
  if (item.received <= 0) return;
  partials.delete(id);
  doneItems = doneItems.filter((d) => d.id !== id);
  const reactivated: DownloadItem = { ...item, status: "active", ts: Date.now(), error: undefined };
  shelfDismissedAt = 0;
  activeItems = [...activeItems, reactivated];
  publish();
  toast.info(`Resuming ${item.name}`, { description: `Continuing from ${formatBytes(item.received)}` });
  runDownloadStream(reactivated, fetchHref, partial);
}

/** Abort an in-flight download stream (no-op for settled items). */
export function cancelDownload(id: string): void {
  controllers.get(id)?.abort();
  controllers.delete(id);
}

/** Hide the shelf until the next download starts. */
export function dismissShelf(): void {
  shelfDismissedAt = Date.now();
  publish();
}

/** Best-effort removal of an OPFS partial payload. */
function dropOpfsPartial(p: PartialData | undefined): void {
  if (p?.kind !== "opfs") return;
  void (async () => {
    const dir = await getDlDir();
    if (dir) await dir.removeEntry(DL_PREFIX + p.id);
  })().catch(() => undefined);
}

export function removeDownload(id: string): void {
  doneItems = doneItems.filter((d) => d.id !== id);
  dropOpfsPartial(partials.get(id));
  partials.delete(id);
  persist();
  publish();
}

export function clearDownloads(): void {
  doneItems = [];
  for (const p of partials.values()) dropOpfsPartial(p);
  partials.clear();
  persist();
  publish();
}

export function shelfDismissedBefore(ts: number): boolean {
  return shelfDismissedAt > ts;
}

/* ---------------- hook ---------------- */

export interface DownloadsApi {
  items: DownloadItem[];
  activeCount: number;
  /** true while anything is streaming right now */
  anyActive: boolean;
  /** ids of canceled/failed entries whose partial payload is retained */
  resumable: string[];
}

/** Live download list (hydration-safe via the server snapshot split). */
export function useDownloads(): DownloadsApi {
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    items,
    activeCount: items.filter((i) => i.status === "active").length,
    anyActive: items.some((i) => i.status === "active"),
    resumable: items
      .filter((i) => (i.status === "canceled" || i.status === "failed") && i.received > 0 && partials.has(i.id))
      .map((i) => i.id),
  };
}

/** File-type accent for list icons (kept off blue/indigo on purpose). */
export function extColorClass(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (["pdf"].includes(ext)) return "text-red-400";
  if (["zip", "gz", "tar", "7z", "rar", "bz2", "xz"].includes(ext)) return "text-amber-300";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(ext)) return "text-emerald-400";
  if (["mp4", "webm", "mkv", "mov", "avi"].includes(ext)) return "text-rose-400";
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "text-violet-400";
  if (["txt", "md", "json", "csv", "html", "xml", "js", "ts", "css", "log"].includes(ext)) return "text-zinc-300";
  return "text-zinc-500";
}
