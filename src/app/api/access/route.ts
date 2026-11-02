import { NextRequest, NextResponse } from "next/server";
import { getAccessService } from "@/lib/access/service";
import {
  ACCESS_COOKIE,
  PREAUTH_COOKIE,
  signPayload,
  TTL,
} from "@/lib/access/crypto";

/**
 * SCRM-style access endpoint. POST body: { action, ...payload } with the
 * actions init | password | challenge | login | enroll | setup | recover |
 * status | logout | session | reset. Session state travels in two signed
 * httpOnly cookies: sj_preauth (password step, 5 min) and sj_access
 * (session).
 *
 * The app is regularly embedded in a cross-site preview iframe where the
 * browser blocks ALL third-party cookies — the cookies never reach the
 * server even on same-origin fetches from inside the frame. The auth state
 * therefore ALSO travels explicitly: every response that mints a token
 * repeats it in the JSON body (preauthToken / sessionToken + sessionGrant),
 * the browser app stores it in sessionStorage and sends it back in the
 * x-sj-preauth / x-sj-session request headers. Header tokens take priority
 * over cookies; both paths hit the same DB-backed token records, so
 * revocation and expiry behave identically either way.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 3.3 * 1024 * 1024; // 20 enrollment photos (<=120k chars each)

/** Any unexpected failure must surface as JSON — an HTML 500 page makes the
 * client report "invalid response" with no actionable detail. */
function jsonError(message: string, status = 500) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function clientAddress(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

function isSecure(req: NextRequest): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return req.nextUrl.protocol === "https:";
}

/** Raw opaque token supplied in a request header (64 hex chars). */
function headerToken(req: NextRequest, name: string): string | undefined {
  const value = req.headers.get(name);
  return value && /^[a-f0-9]{64}$/.test(value.trim())
    ? value.trim()
    : undefined;
}

/** Cookie value -> raw opaque token (verifies the HMAC signature). */
async function cookieToken(
  service: ReturnType<typeof getAccessService>,
  value: string | undefined,
): Promise<string | undefined> {
  return service.rawCookie(value);
}

async function credentials(req: NextRequest) {
  const service = getAccessService();
  return {
    preauth:
      headerToken(req, "x-sj-preauth") ??
      (await cookieToken(service, req.cookies.get(PREAUTH_COOKIE)?.value)),
    session:
      headerToken(req, "x-sj-session") ??
      (await cookieToken(service, req.cookies.get(ACCESS_COOKIE)?.value)),
  };
}

export async function GET(req: NextRequest) {
  try {
    const service = getAccessService();
    const initialized = await service.initialized();
    if (!initialized) {
      return NextResponse.json(
        {
          initialized: false,
          unlocked: false,
          role: null,
          name: null,
          adminEnrolled: false,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const creds = await credentials(req);
    const result = await service.handle(
      "session",
      {},
      creds,
      clientAddress(req),
    );
    return NextResponse.json(result.body, {
      headers: { "cache-control": "no-store", vary: "Cookie" },
    });
  } catch (error) {
    console.error("[access] GET session failed:", error);
    return jsonError(
      "The authentication service hit an unexpected error. Please retry.",
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (error) {
    console.error("[access] POST failed:", error);
    return jsonError(
      "The authentication service hit an unexpected error. Please retry.",
    );
  }
}

async function handlePost(req: NextRequest) {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "The camera upload was too large. Reload the page and retry." },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  }
  const body = (await req.json().catch(() => null)) as
    | (Record<string, unknown> & { action?: string })
    | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (!action) {
    return NextResponse.json(
      { error: "Missing action." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const service = getAccessService();
  const result = await service.handle(
    action,
    body ?? {},
    await credentials(req),
    clientAddress(req),
    req.headers.get("origin") ?? req.nextUrl.origin,
    req.headers.get("user-agent") ?? "",
  );

  const secure = isSecure(req);
  const config = (await service.getConfig()) ?? null;
  let preauthCookie: string | null = null;

  if (result.clear) {
    // Wipe every credential the browser might hold (cookie + token store).
    result.body.tokensCleared = true;
  }
  if (result.preauth && result.preauthRole && config) {
    const signed = signPayload(config.secret, {
      v: 1,
      tid: result.preauth,
      role: result.preauthRole,
      exp: Date.now() + TTL.preauth,
    });
    preauthCookie = signed;
    result.body.preauthToken = result.preauth;
    result.body.preauthGrant = signed;
  }
  if (result.session && result.sessionRole && result.sessionTtl && config) {
    const signed = signPayload(config.secret, {
      v: 1,
      tid: result.session,
      role: result.sessionRole,
      name: result.sessionName,
      amr: "webauthn",
      exp: Date.now() + result.sessionTtl,
    });
    result.body.sessionToken = result.session;
    result.body.sessionGrant = signed;
    result.body.sessionTtl = result.sessionTtl;
    result.body.sessionName = result.sessionName ?? null;
  }

  const res = NextResponse.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store", vary: "Cookie" },
  });

  if (result.body.passkeyRequired === true) {
    res.cookies.delete(PREAUTH_COOKIE);
    res.cookies.delete(ACCESS_COOKIE);
  }

  if (result.clear) {
    res.cookies.delete(PREAUTH_COOKIE);
    res.cookies.delete(ACCESS_COOKIE);
  }
  if (preauthCookie) {
    res.cookies.set(PREAUTH_COOKIE, preauthCookie, {
      httpOnly: true,
      sameSite: secure ? "none" : "lax",
      secure,
      path: "/",
      maxAge: TTL.preauth / 1000,
    });
    // a fresh preauth supersedes any session still held
    res.cookies.delete(ACCESS_COOKIE);
  }
  if (result.session && result.sessionRole && result.sessionTtl) {
    const signed = (result.body as { sessionGrant?: string }).sessionGrant;
    if (signed) {
      res.cookies.set(ACCESS_COOKIE, signed, {
        httpOnly: true,
        sameSite: secure ? "none" : "lax",
        secure,
        path: "/",
        maxAge: result.sessionTtl / 1000,
      });
    }
    // a fresh session supersedes any preauth still in flight
    res.cookies.delete(PREAUTH_COOKIE);
  }
  return res;
}
