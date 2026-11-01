import { NextRequest, NextResponse } from "next/server";
import { getAccessService } from "@/lib/access/service";
import { ACCESS_COOKIE } from "@/lib/access/crypto";

/**
 * Admin panel endpoint (requires an approved admin session — cookie or
 * x-sj-session header token, see /api/access).
 * GET  -> enrollment requests (with review photos for pending users).
 * POST -> { action: "list" | "payments" | "approve" | "reject" | "revoke" |
 *           "delete" | "confirm-payment", id?, period? }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientAddress(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

/** Raw opaque session token from the x-sj-session header (iframe-safe
 *  fallback for browsers that block third-party cookies). */
function headerSession(req: NextRequest): string | undefined {
  const value = req.headers.get("x-sj-session");
  return value && /^[a-f0-9]{64}$/.test(value.trim()) ? value.trim() : undefined;
}

async function sessionCredential(req: NextRequest): Promise<string | undefined> {
  const service = getAccessService();
  return (
    headerSession(req) ??
    (await service.rawCookie(req.cookies.get(ACCESS_COOKIE)?.value))
  );
}

export async function GET(req: NextRequest) {
  try {
    const service = getAccessService();
    if (!(await service.initialized())) {
      return NextResponse.json(
        { error: "This workspace is not set up yet." },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const result = await service.handle(
      "admin-list",
      {},
      { session: await sessionCredential(req) },
      clientAddress(req),
    );
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "cache-control": "no-store", vary: "Cookie" },
    });
  } catch (error) {
    console.error("[admin] GET failed:", error);
    return NextResponse.json(
      { error: "The admin service hit an unexpected error. Please retry." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
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
    if (!(await service.initialized())) {
      return NextResponse.json(
        { error: "This workspace is not set up yet." },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const result = await service.handle(
      "admin-" + action,
      body ?? {},
      { session: await sessionCredential(req) },
      clientAddress(req),
    );
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "cache-control": "no-store", vary: "Cookie" },
    });
  } catch (error) {
    console.error("[admin] POST failed:", error);
    return NextResponse.json(
      { error: "The admin service hit an unexpected error. Please retry." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
