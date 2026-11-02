import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";

/**
 * Crypto primitives for the SCRM-style access layer (ported from
 * devperson8000/SCRM api/_lib/auth-crypto.ts, adapted to our Next.js app).
 */

export const hashSecret = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const newToken = () => randomBytes(32).toString("hex");

export function hashPassword(password: string): string {
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 512)
    throw new Error("Passwords must contain 12-512 bytes.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt$16384$${salt}$${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
}

export function validPasswordHash(hash: string): boolean {
  return /^scrypt\$16384\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(hash);
}

export function verifyPasswordHash(password: string, hash: string): boolean {
  if (
    !validPasswordHash(hash) ||
    typeof password !== "string" ||
    Buffer.byteLength(password) > 512
  )
    return false;
  const parts = hash.split("$");
  return timingSafeEqual(
    scryptSync(password, parts[2], 32, { N: 16384, r: 8, p: 1 }),
    Buffer.from(parts[3], "hex"),
  );
}

/** AES-256-GCM seal of a JSON value, bound to the user id as AAD. */
export function seal(value: unknown, key: Buffer, id: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64url"))
    .join(".");
}

export function unseal<T>(value: string, key: Buffer, id: string): T {
  const [iv, tag, data] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
  ) as T;
}

/* ---------------- signed cookies (engine gate) ---------------- */

export interface AccessCookiePayload {
  v: 1;
  /** raw opaque token (preauth or session) */
  tid: string;
  role: "user" | "admin";
  amr?: "webauthn";
  name?: string;
  exp: number;
}

const b64u = (buf: Buffer) => buf.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** Sign a payload into `v1.<b64url(json)>.<b64url(hmac)>`. */
export function signPayload(
  secret: string,
  payload: AccessCookiePayload,
): string {
  const data = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `v1.${data}.${sig}`;
}

/** Verify a signed cookie value; null when malformed/forged/expired. */
export function verifyPayload(
  secret: string,
  cookie: string | undefined | null,
  now = Date.now(),
): AccessCookiePayload | null {
  try {
    if (!cookie || cookie.length > 2000) return null;
    const parts = cookie.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const expected = createHmac("sha256", secret).update(parts[1]).digest();
    const sig = unb64u(parts[2]);
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected))
      return null;
    const payload = JSON.parse(unb64u(parts[1]).toString("utf8"));
    if (
      payload?.v !== 1 ||
      typeof payload.tid !== "string" ||
      (payload.role !== "user" && payload.role !== "admin") ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= now ||
      payload.exp > now + 1000 * 60 * 60 * 24 * 400
    )
      return null;
    return payload as AccessCookiePayload;
  } catch {
    return null;
  }
}

/** Cookie shared with the proxy mini-services (scramjet :3031, backend :3030). */
export const ACCESS_COOKIE = "sj_access";
export const PREAUTH_COOKIE = "sj_preauth";

/** TTLs (ms) — mirrors SCRM, except the preauth window is widened: users
 * legitimately spend several minutes on the camera screen (permissions,
 * positioning, 20 enrollment photos) before the scan challenge is minted,
 * and a 5-minute password step expiring mid-scan reads as "faces are not
 * remembered" rather than the timeout it is. */
export const TTL = {
  preauth: 600_000,
  challenge: 90_000,
  receipt: 604_800_000,
  adminSession: 1_800_000,
  userSession: 43_200_000,
  recovery: 10 * 365.25 * 24 * 3600_000,
};
