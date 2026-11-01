"use client";

/**
 * SourceView — Chrome-style view-source:<url> page.
 *
 * Streams the UNREWRITTEN upstream HTML through the backend's raw proxy mode,
 * then renders it with line numbers and HTML syntax coloring (tags, attribute
 * names, values, comments, doctype, raw script/style blocks). Big documents
 * render progressively (IntersectionObserver appends chunks) so a 1 MB source
 * stays smooth. Header actions: reload, save, copy URL.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  FileCode2,
  HardDriveDownload,
  Loader2,
  RotateCw,
} from "lucide-react";
import { rawProxyUrl } from "@/lib/browser/shared";
import { formatBytes } from "@/lib/browser/downloads";

const CHUNK = 1500;

type TokKind = "text" | "comment" | "doctype" | "punct" | "tag" | "attr" | "eq" | "value" | "raw";

interface Tok {
  s: number;
  e: number;
  k: TokKind;
}

/** Single-pass HTML tokenizer (no DOM parsing — sources can be anything). */
function tokenizeHtml(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  const push = (s: number, e: number, k: TokKind) => {
    if (e > s) toks.push({ s, e, k });
  };
  while (i < n) {
    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      const end = close < 0 ? n : close + 3;
      push(i, end, "comment");
      i = end;
      continue;
    }
    if (src.startsWith("<!", i)) {
      const close = src.indexOf(">", i);
      const end = close < 0 ? n : close + 1;
      push(i, end, "doctype");
      i = end;
      continue;
    }
    if (src[i] === "<" && /[a-zA-Z/]/.test(src[i + 1] ?? "")) {
      // markup: punct, tag name, then attributes until '>'
      push(i, i + 1, "punct");
      i++;
      let nameStart = i;
      while (i < n && /[^\s/>]/.test(src[i])) i++;
      let tagName = "";
      if (i > nameStart) {
        tagName = src.slice(nameStart, i).toLowerCase();
        push(nameStart, i, "tag");
      }
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++;
        if (i >= n) break;
        if (src[i] === ">" || src[i] === "/") {
          push(i, i + 1, "punct");
          const selfClose = src[i] === "/";
          i++;
          if (!selfClose && (tagName === "script" || tagName === "style")) {
            // raw content until the case-insensitive closing tag
            const m = src.slice(i).search(new RegExp(`</${tagName}\\s*>`, "i"));
            const rawEnd = m < 0 ? n : i + m;
            push(i, rawEnd, "raw");
            i = rawEnd;
          }
          break;
        }
        // attribute name
        const aStart = i;
        while (i < n && !/[\s=>]/.test(src[i])) i++;
        if (i === aStart) {
          i++; // stray char — skip it as punct
          continue;
        }
        push(aStart, i, "attr");
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === "=") {
          push(i, i + 1, "eq");
          i++;
          while (i < n && /\s/.test(src[i])) i++;
          if (src[i] === '"' || src[i] === "'") {
            const q = src[i];
            const vEnd = src.indexOf(q, i + 1);
            const end = vEnd < 0 ? n : vEnd + 1;
            push(i, end, "value");
            i = end;
          } else {
            const vStart = i;
            while (i < n && !/[\s>]/.test(src[i])) i++;
            push(vStart, i, "value");
          }
        }
      }
      continue;
    }
    // plain text until the next markup
    const next = src.indexOf("<", i + 1);
    const end = next < 0 ? n : next;
    push(i, end === i ? i + 1 : end, "text");
    i = end === i ? i + 1 : end;
  }
  return toks;
}

const KIND_CLASS: Record<TokKind, string> = {
  text: "text-zinc-300",
  comment: "text-zinc-600 italic",
  doctype: "text-amber-400",
  punct: "text-zinc-600",
  tag: "text-emerald-400",
  attr: "text-amber-300/90",
  eq: "text-zinc-500",
  value: "text-emerald-200",
  raw: "text-zinc-400",
};

/** tokens sliced into per-line segments */
interface LineTok {
  text: string;
  k: TokKind;
}

function splitTokensIntoLines(src: string, toks: Tok[]): LineTok[][] {
  const lines: LineTok[][] = [[]];
  for (const t of toks) {
    let segStart = t.s;
    for (;;) {
      const nl = src.indexOf("\n", segStart);
      if (nl < 0 || nl >= t.e) {
        if (t.e > segStart) lines[lines.length - 1].push({ text: src.slice(segStart, t.e), k: t.k });
        break;
      }
      if (nl > segStart) lines[lines.length - 1].push({ text: src.slice(segStart, nl), k: t.k });
      lines.push([]);
      segStart = nl + 1;
    }
  }
  return lines;
}

