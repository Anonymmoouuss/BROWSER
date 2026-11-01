"use client";

/**
 * ReaderView — distraction-free reading overlay for the active page.
 *
 * Extraction runs against the LIVE proxied frame (same-origin), so it works
 * identically under both engines. The result renders in a clean typographic
 * layout with Chrome-reader-style appearance controls: font size ladder,
 * serif/sans toggle, and three themes (dark / paper / sepia). Preferences
 * persist in localStorage. Links inside the article navigate the underlying
 * tab and exit the reader; Escape exits too.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { BookOpen, Coffee, Loader2, Moon, Printer, RefreshCw, Sun, Type, X } from "lucide-react";
import { extractReaderDoc, type ReaderBlock, type ReaderDoc } from "@/lib/browser/reader";
import { printHtml, readerToPrintableHtml } from "@/lib/browser/print";
import { hostOf, scramjetFramePrefix } from "@/lib/browser/shared";

const READER_KEY = "cw.reader.v1";
const SIZES = [0.85, 1, 1.15, 1.3, 1.45, 1.6] as const;

type Theme = "dark" | "paper" | "sepia";
type Font = "serif" | "sans";

interface ReaderPrefs {
  theme: Theme;
  font: Font;
  size: number;
}

const SERIF_STACK = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const SANS_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const THEMES: Record<Theme, { wrapper: string; heading: string; muted: string; bar: string; code: string; quote: string; link: string; rule: string }> = {
  dark: {
    wrapper: "bg-zinc-950 text-zinc-300",
    heading: "text-zinc-100",
    muted: "text-zinc-500",
    bar: "border-zinc-800 bg-zinc-950/95",
    code: "border-zinc-800 bg-zinc-900 text-zinc-300",
    quote: "border-emerald-400/50 text-zinc-400",
    link: "text-emerald-300 hover:text-emerald-200 underline decoration-emerald-400/40 underline-offset-2",
    rule: "bg-zinc-800",
  },
  paper: {
    wrapper: "bg-[#faf9f6] text-zinc-700",
    heading: "text-zinc-900",
    muted: "text-zinc-400",
    bar: "border-zinc-200 bg-[#faf9f6]/95",
    code: "border-zinc-200 bg-zinc-100 text-zinc-800",
    quote: "border-emerald-700/50 text-zinc-600",
    link: "text-emerald-700 hover:text-emerald-800 underline decoration-emerald-700/40 underline-offset-2",
    rule: "bg-zinc-200",
  },
  sepia: {
    wrapper: "bg-[#f6efe1] text-[#5f4b3a]",
    heading: "text-[#3f2f22]",
    muted: "text-[#a18868]",
    bar: "border-[#e3d5bd] bg-[#f6efe1]/95",
    code: "border-[#e3d5bd] bg-[#efe5d2] text-[#4a3828]",
    quote: "border-[#b28e5c] text-[#7a6248]",
    link: "text-[#8a5a2b] hover:text-[#6f4720] underline decoration-[#b28e5c]/60 underline-offset-2",
    rule: "bg-[#e3d5bd]",
  },
};

const THEME_ORDER: Theme[] = ["dark", "paper", "sepia"];

interface ReaderViewProps {
  tabId: string;
  navSeq: number;
  tabLoading: boolean;
  url: string | null;
  getFrameDoc: () => Document | null;
  onClose: () => void;
  onNavigate: (input: string) => void;
}

function formatPublished(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const d = parseISO(raw);
    if (Number.isNaN(d.getTime())) return null;
    return format(d, "MMMM d, yyyy");
  } catch {
    return null;
  }
}

function BlockList({ doc, t, onOpen }: { doc: ReaderDoc; t: (typeof THEMES)[Theme]; onOpen: (href: string) => void }) {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < doc.blocks.length) {
    const b = doc.blocks[i];
    if (b.type === "list-item") {
      const items: Extract<ReaderBlock, { type: "list-item" }>[] = [];
      while (i < doc.blocks.length && doc.blocks[i].type === "list-item") {
        const li = doc.blocks[i] as Extract<ReaderBlock, { type: "list-item" }>;
        items.push(li);
        i++;
      }
      out.push(
        <ul key={`ul-${i}`} className="my-4 list-disc space-y-1.5 pl-6 marker:opacity-60">
          {items.map((li, j) => (
            <li key={j}>{li.text}</li>
          ))}
        </ul>,
      );
      continue;
    }
    switch (b.type) {
      case "heading": {
        const H = (b.level === 2 ? "h2" : b.level === 3 ? "h3" : "h4") as "h2" | "h3" | "h4";
        out.push(
          <H key={i} className={`mt-8 mb-3 font-semibold tracking-tight ${t.heading} ${b.level === 2 ? "text-[1.35em]" : b.level === 3 ? "text-[1.15em]" : "text-[1em] uppercase tracking-wide opacity-80"}`}>
            {b.text}
          </H>,
        );
        break;
      }
      case "paragraph":
        out.push(
          <p key={i} className="my-4 leading-[1.75]">
            {b.runs.map((r, j) =>
              r.href ? (
                <a key={j} href={r.href} onClick={(e) => { e.preventDefault(); onOpen(r.href!); }} className={t.link}>
                  {r.text}
                </a>
              ) : (
                <span key={j}>{r.text}</span>
              ),
            )}
          </p>,
        );
        break;
      case "caption":
        out.push(
          <p key={i} className={`my-2 text-[0.82em] italic ${t.muted}`}>
            {b.text}
          </p>,
        );
        break;
      case "quote":
        out.push(
          <blockquote key={i} className={`my-5 border-l-[3px] pl-4 italic leading-relaxed ${t.quote}`}>
            {b.text}
          </blockquote>,
        );
        break;
      case "code":
        out.push(
          <pre key={i} className={`cw-scroll my-5 overflow-x-auto rounded-lg border p-4 text-[0.82em] leading-relaxed ${t.code}`}>
            {b.text}
          </pre>,
        );
        break;
      case "image":
        out.push(
          <figure key={i} className="my-6">
            <img
              src={b.src}
              alt={b.alt}
              loading="lazy"
              className="w-full rounded-xl border border-black/5 shadow-sm"
              onError={(e) => {
                // proxied image loads can race the SW/transport under burst —
                // retry once with the same URL before giving up
                const img = e.currentTarget;
                if (img.dataset.retried) return;
                img.dataset.retried = "1";
                img.src = b.src;
              }}
            />
            {(b.caption || b.alt) && (
              <figcaption className={`mt-2 text-center text-[0.82em] italic ${t.muted}`}>{b.caption || b.alt}</figcaption>
            )}
          </figure>,
        );
        break;
      case "rule":
        out.push(<hr key={i} className={`my-8 border-0 h-px ${t.rule}`} />);
        break;
    }
    i++;
  }
  return <>{out}</>;
}

export default function ReaderView({ tabId, navSeq, tabLoading, url, getFrameDoc, onClose, onNavigate }: ReaderViewProps) {
  const [doc, setDoc] = useState<ReaderDoc | null>(null);
  const [state, setState] = useState<"ready" | "unavailable">("ready");
  const [attempt, setAttempt] = useState(0);
  // this overlay only ever mounts after a user action (client-side), so a
  // lazy initializer can safely read persisted appearance preferences
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => {
    const fallback: ReaderPrefs = { theme: "dark", font: "serif", size: 1 };
    if (typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(READER_KEY);
      if (!raw) return fallback;
      const p = JSON.parse(raw) as Partial<ReaderPrefs>;
      return {
        theme: p.theme && THEME_ORDER.includes(p.theme) ? p.theme : fallback.theme,
        font: p.font === "sans" || p.font === "serif" ? p.font : fallback.font,
        size: typeof p.size === "number" && p.size > 0 ? p.size : fallback.size,
      };
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(READER_KEY, JSON.stringify(prefs));
    } catch {
      /* quota — ignore */
    }
  }, [prefs]);

  // extraction: runs once the frame settles (or on manual retry). While a
  // navigation is in flight the previous article simply stays on screen —
  // no spinner flash between pages.
  useEffect(() => {
    if (tabLoading) return;
    let alive = true;
    const t = setTimeout(() => {
      if (!alive) return;
      const frameDoc = getFrameDoc();
      let prefix: string | null = null;
      try {
        const w = frameDoc?.defaultView;
        if (w) prefix = scramjetFramePrefix(w.location.href);
      } catch {
        prefix = null;
      }
      const extracted = frameDoc ? extractReaderDoc(frameDoc, url ?? "", prefix) : null;
      if (!alive) return;
      if (extracted) {
        setDoc(extracted);
        setState("ready");
      } else {
        setDoc(null);
        setState("unavailable");
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [tabId, navSeq, tabLoading, attempt, url, getFrameDoc]);

  // Escape exits the reader
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // print the clean article (also used by the Ctrl+P bridge from the host app)
  const printArticle = useCallback(() => {
    if (!doc) return;
    printHtml(readerToPrintableHtml(doc), doc.title);
  }, [doc]);

  useEffect(() => {
    const handler = () => printArticle();
    window.addEventListener("cw-print-reader", handler);
    return () => window.removeEventListener("cw-print-reader", handler);
  }, [printArticle]);

  const t = THEMES[prefs.theme];
  const host = useMemo(() => (url ? hostOf(url) : null), [url]);
  const published = useMemo(() => formatPublished(doc?.published ?? null), [doc]);
  const sizeIdx = Math.max(0, SIZES.findIndex((s) => s >= prefs.size - 1e-9));

  const openLink = (href: string) => {
    onClose();
    onNavigate(href);
  };

  return (
    <div role="region" aria-label="Reader mode" className={`cw-reader-enter absolute inset-0 z-[35] overflow-y-auto ${t.wrapper}`}>
      {/* top bar */}
      <div className={`sticky top-0 z-10 flex h-11 shrink-0 items-center gap-3 border-b px-3 backdrop-blur ${t.bar}`}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Exit reader mode (Escape)"
          title="Exit reader mode (Escape)"
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          Exit reader
        </button>
        <div className={`flex min-w-0 flex-1 items-center justify-center gap-2 text-xs ${t.muted}`}>
          {state === "ready" && doc ? (
            <>
              <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{host ?? doc.url}</span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 tabular-nums">{doc.readingMinutes} min read</span>
            </>
          ) : (
            <span className="truncate">{host ?? "Reader mode"}</span>
          )}
        </div>
        {state === "ready" && doc && (
          <button
            type="button"
            onClick={printArticle}
            aria-label="Print or save the article as PDF"
            title="Print / save as PDF (Ctrl+P)"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium opacity-70 transition-opacity hover:opacity-100"
          >
            <Printer className="h-3.5 w-3.5" aria-hidden="true" />
            Print
          </button>
        )}
        {state === "unavailable" && (
          <button
            type="button"
            onClick={() => setAttempt((a) => a + 1)}
            aria-label="Try extraction again"
            title="Try again"
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium opacity-70 transition-opacity hover:opacity-100"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry
          </button>
        )}
      </div>

      {!doc && state === "ready" && (
        <div className="flex flex-col items-center justify-center gap-3 py-32" role="status" aria-live="polite">
          <Loader2 className="h-6 w-6 animate-spin opacity-60" aria-hidden="true" />
          <p className={`text-sm ${t.muted}`}>Preparing reading view...</p>
        </div>
      )}

      {!doc && state === "unavailable" && (
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-32 text-center">
          <span className={`flex h-12 w-12 items-center justify-center rounded-2xl border ${prefs.theme === "dark" ? "border-zinc-800" : ""}`}>
            <BookOpen className="h-5 w-5 opacity-50" aria-hidden="true" />
          </span>
          <h2 className={`text-base font-semibold ${t.heading}`}>Reader mode is unavailable on this page</h2>
          <p className={`text-sm leading-relaxed ${t.muted}`}>
            The page does not look like an article — it may be a list, a dashboard, or mostly interactive content. You can retry
            after it finishes loading, or read it as rendered.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium opacity-80 transition-opacity hover:opacity-100"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium opacity-80 transition-opacity hover:opacity-100"
            >
              Back to page
            </button>
          </div>
        </div>
      )}

      {doc && (
        <article className="mx-auto w-full max-w-2xl px-6 pb-40 pt-10 sm:px-8" style={{ fontFamily: prefs.font === "serif" ? SERIF_STACK : SANS_STACK, fontSize: `${prefs.size * 17}px` }}>
          <h1 className={`text-[1.9em] font-bold leading-tight tracking-tight ${t.heading}`}>{doc.title}</h1>
          {(doc.byline || published) && (
            <p className={`mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.82em] ${t.muted}`}>
              {doc.byline && <span className="font-medium">{doc.byline}</span>}
              {doc.byline && published && <span aria-hidden="true">·</span>}
              {published && <time dateTime={doc.published ?? undefined}>{published}</time>}
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{doc.words.toLocaleString()} words</span>
            </p>
          )}
          <div className={`mt-4 mb-6 h-px w-16 ${t.rule}`} aria-hidden="true" />
          <BlockList doc={doc} t={t} onOpen={openLink} />
        </article>
      )}

      {/* floating appearance controls */}
      <div
        className={`fixed bottom-5 right-5 z-20 flex items-center gap-0.5 rounded-full border px-1.5 py-1 shadow-2xl shadow-black/30 ${t.bar}`}
        role="group"
        aria-label="Reader appearance"
      >
        <button
          type="button"
          onClick={() => setPrefs((p) => ({ ...p, size: SIZES[Math.max(0, sizeIdx - 1)] }))}
          disabled={sizeIdx <= 0}
          aria-label="Decrease text size"
          title="Decrease text size"
          className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold opacity-70 transition-opacity hover:opacity-100 disabled:opacity-25"
        >
          A-
        </button>
        <span className={`min-w-[3ch] text-center text-[10px] font-medium tabular-nums ${t.muted}`} aria-live="polite">
          {Math.round(prefs.size * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setPrefs((p) => ({ ...p, size: SIZES[Math.min(SIZES.length - 1, sizeIdx + 1)] }))}
          disabled={sizeIdx >= SIZES.length - 1}
          aria-label="Increase text size"
          title="Increase text size"
          className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold opacity-70 transition-opacity hover:opacity-100 disabled:opacity-25"
        >
          A+
        </button>
        <span className={`mx-1 h-4 w-px ${t.rule}`} aria-hidden="true" />
        <button
          type="button"
          onClick={() => setPrefs((p) => ({ ...p, font: p.font === "serif" ? "sans" : "serif" }))}
          aria-label={`Switch to ${prefs.font === "serif" ? "sans-serif" : "serif"} typeface`}
          title={`${prefs.font === "serif" ? "Sans-serif" : "Serif"} typeface`}
          className="flex h-8 w-8 items-center justify-center rounded-full opacity-70 transition-opacity hover:opacity-100"
        >
          <Type className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setPrefs((p) => ({ ...p, theme: THEME_ORDER[(THEME_ORDER.indexOf(p.theme) + 1) % THEME_ORDER.length] }))}
          aria-label={`Switch theme (current: ${prefs.theme})`}
          title={`Theme: ${prefs.theme}`}
          className="flex h-8 w-8 items-center justify-center rounded-full opacity-70 transition-opacity hover:opacity-100"
        >
          {prefs.theme === "dark" ? <Moon className="h-3.5 w-3.5" aria-hidden="true" /> : prefs.theme === "paper" ? <Sun className="h-3.5 w-3.5" aria-hidden="true" /> : <Coffee className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
