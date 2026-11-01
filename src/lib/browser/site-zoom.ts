"use client";

/**
 * Per-site zoom memory (Chrome behavior): every host the user zooms is
 * remembered in localStorage and re-applied on any later navigation to that
 * host. 100% is the implicit default and is never stored; Ctrl+0 removes the
 * host entry. A tiny external store keeps about:config in sync live.
 */

import { useSyncExternalStore } from "react";

export const SITE_ZOOM_KEY = "cw.sitezoom.v1";

export type SiteZoomMap = Record<string, number>;

const EMPTY: SiteZoomMap = {};
let cache: SiteZoomMap | null = null;
const listeners = new Set<() => void>();

function read(): SiteZoomMap {
  if (cache) return cache;
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(SITE_ZOOM_KEY);
    const parsed = raw ? (JSON.parse(raw) as SiteZoomMap) : {};
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function write(next: SiteZoomMap): void {
  cache = next;
  try {
    window.localStorage.setItem(SITE_ZOOM_KEY, JSON.stringify(next));
  } catch {
    /* quota — ignore */
  }
  for (const l of listeners) l();
}

/** Remembered zoom for a host, or null when it sits at the default 100%. */
export function getSiteZoom(host: string | null | undefined): number | null {
  if (!host || typeof window === "undefined") return null;
  const z = read()[host];
  return typeof z === "number" && z > 0 && z !== 1 ? z : null;
}

/** Persist a zoom level for a host (zoom === 1 deletes the entry). */
export function setSiteZoom(host: string | null | undefined, zoom: number): void {
  if (!host || typeof window === "undefined") return;
  const next = { ...read() };
  if (zoom === 1) delete next[host];
  else next[host] = zoom;
  write(next);
}

export function removeSiteZoom(host: string): void {
  if (typeof window === "undefined") return;
  if (!(host in read())) return;
  const next = { ...read() };
  delete next[host];
  write(next);
}

export function clearSiteZooms(): void {
  if (typeof window === "undefined") return;
  write({});
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Live snapshot for React consumers (about:config zoom levels list). */
export function useSiteZooms(): SiteZoomMap {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
