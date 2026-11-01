"use client";

/**
 * TabSearch — Chrome's "Search tabs" overlay (Ctrl+Shift+A or the chevron
 * pill on the tab strip): type to filter open tabs by title or URL, move
 * with the arrow keys, Enter to switch. Dimmed backdrop, click-outside and
 * Escape close it. The current tab is marked with a "Current" pill.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Globe, Search } from "lucide-react";
import { faviconUrl, hostOf, type Tab } from "@/lib/browser/shared";

interface TabSearchProps {
  tabs: Tab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

function ResultFavicon({ url }: { url: string | null }) {
  const [errHost, setErrHost] = useState<string | null>(null);
  const host = url ? hostOf(url) : null;
  if (!url || !host || errHost === host) return <Globe className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />;
  return <img src={faviconUrl(host)} alt="" width={16} height={16} className="h-4 w-4 shrink-0" onError={() => setErrHost(host)} />;
}

export default function TabSearch({ tabs, activeId, onSelect, onClose }: TabSearchProps) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return tabs;
    return tabs.filter(
      (t) =>
        (t.title || "New tab").toLowerCase().includes(needle) ||
        (t.url ?? "").toLowerCase().includes(needle),
    );
  }, [tabs, q]);

  // reset the selection whenever the query changes (adjust-during-render
  // pattern — no effect needed)
  const [prevQ, setPrevQ] = useState(q);
  if (prevQ !== q) {
    setPrevQ(q);
    setSel(0);
  }

  // autofocus the input on open
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  // keep the selected row in view
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (id: string) => {
    onSelect(id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[sel];
      if (target) pick(target.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search tabs"
        className="cw-menu-enter fixed left-1/2 top-16 z-[61] w-[min(92vw,30rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 shadow-2xl shadow-black/70"
      >
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search open tabs"
            aria-label="Search open tabs"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="tab-search-list"
            aria-activedescendant={results[sel] ? `tab-search-opt-${results[sel].id}` : undefined}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <kbd className="shrink-0 rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400" aria-hidden="true">
            Esc
          </kbd>
        </div>

        <ul
          ref={listRef}
          id="tab-search-list"
          role="listbox"
          aria-label="Matching tabs"
          className="cw-scroll max-h-72 overflow-y-auto py-1.5"
        >
          {results.map((t, i) => {
            const selected = i === sel;
            const host = t.url ? hostOf(t.url) : null;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  role="option"
                  id={`tab-search-opt-${t.id}`}
                  aria-selected={selected}
                  data-selected={selected}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(t.id)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                    selected ? "bg-zinc-800" : "hover:bg-zinc-800/60"
                  }`}
                >
                  <ResultFavicon url={t.url} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${t.id === activeId ? "font-medium text-zinc-100" : "text-zinc-300"}`}>
                      {t.title || "New tab"}
                    </span>
                    <span className="block truncate text-xs text-zinc-500">{host ?? "New tab page"}</span>
                  </span>
                  {t.loading && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 cw-pulse" aria-label="Loading" />
                  )}
                  {t.id === activeId && (
                    <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                      Current
                    </span>
                  )}
                  {selected && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
          {results.length === 0 && (
            <li className="px-4 py-6 text-center">
              <p className="text-sm text-zinc-400">No matching tabs</p>
              <p className="mt-1 text-xs text-zinc-600">Try a different title or address</p>
            </li>
          )}
        </ul>

        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2 text-[10px] text-zinc-600">
          <span>
            {results.length} of {tabs.length} tabs
          </span>
          <span className="flex items-center gap-2">
            <span>Enter switch</span>
            <span aria-hidden="true">·</span>
            <span>up/down browse</span>
            <span aria-hidden="true">·</span>
            <span>Esc close</span>
          </span>
        </div>
      </div>
    </>
  );
}
