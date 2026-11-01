"use client";

/**
 * Scramjet engine integration (client side).
 *
 * The scramjet mini-service (port 3031) serves a bootstrap script at
 * /bootstrap-init.js (reverse-proxied same-origin through next.config.ts
 * rewrites). Loading it defines window.initBootstrap(), which:
 *   1. registers the service worker at /sw.js (scope: /),
 *   2. loads the scramjet core/controller/utils bundles + the libcurl
 *      transport client,
 *   3. connects the wisp transport websocket
 *      (wss://<host>/wisp/?XTransformPort=3031 — routed by the edge gateway),
 *   4. returns a Controller instance.
 *
 * The Controller is app-global (one SW, one transport, one cookie jar);
 * each browser tab gets its own Frame via controller.createFrame(iframe).
 *
 * If any step fails (no SW support, service down, insecure context...) the
 * app falls back to the legacy server-side rewriting proxy on :3030, so
 * browsing keeps working either way.
 */

export interface SjPlugin {
  name: string;
}

export interface SjFrame {
  id: string;
  element: HTMLIFrameElement;
  go(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
}

export interface SjController {
  prefix: string;
  /** live frames created by this controller (registry we splice closed tabs out of) */
  frames: SjFrame[];
  createFrame(element?: HTMLIFrameElement, options?: { plugins?: SjPlugin[] }): SjFrame;
  wait(): Promise<void>;
}

export type EngineState = "booting" | "scramjet" | "legacy";

declare global {
  interface Window {
    initBootstrap?: () => Promise<SjController>;
    $scramjetUtils?: {
      UrlWatcherPlugin: new (onUrlChange: (url: string) => void) => SjPlugin;
      CatchEscapedLinksPlugin: new (toLocation: (url: URL) => string | URL) => SjPlugin;
      HttpCachePlugin?: new (options?: Record<string, unknown>) => SjPlugin;
    };
    LibcurlTransport?: {
      LibcurlClient: new (options: { wisp: string }) => unknown;
    };
    $scramjetController?: {
      Controller: new (options: { serviceworker: ServiceWorker; transport: unknown }) => SjController;
      config: { injectPath: string; wasmPath: string; scramjetPath: string };
    };
  }
}

import { engineGrant } from "@/lib/browser/engine-token";
import { serviceWebSocketUrl } from "@/lib/browser/shared";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load script " + src));
    document.head.appendChild(s);
  });
}

async function initializeExternalEngine(): Promise<SjController> {
  const grant = engineGrant();
  const query = grant ? `?sjt=${encodeURIComponent(grant)}` : "";
  await navigator.serviceWorker.register(`/sw.js${query}`, {
    type: "classic",
    updateViaCache: "none",
  });
  const registration = await navigator.serviceWorker.ready;
  for (const path of [
    "/scram/scramjet.js",
    "/controller/controller.api.js",
    "/scram/scramjet-utils.js",
    "/clients/libcurl-client.js",
  ]) {
    await loadScript(`${path}${query}`);
  }
  const runtime = window.$scramjetController;
  if (!registration.active || !runtime || !window.LibcurlTransport) {
    throw new Error("Scramjet runtime did not initialize.");
  }
  const token = grant ? `&sjt=${encodeURIComponent(grant)}` : "";
  const transport = new window.LibcurlTransport.LibcurlClient({
    wisp: serviceWebSocketUrl(`/wisp/?XTransformPort=3031${token}&x=/`),
  });
  runtime.config.injectPath = `/controller/controller.inject.js${query}`;
  runtime.config.wasmPath = `/scram/scramjet.wasm${query}`;
  runtime.config.scramjetPath = `/scram/scramjet.js${query}`;
  return new runtime.Controller({ serviceworker: registration.active, transport });
}

let controllerPromise: Promise<SjController | null> | null = null;
let bootedController: SjController | null = null;

/** Never hang forever: if the engine cannot fully boot within this window
 *  (service down, SW stuck, wisp tunnel dead...) we fall back to the legacy
 *  rewriting proxy so browsing keeps working. */
const BOOT_TIMEOUT_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Boot (or return the already-booted) scramjet controller.
 * Resolves null when the engine is unavailable — callers should fall back
 * to the legacy proxy engine.
 */
