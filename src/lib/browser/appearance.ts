"use client";

import { useSyncExternalStore } from "react";

export const APPEARANCE_KEY = "cw.appearance.v1";
export const WALLPAPERS = [
  { id: "summit", name: "Summit", image: "/wallpapers/summit.jpg" },
  { id: "ocean", name: "Ocean", image: "/wallpapers/ocean.jpg" },
  { id: "forest", name: "Forest", image: "/wallpapers/forest.jpg" },
  { id: "none", name: "Graphite", image: "" },
] as const;

export interface Appearance {
  wallpaper: typeof WALLPAPERS[number]["id"] | "custom";
  customImage: string;
  dim: number;
  showClock: boolean;
  showShortcuts: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  wallpaper: "summit", customImage: "", dim: 35, showClock: true, showShortcuts: true,
};

let cache: Appearance | null = null;
const listeners = new Set<() => void>();

export function normalizeAppearance(value: unknown): Appearance {
  const stored = value && typeof value === "object" ? value as Partial<Appearance> : {};
  const customImage = typeof stored.customImage === "string" && stored.customImage.length <= 1_500_000 &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(stored.customImage) ? stored.customImage : "";
  const wallpaper = WALLPAPERS.some((item) => item.id === stored.wallpaper) || (stored.wallpaper === "custom" && customImage)
    ? stored.wallpaper! : DEFAULT_APPEARANCE.wallpaper;
  return {
    wallpaper,
    customImage,
    dim: typeof stored.dim === "number" && Number.isFinite(stored.dim) ? Math.round(Math.max(0, Math.min(75, stored.dim))) : DEFAULT_APPEARANCE.dim,
    showClock: typeof stored.showClock === "boolean" ? stored.showClock : DEFAULT_APPEARANCE.showClock,
    showShortcuts: typeof stored.showShortcuts === "boolean" ? stored.showShortcuts : DEFAULT_APPEARANCE.showShortcuts,
  };
}

export function wallpaperImage(appearance: Appearance): string {
  return appearance.wallpaper === "custom" ? appearance.customImage : WALLPAPERS.find((item) => item.id === appearance.wallpaper)?.image ?? "";
}

function read(): Appearance {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  if (cache) return cache;
  try {
    cache = normalizeAppearance(JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "null"));
  } catch {
    cache = DEFAULT_APPEARANCE;
  }
  return cache;
}

export function setAppearance(change: Partial<Appearance>): void {
  const next = normalizeAppearance({ ...read(), ...change });
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
  } catch {
    throw new Error("Appearance could not be saved. Try a smaller image or free browser storage.");
  }
  cache = next;
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== APPEARANCE_KEY && event.key !== null) return;
  cache = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_APPEARANCE);
}