"use client";

/**
 * TabStrip — Chrome-style tab bar: brand mark, tab buttons with favicons,
 * spinners while loading, close buttons, a new-tab button, and a right-click
 * context menu (reload / duplicate / close others / close to the right).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Globe, Loader2, Plus, RotateCw, SquareX, X, XSquare } from "lucide-react";
import { faviconUrl, hostOf, type Tab } from "@/lib/browser/shared";

interface TabStripProps {
  tabs: Tab[];
  activeId: string;
  /** tab ids recently opened in the background — their titles flash once */
  flashIds?: string[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReload: (id: string) => void;
  onDuplicate: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseRight: (id: string) => void;
  /** drag-to-reorder: move `fromId` to the left/right side of `toId` */
  onReorder: (fromId: string, toId: string, side: "left" | "right") => void;
  /** opens the tab search overlay (Ctrl+Shift+A) */
  onSearchTabs: () => void;
}

function TabFavicon({ url, loading }: { url: string | null; loading: boolean }) {
  const [errHost, setErrHost] = useState<string | null>(null);
  const host = url ? hostOf(url) : null;
  const errored = !!host && errHost === host;
  if (loading) return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-400" aria-hidden="true" />;
  if (!url || !host || errored) return <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />;
  return <img src={faviconUrl(host)} alt="" width={14} height={14} className="h-3.5 w-3.5 shrink-0" onError={() => setErrHost(host)} />;
}

interface MenuState {
  id: string;
  x: number;
  y: number;
  hasRight: boolean;
  hasOthers: boolean;
}

export default function TabStrip({ tabs, activeId, flashIds, onSelect, onClose, onNew, onReload, onDuplicate, onCloseOthers, onCloseRight, onReorder, onSearchTabs }: TabStripProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // drag-to-reorder state (HTML5 DnD, desktop pointer only)
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overSide, setOverSide] = useState<"left" | "right">("right");

  const clearDrag = () => {
    setDragId(null);
    setOverId(null);
    setOverSide("right");
  };

  // close the context menu on any outside interaction
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  // keep the menu inside the viewport
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    if (x !== menu.x || y !== menu.y) setMenu((m) => (m ? { ...m, x, y } : m));
  }, [menu]);

  const openMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.id === id);
    setMenu({
      id,
      x: e.clientX,
      y: e.clientY,
      hasRight: idx >= 0 && idx < tabs.length - 1,
      hasOthers: tabs.length > 1,
    });
  };

  const menuTab = menu ? tabs.find((t) => t.id === menu.id) : null;

  const menuItems = menu
    ? [
        {
          label: "Reload",
          icon: RotateCw,
          hint: "",
          disabled: false,
          run: () => onReload(menu.id),
        },
        {
          label: "Duplicate",
          icon: Copy,
          hint: "",
          disabled: false,
          run: () => onDuplicate(menu.id),
        },
        {
          label: "Close other tabs",
          icon: XSquare,
          hint: "",
          disabled: !menu.hasOthers,
          run: () => onCloseOthers(menu.id),
        },
        {
          label: "Close tabs to the right",
          icon: SquareX,
          hint: "",
          disabled: !menu.hasRight,
          run: () => onCloseRight(menu.id),
        },
      ]
    : [];

  return (
    <div role="tablist" aria-label="Browser tabs" className="cw-scroll flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900/60 px-2 pt-2">
      <div className="mr-1 hidden h-8 shrink-0 items-center gap-1.5 pl-1 pr-2 sm:flex">
        <span className="flex h-6 w-6 items-center justify-center rounded-md border border-emerald-400/30 bg-zinc-900">
          <Globe className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
        </span>
        <span className="text-xs font-semibold tracking-wide text-zinc-400">Browser</span>
      </div>

      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const dragging = dragId === tab.id;
        const showIndicator = overId === tab.id && dragId !== null && !dragging;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", tab.id);
              setDragId(tab.id);
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === tab.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              const side = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
              if (overId !== tab.id || overSide !== side) {
                setOverId(tab.id);
                setOverSide(side);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dragId !== tab.id) onReorder(dragId, tab.id, overSide);
              clearDrag();
            }}
            onDragEnd={clearDrag}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(tab.id);
            }}
            onContextMenu={(e) => openMenu(e, tab.id)}
            title={tab.url ?? "New tab"}
            className={`group relative flex shrink-0 items-center gap-2 px-3 text-xs transition-[height,background-color,color] duration-150 ${
              active
                ? "h-9 min-w-[130px] max-w-[230px] rounded-t-lg bg-zinc-800 text-zinc-100 shadow-[inset_0_1px_0_0_rgba(52,211,153,0.55)]"
                : "h-8 min-w-[130px] max-w-[230px] rounded-t-md bg-zinc-900/40 text-zinc-500 hover:bg-zinc-900/80 hover:text-zinc-300"
            } ${dragging ? "opacity-40" : ""}`}
          >
            {showIndicator && (
              <span
                aria-hidden="true"
                className={`absolute inset-y-0 w-0.5 rounded-full bg-emerald-400 ${overSide === "left" ? "-left-0.5" : "-right-0.5"}`}
              />
            )}
            <TabFavicon url={tab.url} loading={tab.loading} />
            <span className={`min-w-0 flex-1 truncate text-left ${flashIds?.includes(tab.id) ? "cw-tab-flash" : ""}`}>{tab.title || "New tab"}</span>
            {tab.zoom !== 1 && (
              <span className="shrink-0 rounded-sm bg-zinc-700/60 px-1 text-[9px] font-medium tabular-nums text-zinc-300" title={`Zoomed to ${Math.round(tab.zoom * 100)}%`}>
                {Math.round(tab.zoom * 100)}%
              </span>
            )}
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Close ${tab.title || "tab"}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className={`cw-tab-close flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors ${
                active ? "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100" : "text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
              } ${tabs.length === 1 ? "opacity-40" : "opacity-0 group-hover:opacity-100"}`}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </span>
          </button>
        );
      })}

      <button
        type="button"
        onClick={onNew}
        aria-label="New tab"
        title="New tab (Ctrl+T)"
        className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>

      {/* Chrome-style tab-search pill at the end of the strip */}
      <button
        type="button"
        onClick={onSearchTabs}
        aria-label="Search tabs"
        title="Search tabs (Ctrl+Shift+A)"
        className="mb-0.5 ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 sm:ml-1"
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>

      {menu && menuTab && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Tab menu for ${menuTab.title || "tab"}`}
          style={{ left: menu.x, top: menu.y }}
          className="cw-menu-enter fixed z-50 min-w-[210px] overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1.5 text-xs shadow-2xl shadow-black/60"
        >
          <p className="mb-1 truncate border-b border-zinc-800 px-3 pb-1.5 text-[11px] text-zinc-500" title={menuTab.url ?? "New tab"}>
            {menuTab.title || "New tab"}
          </p>
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.run();
                setMenu(null);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
            >
              <item.icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
