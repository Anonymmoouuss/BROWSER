"use client";

/** Client helpers for the SCRM-style access API (port of SCRM auth/client.ts).
 *
 * Auth state travels BOTH as signed httpOnly cookies and as explicit tokens:
 * this app is regularly embedded in a cross-site preview iframe where the
 * browser blocks third-party cookies entirely, so the cookie alone can
 * never carry the password-step (preauth) or session between requests.
 * Every minting response repeats the raw tokens in the JSON body
 * (preauthToken / sessionToken) plus the signed sessionGrant used for the
 * browser-engine `sjt` query param; they are stored in sessionStorage and
 * replayed in the x-sj-preauth / x-sj-session request headers. */

import {
  clearEngineGrant,
  setEngineGrant,
} from "@/lib/browser/engine-token";

const PREAUTH_KEY = "sj.preauth";
const SESSION_KEY = "sj.session";

function storeGet(key: string): string | null {
  try {
    const value = sessionStorage.getItem(key);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function storeRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const preauth = storeGet(PREAUTH_KEY);
  if (preauth) headers["x-sj-preauth"] = preauth;
  const session = storeGet(SESSION_KEY);
  if (session) headers["x-sj-session"] = session;
  return headers;
}

/** Attachable auth headers for raw fetches to the access APIs (the admin
 *  panel GET uses this — plain fetch would lose the session inside the
 *  cookie-blocked preview iframe). */
export function accessAuthHeaders(): Record<string, string> {
  return authHeaders();
}

/** Apply the tokens minted by a successful response. */
function applyTokens(action: string, body: Record<string, unknown>): void {
  if (action === "logout" || action === "reset") {
    storeRemove(PREAUTH_KEY);
    storeRemove(SESSION_KEY);
    clearEngineGrant();
    return;
  }
  if (typeof body.preauthToken === "string" && /^[a-f0-9]{64}$/.test(body.preauthToken)) {
    storeSet(PREAUTH_KEY, body.preauthToken);
  }
  if (typeof body.sessionToken === "string" && /^[a-f0-9]{64}$/.test(body.sessionToken)) {
    storeRemove(PREAUTH_KEY); // the session supersedes the password step
    storeSet(SESSION_KEY, body.sessionToken);
  }
  if (typeof body.sessionGrant === "string" && body.sessionGrant.length <= 2000) {
    setEngineGrant(body.sessionGrant);
  } else if (body.tokensCleared === true) {
    clearEngineGrant();
  }
  if (body.tokensCleared === true) {
    storeRemove(PREAUTH_KEY);
    storeRemove(SESSION_KEY);
    clearEngineGrant();
  }
}

export async function accessRequest(
  action: string,
  data: Record<string, unknown> = {},
  admin = false,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "The authentication request timed out. Please retry.",
          "TimeoutError",
        ),
      ),
    75_000,
  );
  try {
    let response: Response;
    try {
      response = await fetch(admin ? "/api/admin" : "/api/access", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ action, ...data }),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") throw e;
      throw new Error(
        "Could not reach the login service. Check your connection and retry.",
      );
    }
    const body = (await response
      .json()
      .catch(() => ({
        error:
          response.status === 413
            ? "The camera upload was too large. Reload the page and retry."
            : "The authentication service returned an invalid response. Please retry.",
      }))) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        typeof body.error === "string" ? body.error : "Authentication failed.";
      const err = new Error(message) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }
    applyTokens(action, body);
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export interface AccessSessionInfo {
  initialized: boolean;
  unlocked: boolean;
  role: "user" | "admin" | null;
  name: string | null;
  adminEnrolled: boolean;
}

export async function accessSession(): Promise<AccessSessionInfo> {
  const response = await fetch("/api/access", {
    cache: "no-store",
    credentials: "same-origin",
    headers: authHeaders(),
  }).catch(() => null);
  const body = (await response?.json().catch(() => null)) as
    | Partial<AccessSessionInfo>
    | null;
  if (!response?.ok || !body || typeof body.initialized !== "boolean") {
    throw new Error("The sign-in service is temporarily unavailable. Please retry.");
  }
  return (
    {
      initialized: body?.initialized === true,
      unlocked: body?.unlocked === true,
      role: body?.role ?? null,
      name: body?.name ?? null,
      adminEnrolled: body?.adminEnrolled === true,
    }
  );
}

export const ENROLLMENT_PHOTOS = 20;
/** Login captures a few quick frames — the face checker averages the
 * consistent subset, so one noisy webcam frame can no longer reject you. */
export const LOGIN_PHOTOS = 3;
export const MAX_FRAME_CHARACTERS = 120_000;

/** Destroy the engine (service worker) and reload to the locked gate. */
export async function lockWorkspace(): Promise<void> {
  try {
    await accessRequest("logout");
  } catch {
    /* clearing server state is best-effort here */
  }
  storeRemove(PREAUTH_KEY);
  storeRemove(SESSION_KEY);
  clearEngineGrant();
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration("/");
      if (reg) await reg.unregister();
    }
  } catch {
    /* ignore */
  }
  window.location.reload();
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
