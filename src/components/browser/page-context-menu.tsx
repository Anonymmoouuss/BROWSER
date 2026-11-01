"use client";

/**
 * PageContextMenu — Chrome-style right-click menu for proxied pages.
 *
 * FrameView suppresses the browser default inside frames and hands up a
 * PageMenuTarget (link / image under the cursor + top-window coordinates);
 * this component renders the menu: link actions (open in new tab, save link
 * as, copy address), image actions (open image, save image as, copy address)
 * and page navigation (back / forward / reload). Closes on outside click,
 * Escape, resize or window blur, and clamps itself inside the viewport.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  FileDown,
  ImageIcon,
  RotateCw,
} from "lucide-react";
import type { PageMenuTarget } from "@/lib/browser/shared";

interface PageContextMenuProps {
  target: PageMenuTarget;
  canBack: boolean;
  canFwd: boolean;
  onClose: () => void;
  /** opens a URL as a new tab; background=true keeps the current tab active (Chrome behavior) */
  onOpenTab: (url: string, background?: boolean) => void;
  /** (sameOriginFetchHref, displayUrl, filename|null, sourceUrlOrEmpty) */
  onDownload: (fetchHref: string, displayUrl: string, filename: string | null, sourceUrl: string) => void;
  onCopy: (text: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}

interface MenuItem {
  key: string;
  label: string;
  icon: typeof ExternalLink;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

export default function PageContextMenu(props: PageContextMenuProps) {
  const { target, canBack, canFwd, onClose, onOpenTab, onDownload, onCopy, onBack, onForward, onReload } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: target.x, y: target.y });

  // close on outside press / Escape / resize / blur
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onHide = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onHide);
    window.addEventListener("resize", onHide);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onHide);
      window.removeEventListener("resize", onHide);
    };
  }, [onClose]);

  // clamp inside the viewport (once measured)
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(pos.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(pos.y, window.innerHeight - rect.height - 8));
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [target]);

  const groups: MenuItem[][] = [];
  if (target.link) {
    const link = target.link;
    groups.push([
      // Chrome opens context-menu links in the background — the current tab
      // stays active and the new tab loads with its spinner in the strip.
      { key: "link-open", label: "Open link in new tab", icon: ExternalLink, run: () => onOpenTab(link.url, true) },
      { key: "link-save", label: "Save link as...", icon: FileDown, run: () => onDownload(link.fetchHref, link.url, null, "") },
      { key: "link-copy", label: "Copy link address", icon: Copy, run: () => onCopy(link.url) },
    ]);
  }
  if (target.image) {
    const image = target.image;
    groups.push([
      { key: "img-open", label: "Open image in new tab", icon: ImageIcon, run: () => onOpenTab(image.url, true) },
      { key: "img-save", label: "Save image as...", icon: FileDown, run: () => onDownload(image.fetchHref, image.url, null, "") },
      { key: "img-copy", label: "Copy image address", icon: Copy, run: () => onCopy(image.url) },
    ]);
  }
  groups.push([
    { key: "nav-back", label: "Back", icon: ArrowLeft, hint: "Alt+Left", disabled: !canBack, run: onBack },
    { key: "nav-fwd", label: "Forward", icon: ArrowRight, hint: "Alt+Right", disabled: !canFwd, run: onForward },
    { key: "nav-reload", label: "Reload", icon: RotateCw, hint: "F5", run: onReload },
  ]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Page menu"
      style={{ left: pos.x, top: pos.y }}
      className="cw-menu-enter fixed z-50 w-64 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900/95 py-1 text-xs shadow-2xl shadow-black/70 backdrop-blur"
      onContextMenu={(e) => e.preventDefault()}
    >
      {target.link && target.linkText && (
        <p className="mb-1 truncate border-b border-zinc-800 px-3 py-1.5 text-[11px] italic text-zinc-500" title={target.linkText}>
          {target.linkText}
        </p>
      )}
      {groups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="my-1 h-px bg-zinc-800" aria-hidden="true" />}
          {group.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.run();
              }}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <item.icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-[10px] text-zinc-600">{item.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