interface SourceViewProps {
  /** the real page URL (decoded from view-source:<url>) */
  url: string;
  /** reload trigger — bump to refetch */
  reloadSeq: number;
  /** internal page zoom multiplier */
  zoom: number;
  onDownload: (fetchHref: string, displayUrl: string, filename: string | null, sourceUrl: string) => void;
}

export default function SourceView({ url, reloadSeq, zoom, onDownload }: SourceViewProps) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [src, setSrc] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ status: number; type: string; finalUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(CHUNK);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const fetchSource = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const res = await fetch(`${rawProxyUrl(url)}&_=${Date.now()}`, { credentials: "include" });
      const text = await res.text();
      setMeta({
        status: res.status,
        type: res.headers.get("content-type") ?? "",
        finalUrl: res.headers.get("x-cw-final-url") ?? url,
      });
      if (!res.ok && !text.trim()) throw new Error(`HTTP ${res.status}`);
      setSrc(text);
      setVisible(CHUNK);
      setState("ready");
    } catch (err) {
      setSrc(null);
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, [url]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void fetchSource();
    });
    return () => { active = false; };
  }, [fetchSource, reloadSeq]);

  const lines = useMemo(() => {
    if (state !== "ready" || !src) return [];
    return splitTokensIntoLines(src, tokenizeHtml(src));
  }, [src, state]);

  // progressive rendering: append the next chunk when the sentinel shows
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || state !== "ready") return;
    if (visible >= lines.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible((v) => Math.min(v + CHUNK, lines.length));
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, lines.length, state]);

  const sizeKb = src ? new Blob([src]).size : 0;
  const host = useMemo(() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }, [url]);

  return (
    <div className="flex h-full flex-col bg-zinc-950" style={zoom !== 1 ? { zoom } : undefined}>
      {/* header */}
      <div className="z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 bg-zinc-900/80 px-4 py-2.5 backdrop-blur">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-800/60">
          <FileCode2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs text-zinc-200" title={`${meta?.finalUrl ?? url}`}>
            <span className="text-zinc-500">view-source:</span>
            {meta?.finalUrl ?? url}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
            {state === "ready" && (
              <>
                <span className="tabular-nums">{lines.length.toLocaleString()} lines</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{formatBytes(sizeKb)}</span>
                {meta?.type && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{meta.type.split(";")[0]}</span>
                  </>
                )}
                {meta && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className={`tabular-nums ${meta.status < 400 ? "text-emerald-400" : "text-amber-400"}`}>HTTP {meta.status}</span>
                  </>
                )}
              </>
            )}
            {state === "loading" && <span className="text-zinc-500">Fetching source through the proxy engine...</span>}
            {state === "error" && <span className="text-red-400">Source could not be loaded</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void fetchSource()}
            aria-label="Reload source"
            title="Reload source"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            <RotateCw className={`h-3.5 w-3.5 ${state === "loading" ? "animate-spin text-emerald-400" : ""}`} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onDownload(rawProxyUrl(url), url, `${host}.html`, url)}
            aria-label="Save source as..."
            title="Save source as..."
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            <HardDriveDownload className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* body */}
      {state === "loading" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3" role="status" aria-live="polite">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
          <p className="font-mono text-xs text-zinc-500">Loading document source...</p>
        </div>
      )}

      {state === "error" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-800">
            <AlertTriangle className="h-5 w-5 text-amber-400" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">Source could not be loaded</h2>
            <p className="mt-1 max-w-md font-mono text-xs leading-relaxed text-zinc-500">{error}</p>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-zinc-600">{url}</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchSource()}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-xs font-medium text-zinc-300 transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </button>
        </div>
      )}

      {state === "ready" && (
        <div className="cw-scroll min-h-0 flex-1 overflow-auto" role="region" aria-label="Page source" tabIndex={0}>
          <div className="min-w-max py-2 font-mono text-[12.5px] leading-[1.6]">
            {lines.slice(0, visible).map((line, idx) => (
              <div key={idx} className="group flex hover:bg-zinc-900/60">
                <span
                  className="sticky left-0 z-10 w-[4.5rem] shrink-0 select-none bg-zinc-950 pr-3 text-right text-zinc-700 tabular-nums group-hover:text-zinc-500"
                  aria-hidden="true"
                >
                  {idx + 1}
                </span>
                <code className="whitespace-pre pr-10 text-zinc-300">
                  {line.length === 0 ? (
                    "\u200B"
                  ) : (
                    line.map((t, j) => (
                      <span key={j} className={KIND_CLASS[t.k]}>
                        {t.text}
                      </span>
                    ))
                  )}
                </code>
              </div>
            ))}
            {visible < lines.length && (
              <div ref={sentinelRef} className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-600">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                rendering {visible.toLocaleString()} / {lines.length.toLocaleString()} lines...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
