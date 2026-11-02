"use client";

import { useId, useRef, useState } from "react";
import { ExternalLink, FileArchive, Info, Loader2, Puzzle, ShieldCheck, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { installExtension, parseExtensionArchive, parseUserscript, removeExtension, setExtensionEnabled, useExtensions, type ExtensionPackage } from "@/lib/browser/extensions";

export default function ExtensionsPage() {
  const extensions = useExtensions();
  const inputRef = useRef<HTMLInputElement>(null);
  const trustId = useId();
  const [pending, setPending] = useState<ExtensionPackage | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [reading, setReading] = useState(false);

  const openPackage = async (file: File) => {
    setReading(true);
    try {
      if (!/\.(?:zip|user\.js)$/i.test(file.name)) throw new Error("Import a compatible ZIP or .user.js script. Native Chrome CRX packages require a real Chrome browser.");
      if (file.size > 3 * 1024 * 1024) throw new Error("Choose an extension ZIP under 3 MB.");
      const extension = /\.user\.js$/i.test(file.name) ? parseUserscript(await file.text()) : parseExtensionArchive(new Uint8Array(await file.arrayBuffer()));
      setTrusted(false);
      setPending(extension);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The extension package could not be read.");
    } finally { setReading(false); }
  };

  return (
    <div className="cw-scroll cw-backdrop h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900"><Puzzle className="h-5 w-5 text-emerald-300" aria-hidden="true" /></span>
            <div><h1 className="text-xl font-semibold text-zinc-100">Extensions</h1><p className="mt-1 text-xs text-zinc-500">Manifest V3 · Page scripts and styles</p></div>
          </div>
          <button type="button" disabled={reading} onClick={() => inputRef.current?.click()} className="inline-flex h-9 items-center gap-2 rounded-md bg-emerald-300 px-3 text-xs font-semibold text-zinc-950 hover:bg-emerald-200 disabled:opacity-50">
            {reading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />} Import extension or script
          </button>
          <input ref={inputRef} type="file" accept=".zip,.user.js,application/zip,text/javascript,application/javascript" aria-label="Extension ZIP file" className="hidden" onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void openPackage(file);
          }} />
        </header>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="text-zinc-500">{extensions.length} installed</span>
          <button type="button" title="Only compatible page-script/style ZIPs run here, in page context. Native Chrome extensions, browser APIs, and background workers require a real Chrome browser." aria-label="Extension compatibility" className="inline-flex items-center gap-1.5 text-zinc-500 hover:text-zinc-200"><Info className="h-3.5 w-3.5" aria-hidden="true" /> Compatibility</button>
        </div>

        {extensions.length ? <div className="mt-3 divide-y divide-zinc-800">
          {extensions.map((extension) => (
            <article key={extension.id} className="flex items-start gap-3 py-5 sm:gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900"><Puzzle className="h-5 w-5 text-zinc-500" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-sm font-medium text-zinc-100">{extension.name}</h2>
                <p className="mt-1 text-xs text-zinc-500">Version {extension.version} · {extension.enabled ? "Enabled" : "Disabled"}</p>
                {extension.description && <p className="mt-2 break-words text-xs leading-relaxed text-zinc-400">{extension.description}</p>}
                <ul className="mt-2 space-y-1 text-xs text-zinc-600" aria-label={`${extension.name} sites`}>
                  {[...new Set(extension.rules.flatMap((rule) => rule.matches))].map((pattern) => <li key={pattern} className="break-all font-mono">{pattern}</li>)}
                </ul>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <input type="checkbox" role="switch" checked={extension.enabled} aria-label={`Enable ${extension.name}`} onChange={(event) => {
                  try { setExtensionEnabled(extension.id, event.target.checked); toast.success("Extension updated. Reload matching pages to apply."); } catch (error) { toast.error((error as Error).message); }
                }} className="h-4 w-4 accent-emerald-400" />
                <button type="button" aria-label={`Remove ${extension.name}`} title={`Remove ${extension.name}`} onClick={() => {
                  if (!window.confirm(`Remove ${extension.name}?`)) return;
                  try { removeExtension(extension.id); toast.success("Extension removed. Reload matching pages to apply."); } catch (error) { toast.error((error as Error).message); }
                }} className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
              </div>
            </article>
          ))}
        </div> : <div className="flex min-h-56 flex-col items-center justify-center gap-3 border-b border-zinc-800 text-zinc-600"><FileArchive className="h-9 w-9" aria-hidden="true" /><p className="text-sm">No extensions installed</p></div>}

        <a href="https://chromewebstore.google.com/" target="_blank" rel="noopener noreferrer" className="mt-6 inline-flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-200">Chrome Web Store <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
      </div>

      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent className="cw-scroll max-h-[85dvh] w-[calc(100%-32px)] max-w-md overflow-y-auto rounded-lg border-zinc-700 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Install {pending?.name}?</DialogTitle>
            <DialogDescription>Imported code can read and modify matching pages. Only install code you trust.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 border-y border-zinc-800 py-4">
            <p className="text-xs text-zinc-500">Version {pending?.version} · Page context</p>
            <ul className="space-y-1 break-all font-mono text-xs text-zinc-400" aria-label="Requested sites">{[...new Set(pending?.rules.flatMap((rule) => rule.matches) ?? [])].map((pattern) => <li key={pattern}>{pattern}</li>)}</ul>
          </div>
          <label htmlFor={trustId} className="flex items-start gap-3 text-xs leading-relaxed text-zinc-300"><input id={trustId} type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-400" />I trust this extension to read and change matching pages.</label>
          <button type="button" disabled={!trusted || !pending} onClick={() => {
            if (!pending || !trusted) return;
            try { installExtension(pending); setPending(null); toast.success("Extension installed. Reload matching pages to apply."); } catch (error) { toast.error((error as Error).message); }
          }} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-300 text-sm font-semibold text-zinc-950 disabled:opacity-40"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Install extension</button>
        </DialogContent>
      </Dialog>
    </div>
  );
}