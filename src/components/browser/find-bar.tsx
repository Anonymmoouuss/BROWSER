"use client";

/**
 * FindBar — Chrome-style find-in-page (Ctrl+F).
 *
 * Searches the ACTIVE tab's live iframe document (same-origin under the
 * proxy engine), highlights every match with the CSS Custom Highlight API
 * (zero DOM mutation — React sites keep working), and steps through matches
 * with next/prev, Enter/Shift+Enter and wrap-around. The active match gets
 * its own highlight color and scrolls into view.
 *
 * While open, a keydown listener is also attached INSIDE the iframe window
 * (same-origin access) so Ctrl+F refocuses the find input and Escape closes
 * even when the page content has focus.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

const FIND_STYLE_ID = "cw-find-highlights";
const FIND_STYLE_CSS =
  "::highlight(cw-find){background-color:rgba(52,211,153,0.38);color:inherit}" +
  "::highlight(cw-find-active){background-color:#fbbf24;color:#18181b}";
const MATCH_LIMIT = 800;

interface FindBarProps {
  /** active tab id — switching tabs re-runs the search on the new frame */
  tabId: string;
  onClose: () => void;
  getFrameDoc: () => Document | null;
}

function injectFindStyles(doc: Document) {
  if (doc.getElementById(FIND_STYLE_ID)) return;
  const st = doc.createElement("style");
  st.id = FIND_STYLE_ID;
  st.textContent = FIND_STYLE_CSS;
  (doc.head ?? doc.documentElement).appendChild(st);
}

function clearFindStyles(doc: Document | null) {
  if (!doc) return;
  doc.getElementById(FIND_STYLE_ID)?.remove();
  const w = doc.defaultView as (Window & typeof globalThis) | null;
  try {
    w?.CSS?.highlights?.delete("cw-find");
    w?.CSS?.highlights?.delete("cw-find-active");
  } catch {
    /* highlight registry unsupported — fine */
  }
}

function findMatches(doc: Document, query: string): Range[] {
  const ranges: Range[] = [];
  if (!doc.body || query.length < 1) return ranges;
  const lower = query.toLowerCase();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA" || tag === "INPUT") {
        return NodeFilter.FILTER_REJECT;
      }
      if (!parent.isConnected) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(lower)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode()) && ranges.length < MATCH_LIMIT) {
    const text = (node.nodeValue ?? "").toLowerCase();
    let idx = text.indexOf(lower);
    while (idx !== -1 && ranges.length < MATCH_LIMIT) {
      const r = doc.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + lower.length);
      ranges.push(r);
      idx = text.indexOf(lower, idx + lower.length);
    }
  }
  return ranges;
}

function applyHighlights(doc: Document, ranges: Range[], activeIdx: number): boolean {
  const w = doc.defaultView as (Window & typeof globalThis) | null;
  const HighlightCtor = (w as unknown as { Highlight?: new (...r: Range[]) => unknown } | undefined)?.Highlight;
  const registry = w?.CSS?.highlights;
  if (!HighlightCtor || !registry) return false;
  try {
    registry.delete("cw-find");
    registry.delete("cw-find-active");
    if (ranges.length) {
      registry.set("cw-find", new HighlightCtor(...ranges) as unknown as never);
      if (ranges[activeIdx]) {
        registry.set("cw-find-active", new HighlightCtor(ranges[activeIdx]) as unknown as never);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function scrollToRange(range: Range) {
  try {
    range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch {
    /* node detached mid-search */
  }
}

export default function FindBar({ tabId, onClose, getFrameDoc }: FindBarProps) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rangesRef = useRef<Range[]>([]);
  const docRef = useRef<Document | null>(null);

  // focus the input on open
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  // Ctrl+F / Escape while the iframe content has focus (iframe keydowns do
  // not bubble to this window — attach inside the frame's own window)
  useEffect(() => {
    const doc = getFrameDoc();
    const w = doc?.defaultView as (Window & typeof globalThis) | null;
    if (!doc || !w) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    w.addEventListener("keydown", onKey, true);
    return () => w.removeEventListener("keydown", onKey, true);
  }, [tabId]);

  // search (debounced) whenever the query or the active tab changes
  useEffect(() => {
    const t = setTimeout(() => {
      const prevDoc = docRef.current;
      if (prevDoc) clearFindStyles(prevDoc);
      const doc = getFrameDoc();
      docRef.current = doc;
      if (!doc || query.trim().length < 1) {
        rangesRef.current = [];
        setCount(0);
        setIdx(0);
        return;
      }
      injectFindStyles(doc);
      const ranges = findMatches(doc, query.trim());
      rangesRef.current = ranges;
      applyHighlights(doc, ranges, 0);
      if (ranges[0]) scrollToRange(ranges[0]);
      setCount(ranges.length);
      setIdx(0);
    }, 180);
    return () => clearTimeout(t);
  }, [query, tabId]);

  // clear highlights when the bar unmounts (read the ref INSIDE the cleanup —
  // the document is only known after the first search runs)
  useEffect(() => {
    return () => {
      clearFindStyles(docRef.current);
    };
  }, []);

  const step = (dir: 1 | -1) => {
    const ranges = rangesRef.current;
    if (!ranges.length) return;
    const next = (idx + dir + ranges.length) % ranges.length;
    setIdx(next);
    const doc = docRef.current;
    if (doc) applyHighlights(doc, ranges, next);
    scrollToRange(ranges[next]);
  };

  const noMatch = query.trim().length > 0 && count === 0;

  return (
    <div
      role="search"
      aria-label="Find in page"
      className="absolute right-3 top-3 z-30 flex h-10 items-center gap-1 rounded-xl border border-zinc-700 bg-zinc-900 pl-3 pr-1 shadow-2xl shadow-black/50"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
        autoComplete="off"
        className={`w-44 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500 sm:w-56 ${
          noMatch ? "text-red-400" : ""
        }`}
      />
      <span
        className={`min-w-[52px] shrink-0 text-right text-xs tabular-nums ${noMatch ? "text-red-400" : "text-zinc-500"}`}
        aria-live="polite"
      >
        {count > 0 ? `${idx + 1}/${count}` : noMatch ? "0/0" : ""}
      </span>
      <span className="mx-0.5 h-5 w-px bg-zinc-700" aria-hidden="true" />
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={count === 0}
        aria-label="Previous match (Shift+Enter)"
        title="Previous match (Shift+Enter)"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
      >
        <ChevronUp className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={count === 0}
        aria-label="Next match (Enter)"
        title="Next match (Enter)"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close find bar (Esc)"
        title="Close (Esc)"
        className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
