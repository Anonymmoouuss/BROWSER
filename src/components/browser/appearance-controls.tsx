"use client";

import { useRef, useState } from "react";
import { Check, ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_APPEARANCE, setAppearance, useAppearance, WALLPAPERS, type Appearance } from "@/lib/browser/appearance";

export default function AppearanceControls() {
  const appearance = useAppearance();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const update = (change: Partial<Appearance>) => {
    try { setAppearance(change); } catch (error) { toast.error((error as Error).message); }
  };

  const upload = async (file: File) => {
    setUploading(true);
    let bitmap: ImageBitmap | undefined;
    try {
      if (file.size > 8 * 1024 * 1024 || !/^image\/(?:jpeg|png|webp|avif)$/.test(file.type)) {
        throw new Error("Choose a JPEG, PNG, WebP, or AVIF image under 8 MB.");
      }
      bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1800 / bitmap.width, 1200 / bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not process the wallpaper.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL("image/webp", 0.84);
      if (image.length > 1_500_000) throw new Error("This image is too detailed to save. Choose a smaller image.");
      setAppearance({ wallpaper: "custom", customImage: image });
      toast.success("Wallpaper saved on this browser");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The image could not be loaded.");
    } finally {
      bitmap?.close();
      setUploading(false);
    }
  };

  const choices = [...WALLPAPERS, ...(appearance.customImage ? [{ id: "custom" as const, name: "My image", image: appearance.customImage }] : [])];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Wallpaper">
        {choices.map((choice) => (
          <button key={choice.id} type="button" role="radio" aria-checked={appearance.wallpaper === choice.id} aria-label={`${choice.name} wallpaper`} onClick={() => update({ wallpaper: choice.id })} className={`group overflow-hidden rounded-md border text-left transition-colors ${appearance.wallpaper === choice.id ? "border-emerald-400" : "border-zinc-700 hover:border-zinc-500"}`}>
            <span className="relative block aspect-[16/9] w-full bg-zinc-800 bg-cover bg-center" style={choice.image ? { backgroundImage: `url("${choice.image}")` } : undefined}>
              {appearance.wallpaper === choice.id && <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-300 text-zinc-950"><Check className="h-3 w-3" aria-hidden="true" /></span>}
            </span>
            <span className="block bg-zinc-900 px-2.5 py-2 text-xs font-medium text-zinc-300">{choice.name}</span>
          </button>
        ))}
      </div>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" aria-label="Upload wallpaper image" className="hidden" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void upload(file);
      }} />
      <div className="flex gap-2">
        <button type="button" disabled={uploading} onClick={() => inputRef.current?.click()} className="inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImagePlus className="h-4 w-4" aria-hidden="true" />} Upload image
        </button>
        {appearance.customImage && <button type="button" onClick={() => update({ customImage: "", wallpaper: "summit" })} aria-label="Remove custom wallpaper" title="Remove custom wallpaper" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>}
      </div>
      <label className="block text-xs text-zinc-300">
        <span className="mb-3 flex justify-between gap-3">Wallpaper dimming <span className="tabular-nums text-zinc-500">{appearance.dim}%</span></span>
        <input type="range" min={0} max={75} step={5} value={appearance.dim} disabled={appearance.wallpaper === "none"} onChange={(event) => update({ dim: Number(event.target.value) })} aria-label="Wallpaper dimming" className="w-full accent-emerald-400 disabled:opacity-30" />
      </label>
      <div className="divide-y divide-zinc-800 border-y border-zinc-800">
        <label className="flex min-h-11 items-center justify-between gap-3 text-xs text-zinc-300">Clock <input type="checkbox" checked={appearance.showClock} onChange={(event) => update({ showClock: event.target.checked })} className="h-4 w-4 accent-emerald-400" /></label>
        <label className="flex min-h-11 items-center justify-between gap-3 text-xs text-zinc-300">Quick links <input type="checkbox" checked={appearance.showShortcuts} onChange={(event) => update({ showShortcuts: event.target.checked })} className="h-4 w-4 accent-emerald-400" /></label>
      </div>
      <button type="button" onClick={() => update(DEFAULT_APPEARANCE)} className="inline-flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-200"><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset appearance</button>
    </div>
  );
}