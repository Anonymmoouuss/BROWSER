"use client";

/**
 * BookmarksPage — the about:bookmarks internal page (Chrome-style bookmark
 * manager): searchable website and JavaScript editing, explicit page-target
 * execution, per-entry delete, websites-only open-all and two-step clear-all.
 */

import { useMemo, useState } from "react";
import { BookOpen, Bookmark, Code2, Globe, Pencil, Play, Plus, Search, Star, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { faviconUrl, hostOf, type Bookmark as BookmarkT } from "@/lib/browser/shared";
import { bookmarkletSource, createBookmarklet, isBookmarklet } from "@/lib/browser/bookmarklets";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface BookmarksPageProps {
  bookmarks: BookmarkT[];
  onNavigate: (input: string) => void;
  onOpenAll: (urls: string[]) => void;
  onSave: (originalUrl: string | null, bookmark: BookmarkT) => void;
  targets: { id: string; title: string; url: string }[];
  onRun: (bookmark: BookmarkT, targetId: string) => void;
  onDelete: (url: string) => void;
  onClear: () => void;
}

const OPEN_ALL_CAP = 8;

export default function BookmarksPage({ bookmarks, onNavigate, onOpenAll, onSave, targets, onRun, onDelete, onClear }: BookmarksPageProps) {
  const [q, setQ] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [editor, setEditor] = useState<{ originalUrl: string | null; title: string; value: string; kind: "website" | "script" } | null>(null);
  const [error, setError] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("");
  const targetId = targets.some((target) => target.id === selectedTarget) ? selectedTarget : targets[0]?.id ?? "";

  const entries = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return bookmarks.filter(
      (b) => needle === "" || b.url.toLowerCase().includes(needle) || (b.title ?? "").toLowerCase().includes(needle),
    );
  }, [bookmarks, q]);

  const startEdit = (bookmark?: BookmarkT) => {
    setError("");
    const script = bookmark ? isBookmarklet(bookmark.url) : false;
    let value = bookmark?.url ?? "";
    if (script) {
      try { value = bookmarkletSource(value); } catch { value = ""; }
    }
    setEditor({ originalUrl: bookmark?.url ?? null, title: bookmark?.title ?? "", value, kind: script ? "script" : "website" });
  };

  const save = () => {
    if (!editor) return;
    try {
      let bookmark: BookmarkT;
      if (editor.kind === "script") {
        bookmark = createBookmarklet(editor.title, editor.value);
      } else {
        if (!editor.title.trim()) throw new Error("Enter a bookmark name.");
        const value = editor.value.trim();
        const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
        if (!/^https?:$/.test(url.protocol)) throw new Error("Use an HTTP(S) URL, or choose JavaScript for a bookmarklet.");
        bookmark = { title: editor.title.trim(), url: url.href };
      }
      onSave(editor.originalUrl, bookmark);
      setEditor(null);
      toast.success(editor.kind === "script" ? "Bookmarklet saved" : "Bookmark saved");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this bookmark.");
    }
  };

  const requestClear = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3500);
      return;
    }
    onClear();
    setConfirming(false);
    toast.success("All bookmarks removed");
  };

  return (
    <div className="cw-scroll cw-backdrop h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-5 py-7 sm:px-8 sm:py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2.5 text-xl font-semibold text-zinc-100">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-400/30 bg-zinc-900">
              <Bookmark className="h-4.5 w-4.5 text-amber-300" aria-hidden="true" />
            </span>
            Bookmarks
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => startEdit()} className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-400 px-3 text-xs font-semibold text-emerald-950 hover:bg-emerald-300">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New bookmark
            </button>
            <button
              type="button"
              onClick={() => {
                const urls = entries.filter((bookmark) => !isBookmarklet(bookmark.url)).map((bookmark) => bookmark.url);
                if (!urls.length) return;
                onOpenAll(urls.slice(0, OPEN_ALL_CAP));
                toast.success(`Opening ${Math.min(urls.length, OPEN_ALL_CAP)} bookmark${Math.min(urls.length, OPEN_ALL_CAP) > 1 ? "s" : ""}`);
              }}
              disabled={!entries.some((bookmark) => !isBookmarklet(bookmark.url))}
              title="Open saved websites only"
              className="flex h-9 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 text-xs font-medium text-zinc-400 transition-colors hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-40 disabled:hover:border-zinc-700 disabled:hover:text-zinc-400"
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
              Open all
            </button>
            <button
              type="button"
              onClick={requestClear}
              disabled={bookmarks.length === 0}
              className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors ${
                confirming
                  ? "border-red-400/60 bg-red-500/15 text-red-300 hover:bg-red-500/25"
                  : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
              }`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {confirming ? "Click again to remove all" : "Remove all"}
            </button>
          </div>
        </div>

        <div className="mt-5 flex h-10 items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/70 pl-4 pr-2 transition-colors focus-within:border-amber-400/60 focus-within:ring-2 focus-within:ring-amber-400/20">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search bookmarks"
            aria-label="Search bookmarks"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <span className="shrink-0 pr-1 text-xs tabular-nums text-zinc-600">{entries.length}</span>
        </div>

        {bookmarks.some((bookmark) => isBookmarklet(bookmark.url)) && (
          <label className="mt-5 flex flex-wrap items-center gap-3 border-b border-zinc-800 pb-5 text-xs text-zinc-400">
            <Code2 className="h-4 w-4 text-cyan-300" aria-hidden="true" /> Run on
            <select aria-label="Bookmarklet target page" value={targetId} onChange={(event) => setSelectedTarget(event.target.value)} disabled={!targets.length} className="h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-200 disabled:text-zinc-600">
              {!targets.length && <option value="">No open web pages</option>}
              {targets.map((target) => <option key={target.id} value={target.id}>{target.title} · {hostOf(target.url)}</option>)}
            </select>
          </label>
        )}

        {entries.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/60">
              <Star className="h-5 w-5 text-zinc-600" aria-hidden="true" />
            </span>
            <p className="text-sm text-zinc-400">{q ? "No bookmarks match your search" : "No bookmarks yet"}</p>
          </div>
        ) : (
          <ul className="mt-5 divide-y divide-zinc-800/70 border-y border-zinc-800/80">
            {entries.map((b, i) => {
              const host = hostOf(b.url);
              const script = isBookmarklet(b.url);
              let preview = b.url;
              if (script) {
                try { preview = bookmarkletSource(b.url).replace(/\s+/g, " "); } catch { preview = "Invalid JavaScript bookmarklet"; }
              }
              return (
                <li
                  key={b.url}
                  className={`group flex items-center gap-3 bg-zinc-900/50 px-3 py-2.5 transition-colors hover:bg-zinc-900 ${
                    i > 0 ? "border-t border-zinc-800/60" : ""
                  }`}
                >
                  {script ? (
                    <Code2 className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
                  ) : host ? (
                    <img src={faviconUrl(host)} alt="" width={16} height={16} className="h-4 w-4 shrink-0 rounded-sm" />
                  ) : (
                    <Star className="h-4 w-4 shrink-0 text-zinc-600" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    onClick={() => script ? startEdit(b) : onNavigate(b.url)}
                    className="min-w-0 flex-1 text-left"
                    title={script ? `Edit ${b.title}` : b.url}
                  >
                    <span className="block truncate text-sm text-zinc-200 group-hover:text-zinc-50">{b.title || b.url}</span>
                    <span className={`block truncate text-xs text-zinc-500 ${script ? "font-mono" : ""}`}>{preview}</span>
                  </button>
                  {script && <button type="button" onClick={() => onRun(b, targetId)} disabled={!targetId} aria-label={`Run ${b.title}`} title="Run on selected page" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-30"><Play className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                  <button
                    type="button"
                    onClick={() => startEdit(b)}
                    aria-label={`Edit ${b.title || b.url}`}
                    title="Edit"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(b.url)}
                    aria-label={`Remove ${b.title || b.url} from bookmarks`}
                    title="Remove"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Dialog open={editor !== null} onOpenChange={(open) => { if (!open) setEditor(null); }}>
        <DialogContent className="max-h-[85dvh] w-[calc(100vw_-_2rem)] overflow-y-auto border-zinc-700 bg-zinc-950 text-zinc-100 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editor?.originalUrl ? "Edit bookmark" : "New bookmark"}</DialogTitle>
            <DialogDescription>{editor?.kind === "script" ? "Scripts run with the page's permissions. Run only code you trust." : "Saved on this device."}</DialogDescription>
          </DialogHeader>
          {editor && <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-zinc-400">Type</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(["website", "script"] as const).map((kind) => <label key={kind} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${editor.kind === kind ? "border-emerald-400/60 bg-emerald-400/5 text-zinc-100" : "border-zinc-800 text-zinc-500"}`}>
                  <input type="radio" name="bookmark-type" value={kind} checked={editor.kind === kind} onChange={() => { setEditor({ ...editor, kind }); setError(""); }} className="accent-emerald-400" />
                  {kind === "script" ? <Code2 className="h-4 w-4" aria-hidden="true" /> : <Globe className="h-4 w-4" aria-hidden="true" />}
                  {kind === "script" ? "JavaScript" : "Website"}
                </label>)}
              </div>
            </fieldset>
            <label className="grid gap-2 text-xs font-medium text-zinc-400">Name
              <input autoFocus aria-label="Bookmark name" value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} required maxLength={120} className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-emerald-400" />
            </label>
            <label className="grid gap-2 text-xs font-medium text-zinc-400">{editor.kind === "script" ? "JavaScript code" : "URL"}
              {editor.kind === "script" ? <textarea aria-label="JavaScript code" value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} required maxLength={100_000} spellCheck={false} autoCapitalize="off" autoCorrect="off" className="min-h-52 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 p-3 font-mono text-xs leading-6 text-zinc-100 outline-none focus:border-emerald-400" /> : <input aria-label="Bookmark URL" value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} required placeholder="https://example.com" className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-emerald-400" />}
            </label>
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <DialogFooter>
              <button type="button" onClick={() => setEditor(null)} className="h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button>
              <button type="submit" className="h-10 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-emerald-950 hover:bg-emerald-300">{editor.kind === "script" ? "Save bookmarklet" : "Save bookmark"}</button>
            </DialogFooter>
          </form>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