export function getScramjetEngine(): Promise<SjController | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!controllerPromise) {
    controllerPromise = (async () => {
      // The mini-service may still be starting (sandbox reboot races the
      // Next.js server); retry a few times before falling back.
      let lastError: unknown = null;
      const startedAt = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        if (Date.now() - startedAt > 50_000) break; // total budget, not per-attempt
        try {
          const externalBackend = process.env.NEXT_PUBLIC_BACKEND_ORIGIN;
          if (!externalBackend && !window.initBootstrap) {
            // The engine assets require an unlocked session; in the preview
            // iframe third-party cookie blocking strips the sj_access cookie,
            // so the signed session grant travels in the sjt query param.
            const grant = engineGrant();
            await loadScript(
              "/bootstrap-init.js" +
                (grant ? `?sjt=${encodeURIComponent(grant)}` : ""),
            );
          }
          if (!externalBackend && !window.initBootstrap) {
            throw new Error("initBootstrap missing after /bootstrap-init.js load");
          }
          // initBootstrap() resolves once the SW is active + engine bundles
          // are loaded; controller.wait() additionally waits for the SW-side
          // RPC handshake (which needs the wisp transport). A stuck wait()
          // used to hang the whole app on the "Starting the Scramjet proxy
          // engine..." screen — now it times out and falls back.
          const controller = await withTimeout(
            externalBackend ? initializeExternalEngine() : window.initBootstrap!(),
            BOOT_TIMEOUT_MS,
            "scramjet bootstrap",
          );
          await withTimeout(controller.wait(), BOOT_TIMEOUT_MS, "scramjet controller ready");
          bootedController = controller;
          // Feed the service worker the current grant so it can reload the
          // controller after a worker restart (cookies may be blocked).
          const token = engineGrant();
          if (token) {
            try {
              // Prefer the controlling worker; fall back to the active
              // registration worker (the page may have loaded BEFORE the SW
              // registered, leaving navigator.serviceWorker.controller null
              // on first boot).
              const target =
                navigator.serviceWorker.controller ??
                (await navigator.serviceWorker.getRegistration())?.active ??
                null;
              target?.postMessage({
                type: "sj-token",
                token,
              });
            } catch {
              /* best effort */
            }
          }
          // debug handle: window.__sjController.frames shows live frame
          // registrations (used to verify closed tabs deregister cleanly)
          (window as unknown as { __sjController?: SjController }).__sjController = controller;
          return controller;
        } catch (err) {
          lastError = err;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 2500));
        }
      }
      throw lastError ?? new Error("scramjet boot failed");
    })().catch((err) => {
      console.warn("[scramjet] engine unavailable, will use legacy proxy:", err);
      controllerPromise = null; // allow a later retry
      return null;
    });
  }
  return controllerPromise;
}

/**
 * Deregister a frame from the controller's registry when its tab closes
 * (or its FrameView unmounts for any other reason). The controller keeps a
 * plain frames[] array with no public delete API — dead frames would keep
 * their SW fetch routes and transport references alive, so we splice them
 * out ourselves. Safe: a removed frame's iframe is already gone from the
 * DOM, so no further requests can arrive on its prefix.
 */
export function destroyScramjetFrame(frame: SjFrame | null): void {
  if (!frame || !bootedController) return;
  const frames = bootedController.frames;
  const i = frames.indexOf(frame);
  if (i >= 0) frames.splice(i, 1);
}

/**
 * Build the plugin set for a frame. The UrlWatcher reports every navigation
 * (link clicks, redirects, pushState, hash changes) so the omnibox and tab
 * history stay in sync.
 *
 * Note: popups (window.open / target=_blank) intentionally do NOT go through
 * a redirect plugin — any same-origin redirect Location gets rewritten back
 * into the frame prefix by the engine, which would nest the app inside the
 * proxy. Without interception, popups simply load the proxied site in a
 * plain popup window, which works exactly like a real browser's
 * "open in new window".
 */
export function buildFramePlugins(onUrlChange: (url: string) => void): SjPlugin[] {
  const utils = window.$scramjetUtils;
  const plugins: SjPlugin[] = [];
  if (!utils) return plugins;
  plugins.push(new utils.UrlWatcherPlugin(onUrlChange));
  return plugins;
}
