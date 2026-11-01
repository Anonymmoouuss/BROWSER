/**
 * Engine grant — the signed sj_access session value the browser engine
 * services (scramjet :3031, legacy proxy :3030) accept in the `sjt` query
 * parameter.
 *
 * Why: the app is regularly embedded in a cross-site preview iframe where
 * the browser blocks ALL third-party cookies, so the httpOnly sj_access
 * cookie never reaches those services. The gate stores the signed session
 * grant here (sessionStorage — partitioned, but shared by every same-origin
 * script of the app including the service worker) and every engine URL
 * builder appends `&sjt=<grant>` so the request authenticates without
 * cookies. Top-level tabs keep using the cookie; the query token is simply
 * the fallback that always works.
 */

const GRANT_KEY = "sj.grant";

export function setEngineGrant(value: string): void {
  try {
    sessionStorage.setItem(GRANT_KEY, value);
  } catch {
    /* storage unavailable — cookie path still applies */
  }
}

export function engineGrant(): string | null {
  try {
    const value = sessionStorage.getItem(GRANT_KEY);
    return value && value.length <= 2000 ? value : null;
  } catch {
    return null;
  }
}

export function clearEngineGrant(): void {
  try {
    sessionStorage.removeItem(GRANT_KEY);
  } catch {
    /* ignore */
  }
}

/** "&sjt=<grant>" when a grant is held, "" otherwise. */
export function sjtQuery(): string {
  const grant = engineGrant();
  return grant ? `&sjt=${encodeURIComponent(grant)}` : "";
}

/** "?sjt=<grant>" (leading question mark) for URLs without other params. */
export function sjtQueryLead(): string {
  const grant = engineGrant();
  return grant ? `?sjt=${encodeURIComponent(grant)}` : "";
}
